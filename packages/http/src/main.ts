#!/usr/bin/env bun
/**
 * Agent Mesh HTTP API server.
 *
 * Provides a REST API + WebSocket hub integration for multi-agent messaging.
 * All messages are persisted in SQLite (agent-mesh.db) and delivered via
 * the hub WebSocket. SSE events are pushed directly from hub onmessage
 * to connected clients — no filesystem dependency for messaging.
 *
 * Port: 3000 (configurable via AGENT_MESH_HTTP_PORT)
 */

// Optional env file loader. Shared lab services should use systemd EnvironmentFile
// by default; local env file loading is opt-in only.
import { readFileSync as readFs } from 'fs'
import { loadEnvFile } from './env-file'
// Runs here rather than in `env-file.ts` itself: a module that reads the
// filesystem on import cannot be imported by a test that wants to ask it a
// question first.
loadEnvFile(process.env, (path) => readFs(path, 'utf8'))

import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
} from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openStore, teardown, agentsSchema, grants, groups as groupsStore, keys, ownership, verify, type MessageRow } from '@agent-mesh/store'
import { shapeMetrics } from './behaviour-metrics.ts'
import {
  CAPABILITY,
  IDENTITY_RE,
  SIGNATURE_FRESHNESS_WINDOW_SECONDS,
  parseRestAuthorization,
  restSignaturePreimage,
  LEGACY_ADMIN_CAPABILITIES,
  ALL_CAPABILITIES,
  SCOPE_TENANT,
  type Capability,
} from '@agent-mesh/contracts'
import { provisionAllHumans, provisionHuman, provisionSelf, restBase as hubRestBase } from './provision'
import { listPending as listPendingKeys, keyHistory, decide as decideKey, closeAgentsDb, agentsDb } from './keys-admin'
import { putBlob, closeBlobDb } from './audit-blobs'
import { getEvent as getAuditEvent, listEvents as listAuditEvents, closeAuditDb } from './audit-query'
import { recordContentReadOrRefuse, closeAuditAccessLog } from './audit-access-log'
import { markSendFailed } from './send-failure'
import { isPathAllowed } from './file-access'
import * as keyProposals from './key-proposals'
import * as attachmentAccess from './attachment-access'
import { sendPushForMessage } from './push'
import { auditAgents } from './audit-agents'
import { listChatAudits } from './chat-audits'
import { parseSqliteUtc, readBehaviour } from './telemetry-behaviour'
import { runShutdown } from './shutdown'
import { insertMessage, getMessageHistory, getConversation, searchMessages, closeDb, upsertUser, getUser, isAllowedToMessage, createPendingApproval, getPendingApproval, listPendingApprovals, approveUser as dbApproveUser, denyUser as dbDenyUser, getDb, savePushSubscription, getPushSubscriptions, deletePushSubscription, verifyLocalUser, seedLocalUsers, setLocalPassword, mustChangePassword, admitLocalUser, issueTemporaryPassword, listLocalUsers, getLocalUser, listRegistryAgents, getRegistryAgent, listRegistryAgentIds, listApprovedWebUserIds, isRegistryAgentApproved, upsertApprovedWebUser, type DbMessage } from './db'
import webpush from 'web-push'
import { renderAdminPage } from './ui/admin'
import { renderAgentNotFoundPage, renderChatPage, renderPendingApprovalPage } from './ui/chat'
import { renderLandingPage } from './ui/landing'
import { BUILD_VERSION, IS_DEV, THEME } from './ui/theme'
import { getGithubAuthUrl, exchangeCodeForToken, getGithubUser, signJwt, verifyJwt, type JwtPayload } from './auth'
import { randomUUID } from 'node:crypto'

import { startCounterHeartbeat, withFields } from '@agent-mesh/log'
import { log } from './log'

// --- Configuration ---

const STATE_DIR = process.env.AGENT_MESH_STATE_DIR ?? '/srv/agent-mesh-lab/state/shared'
const PORT = parseInt(process.env.AGENT_MESH_HTTP_PORT ?? '3000', 10)
const startTime = Date.now()
// Mesh identity pinged when a new user needs approval. Deployment-specific.
const ADMIN_NOTIFY_IDENTITY = process.env.AGENT_MESH_ADMIN_NOTIFY_IDENTITY?.trim() || null

// --- Hub DB (read-only audit access) ---
//
// The hub owns this file and its schema (SPEC § 3.1); this side only reads.
// The row shape comes from @agent-mesh/store rather than being restated here,
// which is what used to let the two drift apart silently.
let _hubDb: Database | null = null
function getHubDb(): Database {
  if (_hubDb) return _hubDb
  _hubDb = openStore('hub', { readonly: true })
  return _hubDb
}

// --- Hub WebSocket Client ---

const HUB_URL =
  process.env.AGENT_MESH_HUB_URL ??
  process.env.HUB_URL ??
  'ws://127.0.0.1:3100/ws'
/**
 * The same hub, over http — derived rather than configured separately.
 *
 * A second environment variable is a second thing to get wrong, and the two
 * pointing at different hubs would be invisible: the routes would work and
 * report another deployment's configuration.
 */
const HUB_HTTP_URL = HUB_URL.replace(/^ws/, 'http').replace(/\/ws$/, '')
/** § 11.3. Long enough to walk to another machine, short enough that a
 *  shoulder-surfed code is worth little. Not derived — argued from neither
 *  number, and configurable for the same reason the dormancy window is. */
const PAIRING_TTL_SECONDS = parseInt(process.env.AGENT_MESH_PAIRING_TTL ?? '300', 10)
const PAIRING_TTL_MAX_SECONDS = 3600
const HUB_IDENTITY = 'http-server' + (IS_DEV ? '-dev' : '')
let hubWs: WebSocket | null = null
let hubConnected = false

/**
 * Dial the hub.
 *
 * **Exported as a test seam**, in the shape `sseClientCount` beside it and the
 * nonce window in `hub/src/signature.ts`. Nothing else calls it — the served
 * process crosses `import.meta.main` below — and the whole of what it does
 * happens inside two socket callbacks, so a test that cannot invoke it cannot
 * reach any of it.
 *
 * What is worth reaching: the registration order on `onopen`. § 8.2 checks both
 * halves of a proxy claim against stored rows rather than against what the
 * socket says, so this identity must exist and carry `can_proxy`, and each
 * person must exist as type `human`, *before* `mesh.connect` names them —
 * otherwise the hub drops the claims and every message sent on their behalf is
 * refused. Done on connect rather than at startup because the hub is provably
 * reachable at this instant.
 */
export function connectToHub(): void {
  try {
    hubWs = new WebSocket(HUB_URL)
    hubWs.onopen = async () => {
      hubConnected = true
      log.info(`connected to the hub at ${HUB_URL}`, 'hub_connected', { url: HUB_URL })

      // Registration before mesh.connect, and in this order, because § 8.2 now
      // checks both halves against stored rows rather than against what the
      // socket claims. This identity must exist and carry `can_proxy`, and each
      // person must exist as type `human`, or the hub drops the proxy claims
      // and every message sent on their behalf is refused.
      //
      // Done on connect rather than at startup because the hub is provably
      // reachable at this instant, and a reconnect is exactly when a retry is
      // wanted for anything missed while it was down.
      const self = await provisionSelf(HUB_IDENTITY)
      if (!self.ok) {
        log.warn('could not register this service\'s own identity with the hub', 'self_provision_failed', {
          actor: HUB_IDENTITY,
          outcome: 'failed',
          reason: 'hub_refused',
          detail: self.reason,
        })
      }
      const webUsers = listApprovedWebUserIds()
      await provisionAllHumans(webUsers)

      hubWs!.send(JSON.stringify({
        jsonrpc: '2.0', method: 'mesh.connect',
        params: { identity: HUB_IDENTITY, description: 'Agent Mesh Web UI', proxy_for: webUsers },
        id: 1,
      }))
      if (webUsers.length > 0) {
        log.info(`proxying for ${webUsers.length} web user(s)`, 'proxies_declared', {
          count: webUsers.length,
          identities: webUsers,
        })
      }
    }
    hubWs.onmessage = (e) => {
      // Named outside the `try` so the `catch` can say *which* frame, not only
      // that one failed. A log line an operator cannot tie to a message is a
      // log line that only says the count went up.
      let frameId: unknown
      let frameFrom: unknown
      try {
        const raw = typeof e.data === 'string' ? e.data : String(e.data)
        const data = JSON.parse(raw)
        frameId = data?.params?.id
        frameFrom = data?.params?.from
        if (data.method === 'mesh.message' && data.params) {
          const msg = data.params
          // 1. Write to SQLite
          insertMessage({ id: msg.id, from: msg.from, to: msg.to, content: msg.content, reply_to: msg.reply_to, status: 'delivered', ts: msg.ts })
          // 2. Push to SSE clients (agent→user direction)
          const sseMsg = { id: msg.id, from: msg.from, to: msg.to, ts: msg.ts, content: msg.content, reply_to: msg.reply_to ?? null, status: 'delivered' }
          pushToSSE(msg.from, msg.to, 'message', sseMsg)
          // Also push to user→agent direction (sent confirmation)
          pushToSSE(msg.to, msg.from, 'message', sseMsg)
          // 2b. Broadcast to admin Chat Audits SSE subscribers
          broadcastAuditMessage({
            id: msg.id,
            from_agent: msg.from,
            to_agent: msg.to,
            // **`?? ''` cannot fire, and it is kept because this is a process
            // boundary.** The hub refuses `mesh.send` without a body
            // (`params.content is required`, hub/rpc/send.ts) and stamps
            // `content: String(content)` into every `mesh.message` it emits, so
            // no frame reaching here can be missing it. Written down because
            // the guarantee lives in another process's source rather than in a
            // type: a reader finding the fallback unreachable and deleting it
            // would be removing the only thing standing between an older hub
            // and an audit row that reads *empty body* where the truth is *no
            // body* — and in an audit trail those are opposite facts.
            content: msg.content ?? '',
            reply_to: msg.reply_to ?? null,
            status: 'delivered',
            ts: msg.ts,
          })
          // 3. Send push notification
          sendPushNotificationForMessage(msg.to, msg.from, msg.content)
          log.info(`hub→sse: ${msg.from} → ${msg.to}`, 'hub_frame_forwarded', {
            id: msg.id,
            actor: msg.from,
            to: msg.to,
          })
        }
        if (data.method === 'mesh.delivered' && data.params) {
          const d = data.params
          log.info(`mesh.delivered: ${d.from} → ${d.to}`, 'delivery_receipt', {
            id: d.id,
            actor: d.from,
            to: d.to,
            outcome: 'delivered',
          })
          // Notify sender's SSE that message was delivered (show typing indicator)
          pushToSSE(d.to, d.from, 'delivered', { id: d.id, to: d.to, ts: d.ts })
        }
      } catch (err) {
        // **A frame this service cannot handle used to vanish here** (D-737).
        //
        // `insertMessage` throws on a `mesh.message` carrying no `content` —
        // what an older hub sends — and this swallowed it: no row, no SSE push,
        // no audit event, no line anywhere. The hub had recorded a delivery and
        // this side had nothing, and nobody was told. Measured, not imagined:
        // it is what `hub-link.test.ts` found when the socket handler was first
        // driven.
        //
        // Logging is not the repair — the frame is still dropped — it is the
        // difference between a mesh that loses a message and a mesh that loses
        // one silently. What to do with the frame itself is a separate
        // question about this service's contract with the hub.
        const reason = err instanceof Error ? err.message : String(err)
        log.error('dropped a hub frame', 'frame_dropped', {
          id: String(frameId ?? 'unknown'),
          actor: String(frameFrom ?? 'unknown'),
          outcome: 'dropped',
          reason: 'threw',
          error: reason,
        })
      }
    }
    hubWs.onclose = () => {
      hubConnected = false
      setTimeout(connectToHub, 5000)
    }
    hubWs.onerror = () => { hubConnected = false }
  } catch {
    hubConnected = false
    setTimeout(connectToHub, 5000)
  }
}

function sendViaHub(to: string, content: string, from: string, replyTo?: string): Promise<string | null> {
  if (!hubConnected || !hubWs) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reqId = Date.now()
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
        if (data.id === reqId) {
          hubWs!.removeEventListener('message', handler)
          resolve(data.result?.id ?? null)
        }
      } catch {}
    }
    hubWs!.addEventListener('message', handler)
    hubWs!.send(JSON.stringify({
      jsonrpc: '2.0', method: 'mesh.send',
      params: { to, content, from, ...(replyTo ? { reply_to: replyTo } : {}) },
      id: reqId,
    }))
    setTimeout(() => { hubWs!.removeEventListener('message', handler); resolve(null) }, 5000)
  })
}

/**
 * Re-declare `proxy_for` on the live socket.
 *
 * The list is fixed at connect (§ 8.1), so a person approved afterwards could
 * not be spoken for until the http server happened to reconnect — every message
 * they sent was refused by entitlement until then. `mesh.connect` on a socket
 * that already owns the identity is accepted rather than treated as a duplicate,
 * so re-declaring is the whole fix.
 */
export async function redeclareProxies(): Promise<void> {
  if (!hubConnected || !hubWs) return
  const webUsers = listApprovedWebUserIds()
  await provisionAllHumans(webUsers)
  hubWs.send(JSON.stringify({
    jsonrpc: '2.0', method: 'mesh.connect',
    params: { identity: HUB_IDENTITY, description: 'Agent Mesh Web UI', proxy_for: webUsers },
    id: Date.now(),
  }))
}

// **Dialling the hub is startup, not module loading.** On import this opened a
// socket and re-dialled every 5 s forever, so a test that only wanted to call a
// route held a reconnect loop against whatever hub happened to be running.
// `import.meta.main` is the same line the served process crosses below.
if (import.meta.main) connectToHub()

// --- In-memory SSE pub/sub ---
// Key: "agentId:userLogin", Value: Set of SSE controllers
const sseClients = new Map<string, Set<ReadableStreamDefaultController>>()

function sseKey(agentId: string, userLogin: string): string {
  return `${agentId}:${userLogin}`
}

function addSSEClient(agentId: string, userLogin: string, controller: ReadableStreamDefaultController): void {
  const key = sseKey(agentId, userLogin)
  if (!sseClients.has(key)) sseClients.set(key, new Set())
  sseClients.get(key)!.add(controller)
}

function removeSSEClient(agentId: string, userLogin: string, controller: ReadableStreamDefaultController): void {
  const key = sseKey(agentId, userLogin)
  const set = sseClients.get(key)
  if (set) {
    set.delete(controller)
    if (set.size === 0) sseClients.delete(key)
  }
}

/**
 * How many live event-stream clients this process believes it has.
 *
 * **A test seam, in the shape `hub/src/signature.ts` already uses for its nonce
 * window.** The registry is module-private and nothing else can see it, so a
 * client that is registered on connect and never unregistered on departure
 * fails at no particular moment: the map grows for the life of the process and
 * every push writes to controllers whose sockets are gone.
 *
 * Exported because the alternative was a test asserting that an
 * `AbortController` it had just aborted was aborted — which is true whatever
 * the handler does, and a registered mutation removing the unregister survived
 * it. A property nothing can observe is a property nothing can hold.
 */
export function sseClientCount(): number {
  let n = 0
  for (const set of sseClients.values()) n += set.size
  return n
}

function pushToSSE(agentId: string, userLogin: string, event: string, data: unknown): void {
  const key = sseKey(agentId, userLogin)
  const set = sseClients.get(key)
  if (!set || set.size === 0) return
  const encoder = new TextEncoder()
  const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  for (const controller of set) {
    try { controller.enqueue(payload) } catch { set.delete(controller) }
  }
}

/**
 * Whether this person has a conversation open right now.
 *
 * It decides whether a notification is sent, and *not sending* is the branch
 * that matters: a lock-screen alert beside a message already on their screen
 * is the same message twice. It could not be reached in this process, because
 * the only caller returns before it unless the deployment holds VAPID keys —
 * and setting those for a test sets them for every other file in it.
 *
 * The map is a parameter with the module's own as the default, which is the
 * seam used everywhere else here (`closeDatabases(stores)`,
 * `requireJwtSecret(secret, refuse)`). Production calls it with one argument
 * and nothing about it moved.
 *
 * **The key is `agent:person`, so the match is on the suffix.** One person
 * watching one conversation must count as watching, and the same person is a
 * different key for every agent they have open — which is why this scans
 * rather than looks up, and why a person named as a suffix of another
 * (`kim` inside `joakim`) would match if the colon were not part of it.
 */
export function hasActiveSSE(
  toUser: string,
  clients: Map<string, Set<ReadableStreamDefaultController>> = sseClients,
): boolean {
  for (const [key, set] of clients) {
    if (key.endsWith(`:${toUser}`) && set.size > 0) return true
  }
  return false
}

// --- Admin Chat Audits SSE pub/sub ---
// Separate pool from per-user chat SSE. Each client carries its filter set.
type AuditSseClient = {
  controller: ReadableStreamDefaultController
  filters: { from_agent: string | null; to_agent: string | null; search: string | null }
}
const auditSseClients = new Set<AuditSseClient>()

/**
 * Keep a stream open through a proxy that would close it for being idle, and
 * stop the moment the stream is gone.
 *
 * Written three times -- 30s on the chat stream, 30s on the audit stream, 20s
 * on ai-usage -- with the same rule each time: write, and if the write throws,
 * clear the timer. Three copies of one rule is three places for it to drift,
 * and none of the three had ever run under an instrument, because reaching the
 * body means waiting twenty seconds.
 *
 * The write throwing is the *normal* ending here, not an error: it is how a
 * closed stream announces itself to a timer nobody has cancelled yet. Silence
 * is right, and the timer clearing itself is the whole behaviour.
 */
export function startStreamKeepalive(
  write: () => void,
  everyMs: number,
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval,
  clearTimer: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): () => void {
  const timer = setTimer(() => {
    try {
      write()
    } catch {
      clearTimer(timer)
    }
  }, everyMs)
  return () => clearTimer(timer)
}

/**
 * Past this many attached clients, somebody should know.
 *
 * Not a limit — nothing is refused. A console holds one stream open per open
 * tab, so a number this size is either a lot of operators or a client that
 * reconnects without closing, and the second is the one worth catching before
 * it is a memory question.
 */
const SSE_CLIENT_WATERMARK = 50

/**
 * Say so when a stream is carrying more clients than anybody expected.
 *
 * Taking the count as an argument rather than reading the set is what makes
 * the *decision* testable: standing up fifty-one live SSE connections to reach
 * one `if` is a suite nobody runs, and the set membership was never the part
 * that could be wrong.
 */
export function noteStreamClients(stream: 'chat-audits' | 'ai-usage', clients: number): void {
  if (clients <= SSE_CLIENT_WATERMARK) return
  log.warn(`the ${stream} stream has ${clients} clients attached`, 'sse_clients_high', {
    stream,
    clients,
    reason: 'above_watermark',
  })
}

function addAuditSseClient(c: AuditSseClient): void {
  auditSseClients.add(c)
  noteStreamClients('chat-audits', auditSseClients.size)
}

function removeAuditSseClient(c: AuditSseClient): void {
  auditSseClients.delete(c)
}

function auditMatchesFilters(
  msg: { from_agent: string; to_agent: string; content: string },
  f: AuditSseClient['filters'],
): boolean {
  if (f.from_agent && msg.from_agent !== f.from_agent) return false
  if (f.to_agent && msg.to_agent !== f.to_agent) return false
  if (f.search && !msg.content.toLowerCase().includes(f.search.toLowerCase())) return false
  return true
}

// Dedup guard — hub.onmessage 경로와 audit poller 양쪽에서 같은 msg.id가
// 유입될 수 있으므로 최근 200개 id를 LRU로 기억하고 중복 broadcast 차단.
const recentSentIds = new Set<string>()
const recentSentQueue: string[] = []
const RECENT_SENT_MAX = 200

function broadcastAuditMessage(msg: {
  id: string
  from_agent: string
  to_agent: string
  content: string
  reply_to: string | null
  status: string | null
  ts: string
}): void {
  if (recentSentIds.has(msg.id)) return
  recentSentIds.add(msg.id)
  recentSentQueue.push(msg.id)
  if (recentSentQueue.length > RECENT_SENT_MAX) {
    const old = recentSentQueue.shift()
    if (old) recentSentIds.delete(old)
  }
  if (auditSseClients.size === 0) return
  const encoder = new TextEncoder()
  // Include `id:` field so EventSource auto-tracks Last-Event-ID for gap fetch on reconnect.
  const sseId = sseSafeId(msg.id)
  const payload = encoder.encode(`id: ${sseId}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`)
  for (const client of auditSseClients) {
    if (!auditMatchesFilters(msg, client.filters)) continue
    try { client.controller.enqueue(payload) } catch { auditSseClients.delete(client) }
  }
}

// SSE `id:` field must be a single line (no CR/LF/NUL). msg.id is a UUID-like
// string in practice but sanitize defensively.
function sseSafeId(id: string): string {
  return String(id).replace(/[\r\n\0]/g, '')
}

// --- Audit poller ---
// hub WebSocket 구독은 sir-mirr 전용 proxy 채널이므로 다른 agent 간 대화를
// 놓친다. hub.db messages 테이블을 1.5s 폴링해서 모든 대화를 캡처.
let lastSeenMessageTs: string | null = null
let lastSeenMessageId: string | null = null
let auditPollerInterval: Timer | null = null

// Shape of hub.db:messages. Declared by @agent-mesh/store, not restated here.
type MsgRow = MessageRow

/**
 * Where the poller starts reading, and what it says about it.
 *
 * Split out of the `setInterval` below for the reason every other seam in this
 * repository was: the body of a timer callback is reachable only by waiting,
 * and a suite that waits 1.5 seconds per assertion is one nobody runs. Both
 * halves are ordinary functions that a test calls directly — the failure
 * branches especially, which need a store that will not answer and are
 * otherwise unreachable in this process.
 */
export function auditPollerStartingPoint(): void {
  try {
    const db = getHubDb()
    const row = db.prepare(`SELECT id, ts FROM messages ORDER BY ts DESC, id DESC LIMIT 1`).get() as { id: string; ts: string } | null
    if (row) {
      lastSeenMessageTs = row.ts
      lastSeenMessageId = row.id
    } else {
      lastSeenMessageTs = '1970-01-01 00:00:00'
      lastSeenMessageId = ''
    }
    log.info('the audit poller has its starting point', 'audit_poller_started', {
      id: lastSeenMessageId,
      last_ts: lastSeenMessageTs,
    })
  } catch (err) {
    log.error('the audit poller could not read a starting point, so it starts from the beginning', 'audit_poller_init_failed', {
      outcome: 'restarted_from_epoch',
      reason: 'store_unreadable',
      error: err instanceof Error ? err.message : String(err),
    })
    lastSeenMessageTs = '1970-01-01 00:00:00'
    lastSeenMessageId = ''
  }
}

/** One pass. Returns how many rows it handed to the audit stream. */
export function auditPollerPass(): number {
  try {
    const db = getHubDb()
    const rows = db.prepare(`
      SELECT id, from_agent, to_agent, content, reply_to, status, ts
        FROM messages
       WHERE (ts > $ts) OR (ts = $ts AND id > $id)
       ORDER BY ts ASC, id ASC
       LIMIT 200
    `).all({ $ts: lastSeenMessageTs, $id: lastSeenMessageId }) as MsgRow[]
    if (rows.length === 0) return 0
    log.info(`the audit poller picked ${rows.length} new row(s)`, 'audit_poller_rows', {
      count: rows.length,
    })
    for (const r of rows) {
      broadcastAuditMessage({
        id: r.id,
        from_agent: r.from_agent,
        to_agent: r.to_agent,
        content: r.content ?? '',
        reply_to: r.reply_to ?? null,
        status: r.status ?? null,
        ts: r.ts,
      })
      lastSeenMessageTs = r.ts
      lastSeenMessageId = r.id
    }
    return rows.length
  } catch (err) {
    log.error('the audit poller failed a pass, and will try again', 'audit_poller_failed', {
      outcome: 'retrying',
      reason: 'store_unreadable',
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

function startAuditPoller(): void {
  if (auditPollerInterval) return
  auditPollerStartingPoint()
  auditPollerInterval = setInterval(auditPollerPass, 1500)
}

/**
 * Stop it. Exported because a test that drives `auditPollerPass` itself has to
 * be the only caller — a timer running underneath would race it for the same
 * rows and take the anchor with it.
 */
export function stopAuditPoller(): void {
  if (!auditPollerInterval) return
  clearInterval(auditPollerInterval)
  auditPollerInterval = null
}

// --- AI Usage (task #79) ---
// 맥허브 ai-usage-monitor가 5분 주기로 snapshot을 POST → ARM이 최종값 1개만
// 보관 + SSE broadcast. persistence 불필요 (재기동 시 null 시작, 다음 cycle에서 채워짐).

interface AiUsageWindowLevel {
  ratio: number
  level: string
  resets_at: string
  minimal_mode_active?: boolean
}

interface AiUsageAccount {
  account_id: string
  provider: string
  plan_hint?: string
  five_hour?: AiUsageWindowLevel
  weekly?: AiUsageWindowLevel
  last_success_at?: string
  consecutive_failures?: number
  api_error?: string | null
}

interface AiUsageSnapshot {
  ts: string
  schema_version: string
  source: string
  accounts: AiUsageAccount[]
  last_updated_at: string
}

let latestAiUsageSnapshot: AiUsageSnapshot | null = null

const aiUsageSseClients = new Set<ReadableStreamDefaultController>()

function addAiUsageSseClient(c: ReadableStreamDefaultController): void {
  aiUsageSseClients.add(c)
  noteStreamClients('ai-usage', aiUsageSseClients.size)
}

function removeAiUsageSseClient(c: ReadableStreamDefaultController): void {
  aiUsageSseClients.delete(c)
}

/**
 * How many AI-usage stream subscribers this process believes it has.
 *
 * **The same seam as `sseClientCount` below, for the same reason.** The set is
 * module-private, so a subscriber registered on connect and never unregistered
 * on departure fails at no particular moment: the set grows for the life of the
 * process, and every push writes to a controller whose socket is gone.
 *
 * It measures the departure a test can cause — a cancelled stream, which runs
 * the source's `cancel`. The other one it cannot: `broadcastAiUsage` also drops
 * a controller whose `enqueue` throws, and in-process there is no way to make a
 * registered controller throw without cancelling it first, which removes it by
 * the other path. That branch is defence in depth behind a path that is
 * measured, and it is named here rather than left looking covered.
 */
export function aiUsageSseClientCount(): number {
  return aiUsageSseClients.size
}

function broadcastAiUsage(snapshot: AiUsageSnapshot): void {
  if (aiUsageSseClients.size === 0) return
  const encoder = new TextEncoder()
  const payload = encoder.encode(`event: ai-usage-update\ndata: ${JSON.stringify(snapshot)}\n\n`)
  for (const controller of aiUsageSseClients) {
    try { controller.enqueue(payload) } catch { aiUsageSseClients.delete(controller) }
  }
}

/**
 * Notify someone's devices, with this deployment's wiring.
 *
 * The loop itself lives in `push.ts`, beside the rule about which failures
 * cost a subscription — for the same reason that rule was split out in the
 * first place. What stays here is the wiring: this deployment's keys, its
 * subscription table, and `webpush`'s idea of what a subscription looks like.
 */
function sendPushNotificationForMessage(toUser: string, fromAgent: string, content: string): void {
  sendPushForMessage(
    {
      configured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      watching: hasActiveSSE,
      devices: getPushSubscriptions,
      send: (target, payload) =>
        webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          payload,
        ),
      drop: deletePushSubscription,
    },
    toUser,
    fromAgent,
    content,
  )
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:sir_mirr@naver.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}


// Dev environment uses lighter colors for visual distinction

// Ensure state directory exists
mkdirSync(STATE_DIR, { recursive: true })

// --- Approval helpers ---

function isUserApproved(githubLogin: string, role: string): boolean {
  // Admin is always approved
  if (role === 'admin') return true

  // Check registry
  if (isRegistryAgentApproved(githubLogin)) return true

  // Check pending_approvals table
  const pending = getPendingApproval(githubLogin)
  if (pending && pending.status === 'approved') return true

  return false
}

/**
 * Tell somebody a person is waiting to be let in.
 *
 * The identity and the sender are parameters with the module's own as
 * defaults, for the reason the rest of this file uses that seam: both are read
 * at module load, so the branches below were decided before any test could
 * exist and could not be reached from inside this process at all.
 *
 * **Opening it found the failure this could not report.** The old body was
 * `sendViaHub(...).catch(...)`, and `sendViaHub` does not reject — when the
 * hub socket is down it resolves `null`, which is the *likeliest* way this
 * fails and the one that said nothing. An approval nobody was told about
 * looked exactly like one that was, and the person waits until an operator
 * happens to open `/api/v1/admin/pending`.
 */
export function notifyApprovalRequest(
  githubLogin: string,
  _githubId: number,
  notifyIdentity: string | null = ADMIN_NOTIFY_IDENTITY,
  send: (to: string, content: string, from: string) => Promise<string | null> = sendViaHub,
): void {
  // Deployment-specific. Unset means approvals wait in /api/v1/admin/pending
  // without an out-of-band ping.
  if (!notifyIdentity) {
    log.warn(`${githubLogin} is waiting for approval and nobody was told`, 'admin_notify_skipped', {
      actor: githubLogin,
      outcome: 'skipped',
      reason: 'notify_identity_unset',
    })
    return
  }
  const msg = `새 사용자 승인 요청: ${githubLogin} (GitHub). /api/v1/admin/pending에서 확인하세요.`
  const failed = (reason: string) =>
    log.error(`could not tell an admin that ${githubLogin} is waiting for approval`, 'admin_notify_failed', {
      actor: githubLogin,
      to: notifyIdentity,
      outcome: 'failed',
      reason,
    })

  void send(notifyIdentity, msg, 'system')
    .then((id) => {
      if (id) return
      // No id is no message: the socket was down, or the hub answered without
      // one. Either way nobody was told, which is the whole subject of this
      // function.
      failed('hub_did_not_accept')
    })
    .catch(() => failed('hub_send_threw'))
}

type Message = {
  id: string
  from: string
  to: string
  ts: string
  content: string
  reply_to?: string
  file_path?: string
  /**
   * `failed` means the hub never accepted it — an unentitled sender, a
   * torn-down recipient. Distinct from `pending`, which means the hub holds it
   * for a recipient who is offline. The two used to look identical in the UI
   * because the send path swallowed the refusal.
   */
  status: 'pending' | 'delivered' | 'read' | 'failed'
}

// --- Hono App ---

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `===` on strings returns at the first differing byte, so the time it takes
 * is a function of how much of the prefix was right. That is enough to
 * recover a token a byte at a time given enough attempts — which § 14's rate
 * limit makes slow rather than impossible.
 *
 * Both sides are hashed first so the comparison is over equal-length buffers:
 * `timingSafeEqual` throws on a length mismatch, and catching that would
 * reintroduce the leak as an exception nobody times.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/**
 * The routes, exported so a test can call them without a port.
 *
 * `app.fetch(new Request(...))` runs the same handler stack the served process
 * runs, in the test's own process, where it can be counted.
 */
export const app = new Hono()

/**
 * Origins allowed to call this server from a browser (open question 7).
 *
 * `cors()` with no argument allowed every origin, and this server
 * authenticates with a **cookie**. A page on any site could therefore make an
 * authenticated request on a visitor's behalf and read the answer — the
 * session is attached by the browser, not by the page, so the page never needs
 * the token.
 *
 * Same-origin is always allowed and needs nothing here; a request with no
 * `Origin` header is not a browser and is unaffected. This list is for the
 * cross-origin case, and empty means "none", which is the right default for a
 * server that hands out sessions.
 */
const ALLOWED_ORIGINS = (process.env.AGENT_MESH_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(
  '/*',
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    // Echoed only for an origin on the list. Without this a browser will not
    // send the session cookie at all, which is the behaviour wanted for
    // everyone not on it.
    credentials: true,
  }),
)

/**
 * Correlation, one header wide (T-022 § 5, D-741).
 *
 * A message has an id both sides already know, so a complaint about one is
 * answerable from the bundle and the server log without anything new. Every
 * other operation had nothing: a person says "I could not sign in at about
 * ten past", and pairing that against a log meant guessing from a clock, an
 * endpoint and a name — three approximations, and the clocks are not the same
 * clock.
 *
 * So the client's id is taken if it sent one and made here if it did not, it
 * reaches every line the request writes through `withFields`, and it is echoed
 * back so the client can record it beside its own account of what happened.
 * Pairing by time and endpoint stays available for a caller that sends
 * nothing; it is the fallback rather than the convention.
 *
 * **Bounded before it is believed.** The value keys nothing and is not counted,
 * but it is written into a record an operator reads, so a caller does not get
 * to put a kilobyte or a newline in it. Anything that is not a short token is
 * replaced rather than refused — the request is not the problem, and refusing
 * it would make an unfamiliar client's requests fail for a field that exists
 * to help somebody read a log.
 */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

app.use('*', async (c, next) => {
  const offered = c.req.header('x-request-id') ?? ''
  const requestId = REQUEST_ID.test(offered) ? offered : randomUUID()
  c.header('x-request-id', requestId)
  await withFields({ request_id: requestId }, () => next())
})

// --- Landing Page ---

app.get('/', (c) => {
  return c.html(renderLandingPage(c.req.query('error')))
})
// --- Chat Page ---


app.get('/chat/:agentId', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.redirect('/')
  }

  const user = getUser(payload.github_id)
  if (!user) {
    return c.redirect('/')
  }

  const approved = isUserApproved(user.github_login, user.role)
  if (!approved) {
    return c.html(renderPendingApprovalPage(user))
  }

  const agentId = c.req.param('agentId')

  // Validate agent exists in registry
  if (!getRegistryAgent(agentId)) {
    return c.html(renderAgentNotFoundPage(), 404)
  }

  return c.html(renderChatPage(user, agentId))
})

app.get('/chat', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.redirect('/')
  }

  const user = getUser(payload.github_id)
  if (!user) {
    return c.redirect('/')
  }

  const approved = isUserApproved(user.github_login, user.role)
  if (!approved) {
    return c.html(renderPendingApprovalPage(user))
  }

  return c.html(renderChatPage(user))
})

// --- Auth endpoints ---

app.get('/auth/github', (c) => {
  return c.redirect(getGithubAuthUrl())
})

/**
 * Local sign-in, answering in whichever shape the caller asked for.
 *
 * **A redirect is an answer only a browser form can read.** This route was
 * written for the server-rendered page, where `302` to `/chat` with the cookie
 * on the response is exactly right. A single-page app calling `fetch` gets a
 * redirect it must be told not to follow, a body it cannot parse, and no way to
 * tell "wrong password" from "missing field" — both are `302` to a query string
 * meant for a page that renders it.
 *
 * So the shape follows `Accept`. A caller asking for JSON is told what happened
 * and given a status it can branch on; everything else keeps the redirect it has
 * always had. Content negotiation rather than a second route, because two routes
 * signing two JWTs is two places for the session rules to drift.
 *
 * **The cookie is set either way.** It is `HttpOnly`-less by existing choice and
 * `SameSite=Lax`, and a SPA on the same origin can simply send it — which is
 * the path with the fewest places to leak a token. The JSON body deliberately
 * does not repeat the token: a caller that has the cookie does not need it, and
 * a caller that keeps it somewhere else has made it a thing to steal.
 */
/**
 * `Secure` when the request arrived over TLS, and not otherwise.
 *
 * A cookie without it is sent over plain http too, so a session issued behind
 * https can still leave on a request that is not — which is the whole of what
 * `Secure` prevents. Unconditional would be worse than absent here: the
 * quickstart and every test speak http to `127.0.0.1`, and a browser drops a
 * `Secure` cookie on those, so nobody could log in and the reason would be
 * invisible.
 *
 * `X-Forwarded-Proto` because the deployment terminates TLS in front — the
 * process itself always sees http. Trusted for the same reason § 8.11's
 * `forwarded` values are: the proxy is the deployment's own, and a header from
 * further out cannot reach here without passing through it.
 *
 * **No `HttpOnly`.** This server renders `/chat` and `/admin` itself, and their
 * scripts read the token out of `document.cookie` — `ui/chat.ts:111`, `:699`,
 * `ui/admin.ts:806` — and clear it there to log out. Adding the attribute
 * would take the token away from those pages and they would fail silently, not
 * loudly. Removing that dependency is a separate change to those two surfaces,
 * not a line here.
 */
function sessionCookie(c: Context, jwt: string, maxAge: number): string {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')
  const secure = proto === 'https' ? '; Secure' : ''
  return `mesh_token=${jwt}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`
}

/**
 * A refused sign-in, said once (T-022 § 3).
 *
 * This route wrote nothing on any of its three refusals, so "I could not sign
 * in" was answerable only by asking the person to try again while somebody
 * watched. The three are different repairs — a client sending the wrong shape,
 * a wrong password, and an account that must change its password before
 * anything else — and from outside they are one sentence.
 *
 * **The name goes in a field and never in the sentence.** Everything here
 * arrives from an unauthenticated request: `JSON.stringify` escapes a newline
 * inside the payload, and the head of the line is built by us, so a name
 * interpolated into the sentence is how a caller writes its own log line.
 * Truncated as well, because a field nobody bounds is a line length somebody
 * else chooses.
 */
function refusedSignIn(username: unknown, reason: string): void {
  log.warn('refused a sign-in', 'sign_in_refused', {
    actor: typeof username === 'string' ? username.slice(0, 128) : '<absent>',
    outcome: 'refused',
    reason,
  })
}

app.post('/auth/local', async (c) => {
  /**
   * **`content-type` says what was sent; `accept` says what is wanted back.**
   *
   * This read the body according to `accept`, so a caller that sent JSON
   * without asking for JSON — `curl` sends an accept header that takes
   * anything — had its body
   * handed to the form parser, which found no fields. The request then failed
   * as `?error=missing` **before reaching authentication**, so a correct
   * password and a wrong one came back identical. `agent-mesh-local-pm` hit it
   * on the first login of a fresh clone and nearly wrote it up as "login does
   * not work on a new host".
   *
   * The documented command carries `accept: application/json`, which is why
   * copying it works and typing your own does not — a defect that hides from
   * exactly the path most likely to be tested.
   *
   * A JSON body is answered in JSON even when nothing asked: the caller spoke
   * JSON, and redirecting them to a page they cannot render is not an answer.
   * The browser form is unaffected — it sends a form and asks for nothing.
   */
  const sentJson = (c.req.header('content-type') ?? '').includes('application/json')
  const wantsJson = sentJson || (c.req.header('accept') ?? '').includes('application/json')
  const fail = (status: 400 | 401, error: string, redirect: string) =>
    wantsJson ? c.json({ ok: false, error }, status) : c.redirect(redirect)

  // **A body that parses is not a body with fields.** `null` is valid JSON, and
  // reading `.username` off it threw — so the one malformed body this route
  // answered with `500` was the one it could parse, while `"a string"`, `[]`
  // and `123` all got the `400` they should. A public sign-in route that can be
  // made to log an unhandled error by posting four characters is also a free
  // way to fill somebody's log.
  const parsed = sentJson ? await c.req.json().catch(() => null) : await c.req.parseBody()
  const body: Record<string, unknown> =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const username = body.username as string
  const password = body.password as string

  if (!username || !password) {
    refusedSignIn(username, 'missing_fields')
    return fail(400, 'username and password are required', '/?error=missing')
  }

  const user = await verifyLocalUser(username, password)
  if (!user) {
    // Deliberately not distinguishing "no such user" from "wrong password",
    // which would turn this into a way to enumerate accounts. The log does not
    // distinguish them either, for the same reason — a refusal reason of
    // `no_such_user` in a record somebody can read is the enumeration.
    refusedSignIn(username, 'bad_credentials')
    return fail(401, 'invalid username or password', '/?error=invalid')
  }

  // Ensure user exists in users table + policies
  const db = getDb()
  db.prepare(`
    INSERT INTO users (github_id, github_login, role) VALUES (?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login, role = excluded.role
  `).run(-user.id, user.username, user.role)
  db.prepare(`INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, '*')`).run(user.username)

  const jwt = await signJwt({
    github_id: -user.id,  // negative ID to distinguish local users
    github_login: user.username,
    role: user.role,
  })

  const maxAge = 60 * 60 * 24 * 30 // 30 days
  const cookie = sessionCookie(c, jwt, maxAge)

  if (wantsJson) {
    // The same fields `/auth/me` answers with, so a client has a session
    // without a second round trip — and so the two cannot describe the same
    // user differently.
    return new Response(
      JSON.stringify({
        ok: true,
        user: {
          github_id: -user.id,
          github_login: user.username,
          role: user.role,
        },
        // The line above says these are the fields `/auth/me` answers with, so
        // that the two cannot describe the same user differently. This one was
        // missing and made that sentence false: a client reading a session it
        // had just been handed would find no flag, take the absence for `false`,
        // and walk a locked account into a console that refuses every request.
        // agent-mesh-local-pm found it by measuring the response instead of
        // building from what I told them it contained.
        must_change_password: mustChangePassword(user.username),
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'Set-Cookie': cookie } },
    )
  }

  return new Response(null, {
    status: 302,
    headers: { 'Location': '/chat', 'Set-Cookie': cookie },
  })
})

app.get('/auth/github/callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    return c.json({ error: 'Missing "code" query parameter' }, 400)
  }

  try {
    const accessToken = await exchangeCodeForToken(code)
    const ghUser = await getGithubUser(accessToken)
    const dbUser = upsertUser(ghUser.id, ghUser.login)
    const jwt = await signJwt({
      github_id: dbUser.github_id,
      github_login: dbUser.github_login,
      role: dbUser.role,
    })

    // Check if user is approved
    const approved = isUserApproved(dbUser.github_login, dbUser.role)
    if (!approved) {
      // Create pending approval if not already exists
      const existing = getPendingApproval(dbUser.github_login)
      if (!existing || existing.status === 'denied') {
        createPendingApproval(dbUser.github_login, dbUser.github_id)
        notifyApprovalRequest(dbUser.github_login, dbUser.github_id)
      }
    }

    const maxAge = 60 * 60 * 24 * 30 // 30 days
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/chat',
        'Set-Cookie': sessionCookie(c, jwt, maxAge),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: 'OAuth callback failed', detail: message }, 500)
  }
})

/**
 * A session that has to change its password can do that and nothing else.
 *
 * **The server refuses, not the screen.** A redirect is what the operator sees;
 * it is not what stops `curl` with the same cookie. A guard that only moves a
 * page is the shape this repository removed from four screens today — it looks
 * like authorisation and is decoration.
 *
 * Three routes stay open, and each for a reason: the change itself, `/auth/me`
 * so the console can ask *why* it is being refused, and logout so the session
 * can simply be abandoned. Everything else answers `403` with the same flag, so
 * a client learns the reason from whichever request it happened to make.
 */
const OPEN_WHILE_FLAGGED = new Set(['/auth/local/password', '/auth/me', '/auth/logout'])

/**
 * Signing out, which until now the allowlist above named and nothing answered.
 *
 * `POST /auth/logout` was `404`, and the front end's `logout()` cleared its own
 * state and left the cookie alone: the browser went to `/login` still holding a
 * valid session, and typing `/dashboard` walked straight back in. On a shared
 * machine that is the next person's session.
 *
 * **What this does and does not do.** It clears the browser's copy. The token
 * is a stateless JWT, so one already copied out keeps working until it expires
 * — revoking that needs somewhere to record the revocation, which is a change
 * to how sessions are stored rather than a line here. The scenario asserts the
 * browser has no session, which is what this makes true.
 */
app.post('/auth/logout', (c) => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'Set-Cookie': sessionCookie(c, '', 0) },
  })
})


app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (OPEN_WHILE_FLAGGED.has(path) || path.startsWith('/auth/local') || path === '/login') return next()

  const payload = await extractJwt(c)
  if (payload && mustChangePassword(payload.github_login)) {
    refusedSignIn(payload.github_login, 'must_change_password')
    return c.json(
      { error: 'This account must change its password before anything else', must_change_password: true },
      403,
    )
  }
  return next()
})

/**
 * Change the password of the signed-in local account.
 *
 * The current password is asked for again even though the caller holds a
 * session: a screen left open is not a decision to hand the account over.
 */
app.post('/auth/local/password', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const current = body?.current
  const next = body?.next
  if (typeof current !== 'string' || typeof next !== 'string' || next.length < 8) {
    return c.json({ error: '`current` and `next` are required, and `next` must be at least 8 characters' }, 400)
  }
  if (next === current) {
    return c.json({ error: '`next` must differ from `current`' }, 400)
  }

  const outcome = await setLocalPassword(payload.github_login, current, next)
  if (outcome === 'no-user') return c.json({ error: 'no local account for this session' }, 404)
  if (outcome === 'wrong-current') return c.json({ error: '`current` is not this account\'s password' }, 403)

  log.info(`${payload.github_login} changed their password`, 'password_changed', {
    actor: payload.github_login,
  })
  return c.json({ ok: true, must_change_password: false })
})

app.get('/auth/me', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const user = getUser(payload.github_id)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const approved = isUserApproved(user.github_login, user.role)
  return c.json({
    // Why a session that is refused everywhere else is refused. Answered here
    // because this is one of the three routes such a session can still reach.
    must_change_password: mustChangePassword(user.github_login),
    github_id: user.github_id,
    github_login: user.github_login,
    role: user.role,
    approved,
    /**
     * **Which tenant this session is in, or `null` for an account that has no
     * local row.**
     *
     * Admission writes a tenant (`POST /api/v1/admin/users`, defaulting to the
     * admitting operator's own), and nothing answered with it, so a screen
     * asking "whose tenant am I looking at" had `undefined` and drew nothing.
     * `agent-mesh-local-pm` measured it as `tenant: null` on an account that
     * has one.
     *
     * `null` is a real answer here rather than an unknown: it means this
     * session is a GitHub login with no `local_users` row, and it is not the
     * same as "the default tenant" — which is why it is not defaulted to
     * `'default'` on the way out. The row's value is the only thing that
     * decides, and this route reports it rather than deciding again, for the
     * reason `must_change_password` sits three lines up: two routes that
     * describe the same user must not describe them differently.
     *
     * It is **not** a scoping decision. What a tenant may see is still open
     * (`I-093`/`I-094`, `docs/deferred.md`); saying which one you are in is not
     * the same question and does not wait on it.
     */
    tenant: getLocalUser(user.github_login)?.tenant ?? null,
    created_at: user.created_at,
    /**
     * **What this session may actually do (§ 11).**
     *
     * Without it a client has `role` and nothing else, so it builds its own
     * table mapping roles to capabilities — a second copy of a list this server
     * owns, and one nothing can compare. The admin front end had exactly that,
     * and three of its six names disagreed with these: `role.assign` for
     * `role.grant`, and underscores where these have dots. Nothing failed,
     * because the two lists never met.
     *
     * The visible cost was a screen refusing an operator the server had
     * granted: its guard asked for a name its own table did not contain, so
     * only a catch-all let anyone in. `agent-mesh-local-pm` measured it (mail
     * #613).
     *
     * These are grants, not a role expansion. `admin` sees everything here
     * because `LEGACY_ADMIN_CAPABILITIES` is `ALL_CAPABILITIES` and that is
     * written as grants — so this reports what was granted, and a deployment
     * that narrows the admin set later reports the narrower answer without
     * anything else changing.
     *
     * **Affordance only.** Every route checks for itself; a client that ignored
     * this and called anyway is refused exactly as before. It exists so a screen
     * can grey out what would be refused rather than guess.
     */
    capabilities: grants
      .listFor(agentsDb(), user.github_login)
      .map((g) => g.capability)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort(),
  })
})

// --- Auth helpers ---

async function extractJwt(c: any): Promise<JwtPayload | null> {
  // Try Authorization header first
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      return await verifyJwt(token)
    } catch {
      return null
    }
  }

  // Fall back to mesh_token cookie
  const cookieToken = getCookie(c, 'mesh_token')
  if (cookieToken) {
    try {
      return await verifyJwt(cookieToken)
    } catch {
      return null
    }
  }

  return null
}

// --- Health ---

/**
 * Liveness (SPEC § 13's table), and one number that has to mean what it says.
 *
 * **`agent_count` counted the wrong table for as long as it existed.**
 * `countRegistryAgents()` counts `agent_registry`, which is this process's
 * messaging directory: its only two writers are a one-time import of the
 * pre-database `registry.json` and `upsertApprovedWebUser`, which inserts a
 * **person** with `type: 'user'`. Provisioning a mesh identity writes the hub's
 * registry and never touches it.
 *
 * On the deployment where this was found the route answered `agent_count: 1`.
 * The 1 was `admin` — a human — and the mesh in the same state directory held
 * fourteen agents. A field named for agents reported a number that moves when
 * somebody logs in and does not move when an agent is provisioned.
 *
 * Nothing caught it because nothing asserted what the number *is*. A count is
 * the easiest value in the world to test and the easiest to test vacuously:
 * assert it is a number and every wrong source passes, assert it is 1 on a
 * fixture and the one row happens to be right for the wrong reason. The test
 * beside this asserts it *moves with provisioning and not with login*, which is
 * the only form of the assertion that names the subject.
 *
 * SPEC calls this route a liveness ping and specifies no body, so correcting
 * the field breaks no contract. It stays rather than being deleted because it
 * is the one number an operator can get before authenticating, and *how many
 * identities exist* is what they are asking when they ask.
 */
app.get('/api/v1/health', (c) => {
  // Alive only. Teardown soft-deletes — the row stays so an audit trail can
  // still name the identity — and every other reader of this table filters on
  // it: `hub/db.ts`, the agent routes here, and `store/entitlement.ts`. This
  // one did not, so a torn-down identity kept being counted as existing, which
  // is the opposite of what teardown was asked to do.
  const registered = agentsDb()
    .prepare('SELECT count(*) AS n FROM agents WHERE deleted_at IS NULL')
    .get() as { n: number }
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000)

  return c.json({
    status: 'ok',
    version: BUILD_VERSION,
    agent_count: registered.n,
    uptime: uptimeSeconds,
  })
})

// --- List Agents ---

app.get('/api/v1/agents', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  // **Two registries, one namespace.** `agent_registry` is this server's own
  // list — who can be addressed from the console — and the mesh's `agents`
  // table is where the hub records presence, updated by the heartbeat and
  // written before the registry when a socket goes (SPEC § 3.1). They are
  // keyed on the same identity string, so the facts join.
  //
  // This route read only the first of them, which is why the console had no
  // way to learn when an agent was last seen and drew `ONLINE` for everyone
  // instead. The server knew; the route did not carry it.
  const mesh = agentsDb()
  const lastSeen = new Map(
    (
      mesh.prepare(`SELECT identity, last_seen FROM agents WHERE deleted_at IS NULL`).all() as Array<{
        identity: string
        last_seen: string | null
      }>
    ).map(row => [row.identity, row.last_seen] as const),
  )
  const fingerprints = new Map(
    (
      mesh.prepare(`SELECT identity, fingerprint FROM agent_keys WHERE status = 'approved'`).all() as Array<{
        identity: string
        fingerprint: string
      }>
    ).map(row => [row.identity, row.fingerprint] as const),
  )

  /**
   * **What this session may see (§ 12).**
   *
   * The route listed the whole registry to anyone approved, so an account with
   * no capabilities saw all 44 identities — measured by `agent-mesh-local-pm`
   * on the standing stack, admin and member alike. The boundary the owner chose
   * is not the tenant: it is what you own, who you share a group with, and who
   * your agents have actually talked to.
   *
   * **"Connected with" is history, not a live socket.** Reading it as session
   * state would make the list empty while an agent sleeps and drop yesterday's
   * correspondents — access flickering with a socket. `messages` is the record
   * of who has ever exchanged with whom, and that is what is joined here.
   *
   * The group term is **the group the person is in**, not the groups their
   * agents are in: the owned-agent term below already reaches those, and of the
   * two readings this is the narrower. Widening later is a line; narrowing
   * arrives after an incident.
   *
   * Tenant is deliberately not part of these queries. An account with no
   * `local_users` row has `tenant: null` (see `/auth/me`), and scoping on it
   * would quietly return nothing for exactly those sessions — a denominator
   * shrinking without saying so. Ownership and membership are already per
   * identity.
   */
  const actor = payload.github_login

  /**
   * **Temporary, and this comment is the record of it.**
   *
   * § 11 decides on capabilities rather than on `role`, and the vocabulary of
   * twelve has no name for *sees the whole registry*. Adding one is a
   * `agent-mesh-contracts` tag, which moves three repositories, so it is the
   * owner's call and not this route's. Until that name exists an administrator
   * would be scoped like anybody else and the console would lose the view it
   * exists for, so `role` stands in.
   *
   * It lives here rather than in `docs/deferred.md` because the next person to
   * read this line is the person who can replace it, and they will be reading
   * this file.
   *
   * **Read from the row, not from the token.** The owner's answer to where
   * scope comes from was "the database, not the capability table", and a JWT is
   * neither: it is a copy of what the row said when the session began. An
   * account demoted from `admin` keeps its old claim until the token expires,
   * which is the whole class of bug where a screen and a server describe the
   * same person differently. `local_users` first because a local account is the
   * one that can be re-roled here; `users` for a GitHub login that has no local
   * row.
   *
   * **Not covered by a check, and here is why rather than a silence:** nothing
   * changes an account's role after admission — `role.grant` grants
   * capabilities, not roles — so no route can make the token and the row
   * disagree today, and a test would have to reach past the API to build the
   * state it claims to measure. The day a re-role route exists, the check is
   * "demote an administrator, and their listing narrows without a new login".
   */
  const seesEverything = (getLocalUser(actor)?.role ?? getUser(payload.github_id)?.role) === 'admin'

  const visible = new Set<string>()
  if (!seesEverything) {
    visible.add(actor)

    // `ownership.ownedBy` and `groups.groupOf`/`membersOf` rather than SQL of
    // this route's own. The first draft wrote both queries by hand, which is a
    // second copy of what those tables mean — and the tenant default lives in
    // the store, so a hand-written `WHERE` is also where a tenant argument goes
    // missing.
    for (const identity of ownership.ownedBy(mesh, actor)) visible.add(identity)

    // The group this person is in, and everyone else in it. `(tenant, identity)`
    // is the primary key, so a person is in at most one.
    const myGroup = groupsStore.groupOf(mesh, actor)
    if (myGroup) {
      for (const member of groupsStore.membersOf(mesh, myGroup)) visible.add(member)
    }

    // Everyone this person's identities have exchanged a message with, in
    // either direction. Both ends are added because a conversation is not
    // directional for the purpose of "have these two met".
    const mine = [...visible]
    const marks = mine.map(() => '?').join(', ')
    const talked = getDb()
      .prepare(
        `SELECT from_agent, to_agent FROM messages WHERE from_agent IN (${marks}) OR to_agent IN (${marks})`,
      )
      .all(...mine, ...mine) as Array<{ from_agent: string; to_agent: string }>
    for (const row of talked) {
      visible.add(row.from_agent)
      visible.add(row.to_agent)
    }
  }

  const agents = listRegistryAgents()
    .filter(entry => seesEverything || visible.has(entry.id))
    .map(entry => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    channel: entry.channel,
    type: entry.type,
    created_at: entry.created_at,
    // `null` means the mesh holds no presence record for this identity — a web
    // user who has never connected has none — and it does not mean offline.
    //
    // **No `status` field, deliberately.** Whether silence for five minutes is
    // `inactive` is an operating policy, and a route answering it here would
    // ship a judgement dressed as a measurement. That is the defect the screens
    // were fixed for in `71afcdb` and `189f4ab`; putting it in the server moves
    // the invention one layer up rather than removing it.
    last_seen_at: lastSeen.get(entry.id) ?? null,
    fingerprint: fingerprints.get(entry.id) ?? null,
  }))

  return c.json({ agents })
})

// --- Send Message ---

app.post('/api/v1/messages', async (c) => {
  // --- Auth required ---
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized — provide Authorization: Bearer <jwt>' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const to = body.to as string | undefined
  const text = body.text as string | undefined
  const replyTo = body.reply_to as string | undefined
  const filePath = body.file_path as string | undefined
  // § 15.2. The upload response is itself a valid metadata object, so a client
  // attaches it unchanged. Until now nothing read this and the attachment was
  // dropped before the message reached the wire — the pull-on-demand loop of
  // § 15.4 had no producer at all, so a lane could never receive a
  // `download_url` to fetch.
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as Array<Record<string, unknown>>).filter(
        (a) => a && typeof a.id === 'string' && typeof a.download_url === 'string',
      )
    : []

  // Override "from" with authenticated user's github_login
  const from = payload.github_login

  if (!to || typeof to !== 'string') {
    return c.json({ error: 'Missing or invalid "to" field' }, 400)
  }
  if (!text || typeof text !== 'string') {
    return c.json({ error: 'Missing or invalid "text" field' }, 400)
  }

  // Validate file_path if provided
  if (filePath !== undefined) {
    if (typeof filePath !== 'string') {
      return c.json({ error: 'Invalid "file_path" field — must be a string' }, 400)
    }
    if (!existsSync(filePath)) {
      return c.json({ error: `File not found: ${filePath}` }, 400)
    }
  }

  // --- Authorization: check policy ---
  if (!isAllowedToMessage(payload.github_login, payload.role, to)) {
    return c.json({ error: `You are not authorized to message agent "${to}"` }, 403)
  }

  // Check target agent exists
  if (!getRegistryAgent(to)) {
    return c.json({
      error: `Agent "${to}" not found in registry`,
      known_agents: listRegistryAgentIds(),
    }, 404)
  }

  // Build message
  const msg: Message = {
    id: `msg_${Date.now()}_${randomBytes(4).toString('hex')}`,
    from,
    to,
    ts: new Date().toISOString(),
    content: text,
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(filePath ? { file_path: filePath } : {}),
    status: 'pending',
  }

  // Write to SQLite
  insertMessage({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    content: msg.content,
    status: msg.status,
    ts: msg.ts,
    ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
    ...(msg.file_path ? { file_path: msg.file_path } : {}),
  })

  // With attachments the body is a JSON object carrying both, because § 15.2
  // requires the `attachments` array to be *in* the message body and § 8.2's
  // content is a flat string. A message without them stays a plain string, so
  // nothing changes for the common case.
  const wireContent = attachments.length > 0
    ? JSON.stringify({ text, attachments })
    : text

  // Reported, not swallowed. It used to be `.catch(() => null)`, so a message
  // the hub refused — an unentitled sender, a torn-down recipient — was still
  // written locally and rendered in the UI as though it had been routed. The
  // person saw a sent message that no one would ever receive.
  const hubMessageId = await sendViaHub(to, wireContent, from, replyTo).catch(() => null)
  if (!hubMessageId) {
    log.warn(`the hub did not accept a message from ${from} to ${to}`, 'send_not_accepted', {
      actor: from,
      to,
      outcome: 'failed',
      reason: 'hub_refused',
    })
  }

  // Push to SSE clients so sender's UI updates immediately.
  //
  // **`failed` when the hub never took it**, and `pending` only while it has
  // been accepted and is waiting for its recipient. A line here used to say the
  // opposite — that the refused case stayed `pending` — describing a design
  // this paragraph replaced, and it survived the change it was refuted by. A
  // reader building a screen from it labels every refused message *waiting*,
  // which is the exact confusion the write-back below exists to end.
  //
  // **Written back, not only corrected in memory.** This assignment used to
  // change the object the response and the SSE frames are built from, and
  // nothing else: the row inserted above stayed `pending` for ever, because
  // no `UPDATE` of this table existed anywhere. So the caller was told the
  // truth once and every later read was told otherwise — the history route,
  // the conversation view and search all serve the stored value, and they
  // reported a message that never left this machine as one still waiting for
  // its recipient.
  if (!hubMessageId) {
    msg.status = 'failed'
    markSendFailed(msg.id)
  }
  const sseMsg = { id: msg.id, from: msg.from, to: msg.to, ts: msg.ts, content: msg.content, reply_to: msg.reply_to ?? null, file_path: msg.file_path ?? null, status: msg.status }
  pushToSSE(msg.to, msg.from, 'message', sseMsg)
  pushToSSE(msg.from, msg.to, 'message', sseMsg)

  // Send push notification to recipient
  sendPushNotificationForMessage(to, from, text)

  return c.json({
    ok: true,
    message: {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      ts: msg.ts,
      status: msg.status,
      ...(msg.file_path ? { file_path: msg.file_path } : {}),
    },
  }, 201)
})

// --- Search Messages (must be before :agent route) ---

app.get('/api/v1/messages/search', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  const q = c.req.query('q')
  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return c.json({ error: 'Missing or empty "q" query parameter' }, 400)
  }

  const limitParam = c.req.query('limit')
  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200)

  const results = searchMessages(q.trim(), payload.github_login, limit)

  return c.json({
    query: q.trim(),
    count: results.length,
    messages: results.map(m => ({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      content: m.content,
      reply_to: m.reply_to,
      file_path: m.file_path,
      status: m.status,
      ts: m.ts,
    })),
  })
})

// --- SSE Event Stream ---

app.get('/api/v1/events/:agentId', async (c) => {
  // **The session cookie, not a query parameter.**
  //
  // The old comment here said "EventSource can't set headers", which is true
  // and was the wrong conclusion: a cookie is not a header the caller sets,
  // it is one the browser sends, and `EventSource` sends it for a same-origin
  // request without being asked.
  //
  // The parameter it replaced put a bearer credential in the URL — so into
  // access logs, proxy request lines, `Referer` on anything the page loads
  // next, and browser history. A credential in the one place logging tools are
  // built to keep.
  //
  // Cross-origin consumers need `withCredentials: true`; that is a smaller ask
  // than a token in a URL, and § 9.1 says so.
  const payload = await extractJwt(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (!isUserApproved(payload.github_login, payload.role)) return c.json({ error: 'Forbidden' }, 403)

  const agentId = c.req.param('agentId')
  const userLogin = payload.github_login

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // Send initial heartbeat
      send('connected', { agent: agentId })

      // Register this SSE client for hub-driven push
      addSSEClient(agentId, userLogin, controller)

      // Keep the connection alive through anything that would close it idle.
      const stopHeartbeat = startStreamKeepalive(() => send('ping', { ts: Date.now() }), 30000)

      // Cleanup on close
      c.req.raw.signal.addEventListener('abort', () => {
        removeSSEClient(agentId, userLogin, controller)
        stopHeartbeat()
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  })
})

// --- Fetch Message History ---

app.get('/api/v1/messages/:agent', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  const agent = c.req.param('agent')
  const limitParam = c.req.query('limit')
  const limit = Math.min(Math.max(parseInt(limitParam ?? '20', 10) || 20, 1), 100)

  // Fetch from SQLite only
  const dbMessages = getMessageHistory(agent, limit)
  const messages = dbMessages.map(m => ({
    id: m.id,
    from: m.from_agent,
    to: m.to_agent,
    content: m.content,
    reply_to: m.reply_to,
    file_path: m.file_path,
    status: m.status,
    ts: m.ts,
  }))

  return c.json({
    agent,
    count: messages.length,
    messages,
  })
})

// --- File Serve Endpoint ---

const ALLOWED_FILE_PREFIXES = [
  STATE_DIR,
  '/home/ubuntu/ai/workspaces/',
]
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB


function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const mimeMap: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    js: 'text/javascript',
    ts: 'text/typescript',
    html: 'text/html',
    css: 'text/css',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    log: 'text/plain',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    sh: 'text/x-shellscript',
    py: 'text/x-python',
    toml: 'text/toml',
    csv: 'text/csv',
  }
  return mimeMap[ext] ?? 'application/octet-stream'
}

app.get('/api/v1/files', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  const filePath = c.req.query('path')
  if (!filePath || typeof filePath !== 'string') {
    return c.json({ error: 'Missing "path" query parameter' }, 400)
  }

  // Security: validate path. **The caller's spelling goes in**, not the
  // resolved copy — passing the resolved one made the `..` rule unreachable,
  // because `resolve(resolve(p)) === resolve(p)` for every input.
  const { resolve } = require('path') as typeof import('path')
  const resolved = resolve(filePath)

  if (!isPathAllowed(filePath, ALLOWED_FILE_PREFIXES)) {
    return c.json({ error: 'Access denied — file path not in allowed directories' }, 403)
  }

  if (!existsSync(resolved)) {
    return c.json({ error: 'File not found' }, 404)
  }

  // Check file size
  const { statSync } = require('fs') as typeof import('fs')
  const stat = statSync(resolved)
  if (!stat.isFile()) {
    return c.json({ error: 'Path is not a file' }, 400)
  }
  if (stat.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 10MB limit)` }, 413)
  }

  const content = readFileSync(resolved)
  const contentType = getMimeType(resolved)
  const filename = resolved.split('/').pop() ?? 'file'

  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(stat.size),
    },
  })
})

// --- Admin: Approval Management ---

app.get('/api/v1/admin/pending', async (c) => {
  // § 11: admitting a person is its own capability. It is not role.grant —
  // that hands capabilities to somebody already admitted — and not
  // agent.provision, which claims a mesh identity. This route was on the role
  // check until user.admit existed to move it to.
  const actor = await requireCapability(c, CAPABILITY.USER_ADMIT)
  if (typeof actor !== 'string') return actor
  void actor

  // **`users`, not `pending`.** Two decision queues answer on this server —
  // people awaiting admission here, key proposals on
  // `/api/v1/admin/keys/pending` — and both used to answer `{ pending: [...] }`.
  // So a caller asking "is anything waiting" could reach for either, get an
  // honest empty array, and be reading the answer to the other question.
  // `agent-mesh-local-pm` found it by counting routes that share a last
  // segment. The response now says which queue it is.
  //
  // No alias: keeping `pending` beside `users` would be one fact under two
  // names, and the only consumer of this route is `ui/admin.ts` in this
  // repository, which moves in the same commit.
  const users = listPendingApprovals()
  return c.json({ users })
})

// --- Audit blob upload (SPEC § 9.1) ---------------------------------------
//
// On this service rather than the hub because § 9.1 puts the blob routes here,
// alongside the other attachment storage. Authorisation is the AgentMeshSig
// header over a grant the hub issued, so the hub decides *what* may be
// uploaded and this decides whether these bytes match.

app.put('/api/v1/audit/blobs/:key', async (c) => {
  const r = await putBlob(c.req.param('key'), c.req.raw)
  return c.json(r.body, r.status as any)
})

// --- Audit query (SPEC § 9.1) ---------------------------------------------
//
// Admin JWT, separate from lane authentication: a lane's signing key authorises
// it to *write* its own events, and says nothing about reading anyone else's.

app.get('/api/v1/audit/events', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_METADATA)
  if (typeof actor !== 'string') return actor
  // § 11's privacy boundary. The platform operator holds the metadata
  // capability and not this one; a tenant admin inside the tenant holds both.
  const withContent = grants.has(agentsDb(), actor, CAPABILITY.AUDIT_READ_CONTENT)
  const refused = logContentRead(c, actor, withContent, 'list', c.req.query())
  if (refused) return refused
  const r = listAuditEvents(c.req.query() as any, withContent)
  return c.json(r.body, r.status as any)
})

app.get('/api/v1/audit/events/:event_id', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_METADATA)
  if (typeof actor !== 'string') return actor
  const withContent = grants.has(agentsDb(), actor, CAPABILITY.AUDIT_READ_CONTENT)
  const refused = logContentRead(c, actor, withContent, c.req.param('event_id'), {})
  if (refused) return refused
  const r = getAuditEvent(c.req.param('event_id'), withContent)
  return c.json(r.body, r.status as any)
})

/**
 * Record a content read, or refuse it (SPEC § 11.0.1).
 *
 * Returns the refusal to send, or `null` to proceed. **Called before the read,
 * not after** — a record written afterwards is not written at all for the
 * request that crashed in between.
 *
 * Metadata-only reads are not gated. They carry no content, so nothing is lost
 * by serving them, and refusing them would take the mesh's diagnostics down
 * with its audit store.
 */
function logContentRead(
  c: any,
  actor: string,
  withContent: boolean,
  target: string,
  query: Record<string, unknown>,
): Response | null {
  if (!withContent) return null
  const refusal = recordContentReadOrRefuse({ actor, target, query })
  return refusal ? c.json(refusal, 503) : null
}

// --- Key approval (SPEC § 10.2) -------------------------------------------
//
// On this service rather than the hub because approval is the one step in the
// key lifecycle that must know who is asking. The hub cannot authenticate a
// caller, so an approval route there would let anyone reaching the port approve
// their own key.

/**
 * Reject anything whose holder lacks `capability` over `scope` (SPEC § 11).
 *
 * **The grant is read here, not taken from the token.** The JWT carries who
 * the caller is; it must not carry what they may do, because then revoking
 * access does not revoke it — the old answer keeps working until the token
 * expires, and the moment revocation matters is an incident.
 *
 * `role: 'admin'` in a token is still honoured, but only as a *subject* whose
 * grants were seeded (see `seedLegacyAdminGrants`). The string is never
 * compared to decide anything.
 */
async function requireCapability(
  c: any,
  capability: Capability,
  scope: string = SCOPE_TENANT,
): Promise<string | Response> {
  const payload = await extractJwt(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  const subject = payload.github_login as string
  if (!grants.has(agentsDb(), subject, capability, scope)) {
    // Names the capability rather than saying "admin required". An operator
    // who is told which grant is missing can ask for that one; one told
    // "forbidden" asks for everything.
    return c.json({ error: `Missing capability: ${capability}`, capability, scope }, 403)
  }
  return subject
}

/**
 * Like `requireCapability`, but satisfied by a grant at **any** scope.
 *
 * For routes that answer a *list* and filter it. Gating those at tenant scope
 * refuses every operator who holds only their own agents — which § 11.3 says
 * must not happen, because the answer for them is an empty list rather than a
 * refusal.
 */
async function requireCapabilityAnyScope(
  c: any,
  capability: Capability,
): Promise<string | Response> {
  const payload = await extractJwt(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  const subject = payload.github_login as string
  if (!grants.hasAny(agentsDb(), subject, capability)) {
    return c.json({ error: `Missing capability: ${capability}`, capability, scope: 'any' }, 403)
  }
  return subject
}

/**
 * What `admin` meant, written down as grants.
 *
 * Deployments seeded before § 11 keep working, and nothing anywhere still
 * compares the string. Deliberately the full set — narrowing it here would be
 * a silent permission change dressed as a refactor.
 */
export function seedLegacyAdminGrants(): void {
  const db = agentsDb()
  grants.migrate(db)
  ownership.migrate(db)
  const admins = getDb()
    .prepare(`SELECT github_login FROM users WHERE role = 'admin'`)
    .all() as Array<{ github_login: string }>
  const local = getDb()
    .prepare(`SELECT username AS github_login FROM local_users WHERE role = 'admin'`)
    .all() as Array<{ github_login: string }>
  for (const { github_login } of [...admins, ...local]) {
    for (const capability of LEGACY_ADMIN_CAPABILITIES) {
      grants.grant(db, { subject: github_login, capability, grantedBy: 'legacy-admin-role' })
    }
  }
}

/**
 * The approval queue, scoped to what the caller owns (SPEC § 11.3).
 *
 * **An operator with no agents sees an empty queue, not a refusal.** They hold
 * `key.approve` — the capability is theirs; there is simply nothing of theirs
 * waiting. Answering `403` would say they lack the permission, which is a
 * different and false statement, and it sends them to ask for a grant they
 * already have.
 *
 * A tenant-wide grant (`scope: "*"`) sees everything, which is what a tenant
 * admin is: inside the tenant, not above it (§ 11).
 */
app.get('/api/v1/admin/keys/pending', async (c) => {
  const actor = await requireCapabilityAnyScope(c, CAPABILITY.KEY_APPROVE)
  if (typeof actor !== 'string') return actor

  const r = listPendingKeys()
  if (r.status !== 200) return c.json(r.body, r.status as any)

  const db = agentsDb()
  // Tenant-wide holders are not filtered. Everyone else sees their own.
  if (grants.has(db, actor, CAPABILITY.KEY_APPROVE, SCOPE_TENANT)) {
    return c.json(r.body, 200)
  }
  const mine = new Set(ownership.ownedBy(db, actor))
  const body = r.body as { ok: boolean; keys?: Array<{ identity: string }> }
  return c.json({ ...body, keys: (body.keys ?? []).filter((k) => mine.has(k.identity)) }, 200)
})

/**
 * Issue a pairing code (SPEC § 11.3).
 *
 * The operator is in a browser; the agent is a process on some host. This is
 * the device authorization grant with the roles reversed — the only mechanism
 * available that binds the two without new infrastructure.
 */
app.post('/api/v1/admin/pairing-codes', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION)
  if (typeof actor !== 'string') return actor

  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const identity = body?.identity
  if (typeof identity !== 'string' || !IDENTITY_RE.test(identity)) {
    return c.json({ ok: false, error: 'identity is required and must match the § 10.1 pattern' }, 400)
  }
  const ttl = Number(body?.ttl_seconds ?? PAIRING_TTL_SECONDS)
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > PAIRING_TTL_MAX_SECONDS) {
    return c.json({ ok: false, error: `ttl_seconds must be 1..${PAIRING_TTL_MAX_SECONDS}` }, 400)
  }

  const code = ownership.issueCode(agentsDb(), { identity, issuedBy: actor, ttlSeconds: ttl })
  log.info(`${actor} issued a pairing code for ${identity}`, 'pairing_code_issued', {
    id: identity,
    actor,
    ttl_seconds: ttl,
  })
  // The code itself is returned once and never read back — every later route
  // answers about it without repeating it, so a screen that loses it has to
  // issue another rather than recover this one.
  // `ttl_seconds` travels with the code because the console already reads it:
  // `PairingCodeResponse` declares it, and `RegisterAgentPage` does
  // `res.ttl_seconds || selectedTtl`, which fell through to the *requested*
  // value on every call because the field was never sent. The two agree today
  // — the route refuses a window outside 1..max rather than clamping one into
  // range — so this changes no number on the screen. What it changes is where
  // the number comes from: the granted window is the server's fact, and a
  // client deriving one from `expires_at` would be doing it against a clock the
  // server does not share.
  return c.json({ ok: true, code: code.code, identity, expires_at: code.expires_at, ttl_seconds: ttl }, 201)
})

/**
 * Redeem one, from the agent's host.
 *
 * **Unauthenticated by design.** The code *is* the credential, and the caller
 * is a CLI that holds no human session — requiring one would defeat the
 * purpose, which is to carry an authenticated person's claim to a machine that
 * has no browser.
 *
 * The address is recorded because this is the strongest moment available: the
 * one transaction in which the agent's host and the person vouching for it are
 * both known (§ 8.11).
 */
app.post('/api/v1/pairing-codes/redeem', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const code = body?.code
  const owner = body?.owner
  if (typeof code !== 'string' || typeof owner !== 'string') {
    return c.json({ ok: false, error: 'code and owner are required' }, 400)
  }

  const observed =
    (c.req.header('x-forwarded-for')?.split(',').pop() ?? '').trim() ||
    c.req.header('x-real-ip') ||
    null

  const outcome = ownership.redeem(agentsDb(), code, owner, observed)
  if (!outcome.ok) {
    // The three reasons are distinguished on purpose: "ask for another" and
    // "somebody else already used this" call for different reactions, and
    // collapsing them into "invalid" hides a race from the person losing it.
    const status = outcome.reason === 'unknown' ? 404 : 409
    return c.json({ ok: false, reason: outcome.reason, error: `pairing code ${outcome.reason}` }, status)
  }
  log.info(`${owner} claimed ${outcome.identity} with a pairing code`, 'pairing_code_claimed', {
    id: outcome.identity,
    actor: owner,
    outcome: 'claimed',
  })
  return c.json({ ok: true, identity: outcome.identity, owner: outcome.owner })
})

/**
 * What the caller owns (SPEC § 11.3).
 *
 * **`key.approve` at any scope, not `agent.provision`.** The question is
 * "which agents are mine to look after", and the screen that asks it is the
 * approval queue's empty state — an operator who owns nothing needs to be told
 * that rather than shown a bare "nothing pending", because the two have
 * different next actions and only one of them is *do nothing*.
 *
 * Answers about the caller and nobody else. A tenant-wide grant does not widen
 * it: "everything in the tenant" is not an answer to "what is mine".
 */
app.get('/api/v1/admin/agents/owned', async (c) => {
  const actor = await requireCapabilityAnyScope(c, CAPABILITY.KEY_APPROVE)
  if (typeof actor !== 'string') return actor
  return c.json({ ok: true, owner: actor, identities: ownership.ownedBy(agentsDb(), actor) })
})

/**
 * Grant or withdraw `can_proxy` (SPEC § 8.2).
 *
 * **Here rather than on provisioning**, for the reason § 10.2 gives for key
 * approval: the hub cannot authenticate a caller, so a grant it served would
 * be one the granted party could write for itself. The entitlement check reads
 * this value, and a value the checked party sets is not a check.
 *
 * Gated on `agent.provision` scoped to the identity. Speaking for someone else
 * is the strongest thing a participant can be given, and the operator granting
 * it should be one who could have created the identity in the first place.
 */
app.post('/api/v1/admin/agents/:identity/can-proxy', async (c) => {
  const identity = c.req.param('identity')
  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION, identity)
  if (typeof actor !== 'string') return actor
  if (!IDENTITY_RE.test(identity)) return badIdentity(c)

  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  if (typeof body?.can_proxy !== 'boolean') {
    return c.json({ ok: false, error: 'can_proxy must be a boolean' }, 400)
  }

  const db = agentsDb()
  const exists = db.prepare(`SELECT 1 FROM agents WHERE identity = ? AND deleted_at IS NULL`).get(identity)
  if (!exists) return c.json({ ok: false, error: `identity '${identity}' is not registered` }, 404)

  db.prepare(`UPDATE agents SET can_proxy = ? WHERE identity = ?`).run(body.can_proxy ? 1 : 0, identity)
  log.info(`${actor} set can_proxy=${body.can_proxy} on ${identity}`, 'can_proxy_set', {
    id: identity,
    actor,
    can_proxy: body.can_proxy,
  })
  return c.json({ ok: true, identity, can_proxy: body.can_proxy })
})

// --- Groups and egress (SPEC § 12) ----------------------------------------
//
// Deny by default, so these routes are how a deployment says anything at all.
// A mesh that shipped permissive would stay open until somebody configured it,
// and nobody configures what already works.

app.get('/api/v1/admin/groups', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.GROUP_MANAGE)
  if (typeof actor !== 'string') return actor
  const db = agentsDb()
  return c.json({
    ok: true,
    groups: groupsStore.listGroups(db).map((g) => ({ ...g, members: groupsStore.membersOf(db, g.group_id) })),
    egress: groupsStore.listEgress(db),
  })
})

/**
 * What `POST /api/v1/admin/groups` implements. A body may say only this much,
 * and a field outside it is refused rather than dropped — see the route.
 */
const GROUP_CREATE_FIELDS = new Set(['group_id', 'description'])

app.post('/api/v1/admin/groups', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.GROUP_MANAGE)
  if (typeof actor !== 'string') return actor
  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const groupId = body?.group_id
  if (typeof groupId !== 'string' || !IDENTITY_RE.test(groupId)) {
    return c.json({ ok: false, error: 'group_id must match ^[A-Za-z0-9][A-Za-z0-9-]*$' }, 400)
  }
  // A field this route does not implement is refused, not dropped. Answering
  // 201 to a body that asked for more than it got reports that the whole of it
  // happened: this repository's own fixture sent `members` and `name` here for
  // four months and was told 201 every time, which is why nobody noticed the
  // groups were empty. Membership is singular and is a move, so it has its own
  // route (SPEC § 12), and a group has a `description`, not a `name`.
  const unsupported = Object.keys(body).filter((k) => !GROUP_CREATE_FIELDS.has(k))
  if (unsupported.length > 0) {
    const hint = unsupported.includes('members')
      ? ' Membership is singular: POST /api/v1/admin/groups/{group_id}/members, one identity per call.'
      : ''
    return c.json({
      ok: false,
      error: `unsupported field(s): ${unsupported.join(', ')}. This route accepts group_id and description.${hint}`,
    }, 400)
  }
  const created = groupsStore.createGroup(db_(), {
    groupId, description: typeof body?.description === 'string' ? body.description : null, createdBy: actor,
  })
  // A new group can send nowhere, including to itself, until someone says so.
  // Seeding a self-rule here would guess the one thing the operator created it
  // to state.
  return c.json({ ok: true, group_id: groupId, created }, created ? 201 : 200)
})

app.post('/api/v1/admin/groups/:group_id/members', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.GROUP_MANAGE)
  if (typeof actor !== 'string') return actor
  const groupId = c.req.param('group_id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const identity = body?.identity
  if (typeof identity !== 'string' || !IDENTITY_RE.test(identity)) {
    return c.json({ ok: false, error: 'identity is required' }, 400)
  }
  const db = db_()
  if (!groupsStore.listGroups(db).some((g) => g.group_id === groupId)) {
    // Moving into a group that does not exist would put the identity somewhere
    // no rule can ever name, which is silence rather than an error.
    return c.json({ ok: false, error: `no group '${groupId}'` }, 404)
  }
  const from = groupsStore.groupOf(db, identity)
  groupsStore.moveTo(db, { identity, groupId, movedBy: actor })
  log.info(`${actor} moved ${identity} from ${from} to ${groupId}`, 'group_moved', {
    id: identity,
    actor,
    from_group: from,
    to_group: groupId,
  })
  return c.json({ ok: true, identity, from_group: from, to_group: groupId })
})

app.post('/api/v1/admin/groups/:group_id/egress', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.GROUP_MANAGE)
  if (typeof actor !== 'string') return actor
  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const toGroup = body?.to_group
  if (typeof toGroup !== 'string' || !IDENTITY_RE.test(toGroup)) {
    return c.json({ ok: false, error: 'to_group is required' }, 400)
  }
  // Directional, and the route shape says so: this grants `{group_id} -> to`
  // and nothing in the other direction. Agents allowed to report into an
  // aggregator are not agents it may command.
  groupsStore.allowEgress(db_(), { fromGroup: c.req.param('group_id'), toGroup, grantedBy: actor })
  return c.json({ ok: true, from_group: c.req.param('group_id'), to_group: toGroup }, 201)
})

app.delete('/api/v1/admin/groups/:group_id/egress/:to_group', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.GROUP_MANAGE)
  if (typeof actor !== 'string') return actor
  const removed = groupsStore.revokeEgress(db_(), {
    fromGroup: c.req.param('group_id'), toGroup: c.req.param('to_group'),
  })
  // `200` either way, and `action` says which happened — SPEC § 9.2a. This
  // answered `404` with `ok: true`, a status and a body saying opposite things
  // about the same call, and a contract scenario had ratified the `404`.
  return c.json({ ok: true, action: removed ? 'deleted' : 'not-found' })
})

/** Who is answerable for an identity, and how the claim was made. */
app.get('/api/v1/admin/agents/:identity/owners', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION)
  if (typeof actor !== 'string') return actor
  const identity = c.req.param('identity')
  if (!IDENTITY_RE.test(identity)) return c.json({ ok: false, error: 'invalid identity format' }, 400)
  return c.json({ ok: true, identity, owners: ownership.owners(agentsDb(), identity) })
})

// **Before `keys/:identity`**, which matches `stream` as an identity and
// answered this route's first request with a key history for an agent that
// does not exist. Route order is the kind of coupling nothing declares.
/**
 * New key proposals, pushed (SPEC § 10.2.1).
 *
 * The event an operator's dashboard waits on: an agent has asked to join and
 * nobody has compared its fingerprint yet. Before this the only way to know was
 * to poll `keys/pending` from a screen somebody had already opened.
 *
 * **`key.approve`, not the admin role.** Whoever is told about a decision is
 * whoever can make it — § 11 replaced the role check everywhere else, and a
 * notification that reaches people who cannot act on it is a notification they
 * learn to close.
 */
app.get('/api/v1/admin/keys/stream', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.KEY_APPROVE)
  if (typeof actor !== 'string') return actor

  const encoder = new TextEncoder()
  let stop: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      const push = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          return true
        } catch {
          return false
        }
      }
      push('connected', { ok: true })

      // What is already waiting, once, as a snapshot rather than as arrivals.
      // Replaying a backlog as events would announce keys that have been
      // sitting for a day as though they had just landed.
      //
      // **`keys`, the same name the list route uses.** § 9.2 already called this
      // "a second source for the same fact as `/api/v1/admin/keys/pending`" —
      // and then the two sources called that fact different things, because the
      // clause said they were the same without saying what either one sends.
      // The rename moved the list and left the stream, so the bell read `keys`
      // from one channel and `proposals` from the other.
      push('snapshot', { keys: keyProposals.pendingSince(agentsDb()) })

      stop = keyProposals.watchProposals(agentsDb(), (p) => {
        if (!push('key-proposed', p)) stop?.()
      })

      heartbeat = setInterval(() => {
        if (!push('ping', {})) {
          if (heartbeat) clearInterval(heartbeat)
          stop?.()
        }
      }, 20000)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      stop?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

app.get('/api/v1/admin/keys/:identity', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.KEY_APPROVE)
  if (typeof actor !== 'string') return actor
  const r = keyHistory(c.req.param('identity'))
  return c.json(r.body, r.status as any)
})

for (const decision of ['approve', 'deny', 'revoke'] as const) {
  app.post(`/api/v1/admin/keys/${decision}`, async (c) => {
    const actor = await requireCapability(c, CAPABILITY.KEY_APPROVE)
    if (typeof actor !== 'string') return actor

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // Addressed by fingerprint, never by identity. An operator who approves
    // "whatever is pending for prod-codex1" approves whatever arrived last —
    // including a proposal that landed between reading the screen and clicking.
    // The fingerprint is also the string § 10.2 requires them to have compared
    // against the one the holder logged, so naming it is the check.
    const fingerprint = body.fingerprint
    if (typeof fingerprint !== 'string' || !fingerprint) {
      return c.json({ error: 'Missing or invalid "fingerprint" field' }, 400)
    }
    const reason = typeof body.reason === 'string' ? body.reason : null

    const r = decideKey(decision, fingerprint, actor, reason)
    if (r.status === 200) {
      log.info(`${actor} ${decision}d a key`, 'key_decided', {
        id: fingerprint,
        actor,
        outcome: `${decision}d`,
        ...(reason ? { detail: reason } : {}),
      })
    }
    return c.json(r.body, r.status as any)
  })
}

/**
 * What is queued, for an operator (SPEC § 9.2.1).
 *
 * Read-only, and structurally so: this process opens `hub.db` with
 * `readonly: true`, so these routes cannot lease or acknowledge even if
 * someone later writes one that tries. That is the whole reason the operator
 * half lives here rather than beside the agent routes on the hub — there, a
 * mistake would be a lease taken by someone looking.
 *
 * **No message bodies.** Reading someone's mail is a different authorisation
 * question from seeing that they have mail. An operator diagnosing a stuck
 * queue needs depth and age; one who needs content has the audit trail, where
 * the access is itself recorded.
 */
/**
 * Where an identity has been observed connecting from (SPEC § 8.11).
 *
 * **The deployment mode is reported alongside the rows, not per row.**
 * `observed_source` is a property of how this hub learns addresses at all —
 * every row is `socket` or every row is `forwarded` — so a per-row column
 * would suggest a distinction that cannot exist, and an operator would read
 * evidence into rows that have none.
 *
 * When the mode is `forwarded` the caller is told, in the response, that the
 * values are only evidence while the hub is unreachable except through its
 * proxy — which nothing inside the hub can verify. A screen rendering these
 * without that qualifier is showing a claim as an observation.
 */
/**
 * Who holds which capability (SPEC § 11).
 *
 * **Not the same thing as `/api/v1/admin/pending`**, which the front end was
 * calling for this screen. That approves a *person's access to the web surface*
 * — whether they may sign in and use it at all. This is what a signed-in person
 * is allowed to do once they are here, and § 11 replaced the admin role with it
 * precisely because "is an admin" answered too many questions at once.
 *
 * A screen that conflates them offers an operator one switch where there are
 * two, and the one it actually throws is the wider.
 *
 * ## Gated on `role.grant`
 *
 * Reading who holds what is itself sensitive — it is a map of who can do what,
 * which is the first thing worth knowing before trying anything. And granting
 * is gated on the capability that grants, so an operator cannot widen their own
 * reach through a screen they were given for someone else's.
 */
/**
 * How much each tenant received (SPEC § 11.4).
 *
 * **Its own capability, not `audit.read.metadata`.** The trail answers who did
 * what; this answers how much arrived. Somebody watching capacity has no need of
 * the first, and reusing one capability for both is the shape § 11 exists to
 * undo — the same "is an admin" problem, one size down.
 *
 * Counted from `message_stats`, not from `messages`: that table is attributed to
 * the recipient at accept time and does not change afterwards, so two reads a
 * minute apart differ only by what arrived between them.
 */
/**
 * What an operator does something about (SPEC § 14, § 10.2, § 8.10.1).
 *
 * **Not CPU, RSS, heap or event-loop lag**, which the requirement asked for and
 * which do not survive the question *what does an operator do differently after
 * reading this?* There is one hub process by design and no autoscaler here, so
 * `RSS: 412MB` on a mesh nobody can scale horizontally is true and acted on by
 * nobody. Taking those readings from inside the process being measured also has
 * a specific weakness: a hub too sick to answer reports nothing, and nothing is
 * what a healthy idle hub reports too. Whatever supervises the process is where
 * they belong. Decision D-1.
 *
 * Every field below has an action attached — approve the key, chase the lane,
 * widen the limit, look at why nothing is moving.
 *
 * ## Four, not six
 *
 * The proposal this comes from listed six and said all six had "data already
 * stored". Two do not, and saying so here is cheaper than a screen that reports
 * zero for them:
 *
 *   - **signature refusals, by reason** — § 8.1 refuses them and calls `log()`.
 *     Nothing writes them anywhere queryable.
 *   - **egress refusals, by pair** — § 12 the same: `log()` and an RPC error.
 *
 * Both live in process stdout and nowhere else. Adding a write path is not
 * free — a signature refusal is the one event an unauthenticated caller can
 * produce at will, so recording each one hands them the audit store as a disk
 * filler — and that is a design decision rather than an omission to paper over.
 * Reporting `0` for them would be the worse answer: a zero nobody can make
 * non-zero says nothing about the thing it names.
 */
app.get('/api/v1/admin/telemetry', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_METADATA)
  if (typeof actor !== 'string') return actor

  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? 1) || 1, 1), 24 * 7)
  const hub = getHubDb()

  // Somebody is waiting on an operator. Oldest first, because the oldest is
  // the one that has been waiting.
  const keys = agentsDb().prepare(
    `SELECT count(*) AS waiting, min(proposed_at) AS oldest
       FROM agent_keys WHERE status = 'pending'`,
  ).get() as { waiting: number; oldest: string | null }

  // A participant has stopped draining. Per identity, so an operator chases a
  // lane rather than a total.
  const LANE_LIMIT = 10
  const lanes = hub.prepare(
    `SELECT to_agent AS identity, count(*) AS pending, min(ts) AS oldest
       FROM messages WHERE status = 'pending'
      GROUP BY to_agent ORDER BY oldest ASC LIMIT ?`,
  ).all(LANE_LIMIT) as Array<{ identity: string; pending: number; oldest: string }>
  // **The total, because the list is truncated.** Ten rows out of two hundred
  // draws a screen saying the problem is small, and nothing in the response
  // would have disagreed. This route was written an hour before this comment
  // and had the silent version.
  const lanesTotal = (hub.prepare(
    `SELECT count(DISTINCT to_agent) AS n FROM messages WHERE status = 'pending'`,
  ).get() as { n: number }).n

  // The mesh is carrying something, or it is not. Counted from message_stats
  // for the reason § 11.4 gives: it is written at accept time and does not
  // change afterwards.
  const accepted = hub.prepare(
    `SELECT count(*) AS accepted FROM message_stats WHERE ts >= datetime('now', ?)`,
  ).get(`-${hours} hours`) as { accepted: number }

  // A limit is actually firing. The buckets live in the hub process and
  // nowhere else, so this is asked rather than computed — the same reasoning
  // that put provenance on /api/v1/capabilities instead of deriving it here.
  let limiters: unknown = null
  let refusals: unknown = null
  let limitersError: string | null = null
  try {
    const res = await fetch(`${hubRestBase()}/api/v1/limits`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const body = (await res.json()) as { limiters: unknown; refusals: unknown }
      limiters = body.limiters
      refusals = body.refusals
    }
    else limitersError = `hub answered ${res.status}`
  } catch (err) {
    // **Named, not silently zero.** "The hub did not answer" and "no limit has
    // fired" are different facts, and a screen showing 0 for both is telling an
    // operator the mesh is calm while it is unreachable.
    limitersError = err instanceof Error ? err.message : String(err)
  }

  return c.json({
    ok: true,
    hours,
    keys_awaiting_decision: { waiting: keys.waiting, oldest: keys.oldest },
    // The queue beside it. Same shape as its neighbour rather than the
    // `{ value }` the behaviour route uses — one name written both ways would
    // disagree with whatever sits next to it in one of the two places.
    users_awaiting_decision: (() => {
      try {
        const waiting = listPendingApprovals() as Array<{ requested_at?: string }>
        const stamps = waiting
          .map((row) => (row.requested_at ? parseSqliteUtc(row.requested_at) : NaN))
          .filter((ms) => Number.isFinite(ms))
        return { waiting: waiting.length, oldest: stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : null }
      } catch {
        return { waiting: null, oldest: null }
      }
    })(),
    lanes_not_draining: lanes,
    lanes_not_draining_total: lanesTotal,
    lanes_not_draining_shown: lanes.length,
    messages_accepted: accepted.accepted,
    rate_limits: limiters,
    // Signature refusals by reason (§ 8.1) and egress refusals by group pair
    // (§ 12), counted in the hub process since it started. In memory rather
    // than in the audit store: a signature refusal is the one event an
    // unauthenticated caller can produce at will, so a row per refusal is a
    // disk-filler handed to anyone who can open a socket.
    refusals,
    rate_limits_error: limitersError,
  })
})

app.get('/api/v1/admin/tenants', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.TENANT_READ_STATS)
  if (typeof actor !== 'string') return actor

  // A window rather than all time. "How much traffic" is a question about a
  // period, and a total since the beginning answers it only on the first day.
  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? 24) || 24, 1), 24 * 90)
  const since = `-${hours} hours`

  const rows = getHubDb()
    .prepare(
      `SELECT tenant,
              COUNT(*)                                    AS received,
              COUNT(DISTINCT to_agent)                    AS recipients,
              COUNT(DISTINCT from_agent)                  AS senders,
              SUM(CASE WHEN via = 'mailbox' THEN 1 ELSE 0 END) AS via_mailbox,
              MAX(ts)                                     AS last_at
         FROM message_stats
        WHERE ts >= datetime('now', ?)
        GROUP BY tenant
        ORDER BY received DESC`,
    )
    .all(since)

  return c.json({ ok: true, hours, tenants: rows })
})

app.get('/api/v1/admin/grants', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.ROLE_GRANT)
  if (typeof actor !== 'string') return actor

  const subject = c.req.query('subject')
  const capability = c.req.query('capability')
  const db = agentsDb()

  if (subject) return c.json({ ok: true, grants: grants.listFor(db, subject) })
  if (capability) {
    if (!(ALL_CAPABILITIES as readonly string[]).includes(capability)) {
      return c.json({ ok: false, error: `unknown capability: ${capability}`, capabilities: ALL_CAPABILITIES }, 400)
    }
    return c.json({
      ok: true,
      capability,
      subjects: grants.subjectsWith(db, capability as Capability),
    })
  }

  // Neither filter: the whole map, plus the vocabulary. A screen building a
  // matrix needs the columns as much as the cells, and reading them from a
  // response beats a copy of the list compiled into the front end — which is
  // how a capability added here would quietly never appear there.
  return c.json({
    ok: true,
    capabilities: ALL_CAPABILITIES,
    grants: ALL_CAPABILITIES.flatMap((cap) =>
      grants.subjectsWith(agentsDb(), cap as Capability).map((s) => ({ capability: cap, ...s })),
    ),
  })
})

app.post('/api/v1/admin/grants', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.ROLE_GRANT)
  if (typeof actor !== 'string') return actor

  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const { subject, capability, scope } = body ?? {}
  if (typeof subject !== 'string' || !subject) {
    return c.json({ ok: false, error: 'subject is required' }, 400)
  }
  if (!(ALL_CAPABILITIES as readonly string[]).includes(capability)) {
    return c.json({ ok: false, error: `unknown capability: ${capability}`, capabilities: ALL_CAPABILITIES }, 400)
  }

  // `grantedBy` is the actor, never something the caller states. A grant whose
  // author is self-reported records whatever the author wanted recorded.
  grants.grant(agentsDb(), { subject, capability, scope, grantedBy: actor })
  return c.json({ ok: true, subject, capability, scope: scope ?? SCOPE_TENANT }, 201)
})

app.delete('/api/v1/admin/grants', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.ROLE_GRANT)
  if (typeof actor !== 'string') return actor

  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid JSON body' }, 400) }
  const { subject, capability, scope } = body ?? {}
  if (typeof subject !== 'string' || typeof capability !== 'string') {
    return c.json({ ok: false, error: 'subject and capability are required' }, 400)
  }

  const removed = grants.revoke(agentsDb(), { subject, capability, scope })
  // `false` is "there was nothing to remove", which is not an error: an
  // operator revoking twice, or racing another, wanted the same end state and
  // has it.
  return c.json({ ok: true, action: removed ? 'deleted' : 'not-found' })
})

app.get('/api/v1/admin/agent-sources', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.SOURCE_READ)
  if (typeof actor !== 'string') return actor

  const identity = c.req.query('identity')
  if (identity !== undefined && !IDENTITY_RE.test(identity)) {
    return c.json({ ok: false, error: 'invalid identity format' }, 400)
  }

  const db = agentsDb()
  const rows = identity
    ? db.prepare(
        `SELECT identity, observed, first_seen, last_seen, requests
           FROM agent_sources WHERE identity = ? ORDER BY last_seen DESC`,
      ).all(identity)
    : db.prepare(
        `SELECT identity, observed, first_seen, last_seen, requests
           FROM agent_sources ORDER BY last_seen DESC LIMIT 500`,
      ).all()

  // How many there are, because the list above stops at 500. A screen drawing
  // 500 rows out of 3000 reports a smaller fleet than the one running, and no
  // field in the response contradicted it.
  const sourcesTotal = identity
    ? rows.length
    : (db.prepare(`SELECT count(*) AS n FROM agent_sources`).get() as { n: number }).n

  // Read from the running hub rather than from a constant here: the two
  // processes are configured separately, and reporting this one's idea of the
  // mode would describe a deployment that may not be the one answering.
  let mode: string | null = null
  try {
    const res = await fetch(`${HUB_HTTP_URL}/api/v1/capabilities`)
    if (res.ok) mode = ((await res.json()) as any)?.surface?.observed_source ?? null
  } catch {
    // The hub being unreachable is not a reason to withhold the rows; it is a
    // reason to say the mode is unknown, which is different from `socket`.
  }

  return c.json({
    ok: true,
    observed_source: mode,
    // Spelled out rather than left for a UI to infer from the mode string.
    // The qualifier is the part that is easy to drop, and dropping it turns a
    // header value into an observation.
    evidence_note:
      mode === 'forwarded'
        ? 'Addresses come from X-Forwarded-For via a trusted proxy. They are evidence only while the hub is unreachable except through that proxy, which the hub cannot verify.'
        : mode === 'socket'
          ? 'Addresses are the kernel-observed peer of each connection.'
          : 'The hub did not answer; the mode is unknown.',
    sources: rows,
    sources_total: sourcesTotal,
    sources_shown: rows.length,
  })
})

app.get('/api/v1/admin/mailbox', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.MAILBOX_READ_DEPTH)
  if (typeof actor !== 'string') return actor

  const rows = getHubDb().prepare(`
    SELECT to_agent AS identity,
           count(*) AS pending,
           sum(CASE WHEN leased_until IS NOT NULL AND leased_until >= datetime('now') THEN 1 ELSE 0 END) AS leased,
           min(ts) AS oldest
      FROM messages
     WHERE status = 'pending'
     GROUP BY to_agent
     ORDER BY pending DESC
  `).all()
  // Counted here rather than summed by the reader.
  //
  // The console summed the rows itself, over a field named `depth` that this
  // route has never emitted, so its "messages queued" tile read `0` whether the
  // mesh was idle or backed up. A total the caller derives is a total the caller
  // can derive from the wrong column, and `0` is the answer that looks calm.
  //
  // Its own `count(*)`, not a sum of the grouped rows: the two agree today
  // because nothing above limits the grouping, and a `LIMIT` added later would
  // make the sum quietly small while this stays right.
  const total = getHubDb()
    .prepare(`SELECT count(*) AS n FROM messages WHERE status = 'pending'`)
    .get() as { n: number }
  return c.json({ ok: true, mailboxes: rows, total_queued: total.n })
})

app.get('/api/v1/admin/mailbox/:identity', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.MAILBOX_READ_DEPTH)
  if (typeof actor !== 'string') return actor

  const identity = c.req.param('identity')
  if (!IDENTITY_RE.test(identity)) {
    return c.json({ ok: false, error: 'invalid identity format' }, 400)
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500)

  // `leased` is reported because an operator asking "why is this agent not
  // receiving" needs to tell an empty queue from one held entirely under
  // leases by a caller that died.
  const messages = getHubDb().prepare(`
    SELECT id, from_agent AS "from", ts, length(content) AS size,
           (leased_until IS NOT NULL AND leased_until >= datetime('now')) AS leased
      FROM messages
     WHERE to_agent = ? AND status = 'pending'
     ORDER BY ts ASC
     LIMIT ?
  `).all(identity, limit) as Array<Record<string, unknown>>

  return c.json({
    ok: true,
    identity,
    messages: messages.map((m) => ({ ...m, leased: m.leased === 1 })),
  })
})

/**
 * The agent type registry (SPEC § 10.3).
 *
 * § 10.3 says types are added "through the http admin surface, behind the same
 * gate as key approval" — and until now there was no such route, so the only
 * way to add one was SQL against `agents.db`. The registry was dynamic on the
 * read side and manual on the write side.
 *
 * It cannot live on the hub for the same reason teardown cannot: `POST
 * /api/v1/agents` is unauthenticated, so a type-creating endpoint beside it
 * would make the type check meaningless — any caller could invent a type and
 * register under it.
 */
app.get('/api/v1/admin/agent-types', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION)
  if (typeof actor !== 'string') return actor
  return c.json({ ok: true, types: agentsSchema.listTypes(agentsDb()) })
})

/**
 * Admit a person to this deployment with a password nobody chose.
 *
 * **The password is in this response and nowhere else.** Not in the listing,
 * not in a read, not in the log. What is stored is its hash, so it cannot be
 * recovered from the database either — an operator who loses it admits the
 * account again. The way this property breaks is a second route being helpful,
 * so the listing below is tested for its absence rather than trusted.
 *
 * The account is flagged, so its first login lands on the change screen and can
 * do nothing else until it passes — the same gate the seeded admin goes
 * through, rather than a second path beside it.
 */
app.post('/api/v1/admin/users', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.USER_ADMIT)
  if (typeof actor !== 'string') return actor

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400)
  }
  const username = body?.username
  if (typeof username !== 'string' || !IDENTITY_RE.test(username)) {
    return c.json({ ok: false, error: 'username must match ^[A-Za-z0-9][A-Za-z0-9-]*$' }, 400)
  }
  if (getLocalUser(username)) {
    return c.json({ ok: false, error: `a local account named '${username}' already exists` }, 409)
  }

  // The admitting operator's own tenant unless they name one. A tenant admin
  // creating people can only put them where they are, and that is enforced by
  // what this reads rather than by what the screen sends.
  const actorRow = getLocalUser(actor)
  const tenant = typeof body?.tenant === 'string' ? body.tenant : (actorRow?.tenant ?? 'default')

  const { user, temporaryPassword } = await admitLocalUser({
    username,
    displayName: typeof body?.display_name === 'string' ? body.display_name : undefined,
    tenant,
    role: typeof body?.role === 'string' ? body.role : undefined,
  })
  log.info(`${actor} admitted ${username} to tenant ${tenant}`, 'user_admitted', {
    id: username,
    actor,
    tenant,
  })

  return c.json(
    {
      ok: true,
      user: { username: user.username, display_name: user.display_name, tenant: user.tenant, role: user.role },
      temporary_password: temporaryPassword,
    },
    201,
  )
})

/**
 * Hand an existing account a new temporary password.
 *
 * **Admission was the only thing that ever issued one**, and it answers `409`
 * to a name that already exists — so an account whose holder forgot their
 * password had no route at all. `agent-mesh-local-pm` found it by walking a new
 * account through its whole first day and measuring the reissue as `409`.
 *
 * `404` rather than `409` when the name is unknown: admission refuses because
 * somebody is already there, this refuses because nobody is. Two different
 * absences, and answering them the same way would tell an operator to look for
 * the wrong thing.
 *
 * The account goes back behind the first-login gate. An operator reading a
 * password out loud is handing over a way in for one login, not a password.
 */
app.post('/api/v1/admin/users/:username/password', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.USER_ADMIT)
  if (typeof actor !== 'string') return actor

  const username = c.req.param('username')
  const temporary = await issueTemporaryPassword(username)
  if (temporary === null) {
    return c.json({ ok: false, error: `no local account named '${username}'` }, 404)
  }

  log.info(`${actor} reissued a temporary password for ${username}`, 'password_reissued', {
    id: username,
    actor,
  })
  return c.json({ ok: true, username, temporary_password: temporary, must_change_password: true }, 200)
})

/** Who has a local account. Never any password material — see the route above. */
app.get('/api/v1/admin/users', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.USER_ADMIT)
  if (typeof actor !== 'string') return actor
  return c.json({ ok: true, users: listLocalUsers() })
})

app.post('/api/v1/admin/agent-types', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION)
  if (typeof actor !== 'string') return actor

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const type = body.type
  if (typeof type !== 'string' || !IDENTITY_RE.test(type)) {
    return c.json({ ok: false, error: 'type must match ^[A-Za-z0-9][A-Za-z0-9-]*$' }, 400)
  }
  // Defaults to 1. A type that needs no key is the exception — `service` and
  // `human` — and the safe direction for anything unstated is to require one.
  const requiresKey = body.requires_key === 0 || body.requires_key === false ? 0 : 1
  const description = typeof body.description === 'string' ? body.description : null

  const row = agentsSchema.addType(agentsDb(), type, description, requiresKey)
  if (!row) {
    return c.json({ ok: false, error: `type '${type}' already exists`, code: 'TYPE_EXISTS' }, 409)
  }
  log.info(`${actor} added the agent type ${type}`, 'agent_type_added', {
    id: type,
    actor,
    requires_key: requiresKey,
  })
  return c.json({ ok: true, type: row }, 201)
})

app.delete('/api/v1/admin/agent-types/:type', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION)
  if (typeof actor !== 'string') return actor

  const type = c.req.param('type')
  const result = agentsSchema.removeType(agentsDb(), type)
  if (!result.removed && result.inUseBy.length > 0) {
    return c.json({
      ok: false,
      error: `type '${type}' is carried by ${result.inUseBy.length} identity/identities`,
      code: 'TYPE_IN_USE',
      identities: result.inUseBy.slice(0, 20),
    }, 409)
  }
  if (!result.removed) {
    return c.json({ ok: true, type, action: 'not-found' })
  }
  log.info(`${actor} removed the agent type ${type}`, 'agent_type_removed', {
    id: type,
    actor,
  })
  // `deleted`, not `removed`: one clause, one word. Four delete routes had
  // four vocabularies for the same two outcomes.
  return c.json({ ok: true, type, action: 'deleted' })
})

/**
 * `DELETE /api/v1/admin/agents/{identity}` (SPEC § 9.3).
 *
 * On this service and not the hub, for exactly the reason § 10.2 gives for key
 * approval: the hub cannot authenticate a caller, so a destructive route there
 * is reachable by anyone who can reach the port. Teardown is the most
 * destructive route in the system — it revokes every key and § 9.3 forbids
 * re-registering the name afterwards, so recovery means editing the database by
 * hand.
 *
 * The admin's login is recorded as the actor on every key event. That is not
 * bookkeeping: § 10.2 requires each transition to say who caused it, and the
 * unauthenticated version could only ever write `"hub"`.
 */
app.delete('/api/v1/admin/agents/:identity', async (c) => {
  const identity = c.req.param('identity')

  // **Authenticate before validating.** An earlier draft checked the name
  // first, reasoning that a malformed one is not a scope anything could have
  // been granted over — which is true and beside the point. It made an
  // unauthenticated caller receive `400` instead of `401`, so the route
  // answered a question about its input to somebody who had not identified
  // themselves. `auth-sweep` refuses that on every non-public route, and
  // caught this.
  //
  // § 11.3. Scoped to this identity, not to the tenant: an agent operator may
  // tear down what they own, and a tenant-wide grant still satisfies it.
  //
  // **Ownership is checked, not assumed from the capability.** Holding
  // `agent.teardown` scoped to `lane-a` says nothing about `lane-b`, and § 9.3
  // is irreversible — the name is never usable again, so a teardown reaching
  // one identity too far cannot be undone.
  const actor = await requireCapability(c, CAPABILITY.AGENT_TEARDOWN, identity)
  if (typeof actor !== 'string') {
    // A scoped holder who is also an owner passes on ownership instead. The
    // capability check above answers the tenant-wide and per-identity grants;
    // this answers "it is mine".
    const payload = await extractJwt(c)
    const subject = payload?.github_login as string | undefined
    const owns =
      !!subject &&
      grants.hasAny(agentsDb(), subject, CAPABILITY.AGENT_TEARDOWN) &&
      ownership.isOwner(agentsDb(), subject, identity)
    // The group-manager path (§ 12). It asks the question the earlier draft
    // could not: `group.manage` **scoped to the group this agent is in**.
    //
    // Tenant-wide `group.manage` deliberately does not satisfy it. Every
    // seeded admin holds that, and accepting it would make this a second,
    // wider grant of teardown wearing a different name — which is exactly
    // what the first version did before groups existed.
    const managesGroup =
      !!subject &&
      grants.has(agentsDb(), subject, CAPABILITY.GROUP_MANAGE,
        groupsStore.groupOf(agentsDb(), identity)) &&
      !grants.has(agentsDb(), subject, CAPABILITY.GROUP_MANAGE, SCOPE_TENANT)
    if (!owns && !managesGroup) return actor
    if (!IDENTITY_RE.test(identity)) return badIdentity(c)
    return teardownAs(c, subject!, identity)
  }
  if (!IDENTITY_RE.test(identity)) return badIdentity(c)
  return teardownAs(c, actor, identity)
})

/**
 * Every store this process opens, and the function that closes it.
 *
 * `audit.db` appears once here and is opened twice — read-only by the query
 * path and read-write by the access log — so both handles are named. The
 * second was the one that went unclosed.
 */
const SHUTDOWN_CLOSERS: ReadonlyArray<readonly [string, () => void]> = [
  ['messages', closeDb],
  ['agents', closeAgentsDb],
  ['blobs', closeBlobDb],
  ['audit (reads)', closeAuditDb],
  ['audit (access log)', closeAuditAccessLog],
]

/** The agents store, named short because these routes use it constantly. */
const db_ = () => agentsDb()

const badIdentity = (c: any) =>
  c.json({ ok: false, error: 'invalid identity format (must match ^[A-Za-z0-9][A-Za-z0-9-]*$)' }, 400)

async function teardownAs(c: any, actor: string, identity: string) {

  let result
  try {
    result = teardown.teardownIdentity(agentsDb(), identity, actor)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`the teardown of ${identity} failed`, 'teardown_failed', {
      id: identity,
      actor,
      outcome: 'failed',
      reason: 'db_error',
      error: msg,
    })
    return c.json({ ok: false, error: `db error: ${msg}` }, 500)
  }

  if (result.action === 'soft-deleted') {
    log.info(`${actor} tore down ${identity}`, 'teardown_done', {
      id: identity,
      actor,
      outcome: 'soft_deleted',
      revoked: result.revoked.length,
    })
  }
  return c.json({
    ok: true,
    identity: result.identity,
    action: result.action,
    ...(result.deletedAt !== undefined ? { deleted_at: result.deletedAt } : {}),
  })
}

app.post('/api/v1/admin/approve', async (c) => {
  // § 11: admitting a person is its own capability. It is not role.grant —
  // that hands capabilities to somebody already admitted — and not
  // agent.provision, which claims a mesh identity. This route was on the role
  // check until user.admit existed to move it to.
  const actor = await requireCapability(c, CAPABILITY.USER_ADMIT)
  if (typeof actor !== 'string') return actor
  void actor

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const githubLogin = body.github_login as string | undefined
  if (!githubLogin || typeof githubLogin !== 'string') {
    return c.json({ error: 'Missing or invalid "github_login" field' }, 400)
  }

  const updated = dbApproveUser(githubLogin)
  if (!updated) {
    return c.json({ error: `No pending approval found for "${githubLogin}"` }, 404)
  }

  // Add to registry with channel:"web", type:"user"
  upsertApprovedWebUser(githubLogin)

  // ...and as a mesh identity, which is what makes them a participant rather
  // than a name the hub routes without recognising. Best-effort: approval must
  // not fail because the hub is briefly unreachable, and the reconnect backfill
  // retries.
  const provisioned = await provisionHuman(githubLogin)
  if (!provisioned.ok) {
    log.warn(`approved ${githubLogin}, but the mesh identity could not be registered`, 'identity_registration_failed', {
      actor: githubLogin,
      outcome: 'failed',
      reason: 'hub_refused',
      detail: provisioned.reason,
    })
  }
  // Without this the person could not be spoken for until this server next
  // reconnected — approved in the UI and unable to send.
  await redeclareProxies().catch(() => {})

  // Grant wildcard messaging policy
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, '*')`).run(githubLogin)

  return c.json({ ok: true, github_login: githubLogin, status: 'approved' })
})

app.post('/api/v1/admin/deny', async (c) => {
  // § 11: admitting a person is its own capability. It is not role.grant —
  // that hands capabilities to somebody already admitted — and not
  // agent.provision, which claims a mesh identity. This route was on the role
  // check until user.admit existed to move it to.
  const actor = await requireCapability(c, CAPABILITY.USER_ADMIT)
  if (typeof actor !== 'string') return actor
  void actor

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const githubLogin = body.github_login as string | undefined
  if (!githubLogin || typeof githubLogin !== 'string') {
    return c.json({ error: 'Missing or invalid "github_login" field' }, 400)
  }

  const updated = dbDenyUser(githubLogin)
  if (!updated) {
    return c.json({ error: `No pending approval found for "${githubLogin}"` }, 404)
  }

  return c.json({ ok: true, github_login: githubLogin, status: 'denied' })
})

// --- Admin: Chat Audits (read-only view of hub.db messages) ---

app.get('/api/v1/admin/chat-audits', async (c) => {
  // **§ 11.0 and § 8.9.5, neither of which this route observed.** It serves
  // `content` — whole message bodies — behind a role check, so every
  // admin-role session read every conversation on the mesh and nothing
  // recorded that it had. The capability note is explicit that holding
  // `audit.read.content` is defensible and holding it without the record is
  // not. This held neither.
  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_CONTENT)
  if (typeof actor !== 'string') return actor
  const refused = logContentRead(c, actor, true, 'chat-audits:list', c.req.query())
  if (refused) return refused

  const r = listChatAudits(getHubDb, c.req.query())
  return c.json(r.body, r.status)
})

app.get('/api/v1/admin/chat-audits/stream', async (c) => {
  // **§ 11.0 and § 8.9.5, neither of which this route observed.** It serves
  // `content` — whole message bodies — behind a role check, so every
  // admin-role session read every conversation on the mesh and nothing
  // recorded that it had. The capability note is explicit that holding
  // `audit.read.content` is defensible and holding it without the record is
  // not. This held neither.
  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_CONTENT)
  if (typeof actor !== 'string') return actor
  const refused = logContentRead(c, actor, true, 'chat-audits:stream', c.req.query())
  if (refused) return refused

  const q = c.req.query()
  const fromAgent = typeof q.from_agent === 'string' && q.from_agent ? q.from_agent : null
  const toAgent = typeof q.to_agent === 'string' && q.to_agent ? q.to_agent : null
  const search = typeof q.search === 'string' && q.search ? q.search : null

  // Last-Event-ID: browsers auto-attach the last seen `id:` on reconnect.
  // Also allow ?last_event_id=... for curl / manual clients.
  const lastEventIdHeader = c.req.header('Last-Event-ID') ?? c.req.header('last-event-id') ?? null
  const lastEventIdQuery = typeof q.last_event_id === 'string' && q.last_event_id ? q.last_event_id : null
  const lastEventId = (lastEventIdHeader ?? lastEventIdQuery) || null

  const encoder = new TextEncoder()
  let client: AuditSseClient | null = null
  let stopKeepalive: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      client = {
        controller,
        filters: { from_agent: fromAgent, to_agent: toAgent, search },
      }
      addAuditSseClient(client)
      // Initial comment so clients observe connection open
      try { controller.enqueue(encoder.encode(`:connected\n\n`)) } catch {}

      // --- Gap fetch: if client sent Last-Event-ID, replay messages newer than it.
      if (lastEventId) {
        try {
          const db = getHubDb()
          const anchor = db.query('SELECT ts FROM messages WHERE id = ?').get(lastEventId) as { ts: string } | undefined
          if (anchor) {
            // Count-first to decide whether to send full gap or a summary event.
            const where: string[] = ['(ts > ? OR (ts = ? AND id > ?))']
            const params: any[] = [anchor.ts, anchor.ts, lastEventId]
            if (fromAgent) { where.push('from_agent = ?'); params.push(fromAgent) }
            if (toAgent)   { where.push('to_agent = ?');   params.push(toAgent) }
            if (search)    { where.push('content LIKE ?'); params.push('%' + search + '%') }
            const whereClause = 'WHERE ' + where.join(' AND ')
            const countRow = db.query(`SELECT COUNT(*) AS n FROM messages ${whereClause}`).get(...params) as { n: number }
            const gapCount = Number(countRow?.n ?? 0)
            if (gapCount > 100) {
              const summary = encoder.encode(`event: gap-too-large\ndata: ${JSON.stringify({ count: gapCount, truncated: true, last_event_id: lastEventId })}\n\n`)
              try { controller.enqueue(summary) } catch {}
              log.info(`the gap is ${gapCount} messages, so a summary was sent instead`, 'audit_gap_summary', {
                id: lastEventId,
                gap: gapCount,
                outcome: 'summarised',
                reason: 'gap_too_large',
              })
            } else if (gapCount > 0) {
              const sql = `SELECT id, from_agent, to_agent, content, reply_to, status, ts FROM messages ${whereClause} ORDER BY ts ASC, id ASC LIMIT 100`
              const rows = db.query(sql).all(...params) as Array<{
                id: string; from_agent: string; to_agent: string; content: string
                reply_to: string | null; status: string | null; ts: string
              }>
              for (const r of rows) {
                const m = { id: r.id, from_agent: r.from_agent, to_agent: r.to_agent, content: r.content ?? '', reply_to: r.reply_to ?? null, status: r.status ?? null, ts: r.ts }
                const pkt = encoder.encode(`id: ${sseSafeId(m.id)}\nevent: message\ndata: ${JSON.stringify(Object.assign({}, m, { recovered: true }))}\n\n`)
                try { controller.enqueue(pkt) } catch {}
              }
              log.info(`sent ${rows.length} message(s) a reconnecting console had missed`, 'audit_gap_fetch', {
                id: lastEventId,
                count: rows.length,
                outcome: 'sent',
              })
            }
          } else {
            log.info('the anchor a console reconnected with is not in the store, so no gap was fetched', 'audit_gap_skipped', {
              id: lastEventId,
              outcome: 'skipped',
              reason: 'anchor_not_found',
            })
          }
        } catch (err) {
          log.error('the gap fetch failed, and the stream stays open', 'audit_gap_failed', {
            id: lastEventId,
            outcome: 'failed',
            reason: 'store_unreadable',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // A comment frame, so a proxy counting bytes does not call this idle.
      stopKeepalive = startStreamKeepalive(
        () => controller.enqueue(encoder.encode(`:keepalive\n\n`)),
        30000,
      )
    },
    cancel() {
      stopKeepalive?.()
      if (client) removeAuditSseClient(client)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

app.get('/api/v1/admin/chat-audits/agents', async (c) => {
  // Which identities appear in the audit, with no body attached — the metadata
  // half of § 11's boundary, so the metadata capability is the gate.
  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_METADATA)
  if (typeof actor !== 'string') return actor
  void actor
  const r = auditAgents(getHubDb)
  return c.json(r.body, r.status)
})

// --- AI Usage (task #79) ---
// 맥허브 ai-usage-monitor가 이 엔드포인트로 snapshot을 5분마다 push한다.
// Admin Panel UI는 /api/v1/admin/ai-usage(GET) + /stream(SSE)으로 구독한다.

app.post('/api/v1/ingest/ai-usage', async (c) => {
  const token = process.env.AI_USAGE_INGEST_TOKEN
  if (!token) {
    return c.json({ error: 'ingest disabled (AI_USAGE_INGEST_TOKEN not set)' }, 503)
  }
  // **Restored.** `af4b159` deleted these four lines while its subject was a
  // front-end fixture, and the comment it left behind described what it had
  // done rather than why — a mutation that reached `main` and stayed there for
  // three days. With the token configured, which is what turns ingest on, any
  // caller with any token or none could write the AI-usage figures the admin
  // screens read.
  //
  // Compared in constant time, because the alternative leaks the token one
  // byte at a time to whoever is willing to time the answers.
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? ''
  if (!timingSafeEqualString(auth ?? '', `Bearer ${token}`)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Body must be an object' }, 422)
  }
  if (body.schema_version !== 'v1') {
    return c.json({ error: 'Unsupported schema_version (expected "v1")' }, 422)
  }
  if (!Array.isArray(body.accounts) || body.accounts.length < 1) {
    return c.json({ error: 'accounts must be a non-empty array' }, 422)
  }
  if (typeof body.ts !== 'string' || typeof body.source !== 'string') {
    return c.json({ error: 'ts and source must be strings' }, 422)
  }

  const snapshot: AiUsageSnapshot = {
    ts: body.ts,
    schema_version: body.schema_version,
    source: body.source,
    accounts: body.accounts as AiUsageAccount[],
    last_updated_at: new Date().toISOString(),
  }
  latestAiUsageSnapshot = snapshot
  broadcastAiUsage(snapshot)
  log.info(`accepted an ai-usage snapshot from ${snapshot.source}`, 'ai_usage_snapshot', {
    actor: snapshot.source,
    accounts: snapshot.accounts.length,
    snapshot_ts: snapshot.ts,
  })
  return c.json({ ok: true, accepted_at: snapshot.last_updated_at })
})

/**
 * The six behavioural metrics `/platform/telemetry` draws (§ D-1, `SC-SCR10-01`).
 *
 * **Nothing new is counted here.** Five of the six were already recorded — the
 * hub's `recordRefusal` has counted signature and egress refusals since it was
 * written, the limiters carry their own stats, and `keys/pending` has always
 * answered. What was missing was a route that put them where a screen could
 * reach them, which is why this is a gather rather than an instrument.
 *
 * Behind `usage.read` because it is the same question as the AI usage panel
 * beside it: what has this deployment been doing. The hub's own
 * `/api/v1/limits` is unauthenticated and stays so — it carries counts and no
 * identities, and § 11 governs anything keyed on *who*.
 *
 * Every value is nullable and no absence is filled in. Four of these six read
 * `0` when everything is well, so a zero produced by a source that could not be
 * reached is the one wrong number an operator has no reason to question.
 */
app.get('/api/v1/admin/telemetry/behaviour', async (c) => {
  const actor = await requireCapability(c, CAPABILITY.USAGE_READ)
  if (typeof actor !== 'string') return actor

  const limits = await fetch(`${HUB_HTTP_URL}/api/v1/limits`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

  const read = readBehaviour({
    pendingKeys: listPendingKeys,
    pendingApprovals: listPendingApprovals,
    openHub: getHubDb,
    now: () => Date.now(),
  })

  return c.json({ ok: true, ...shapeMetrics({ limits, ...read }) })
})

app.get('/api/v1/admin/ai-usage', async (c) => {
  // § 11: spend is not the audit trail and not tenant message traffic, so it
  // has its own capability rather than borrowing one that answers a different
  // question.
  const actor = await requireCapability(c, CAPABILITY.USAGE_READ)
  if (typeof actor !== 'string') return actor
  void actor
  return c.json({ snapshot: latestAiUsageSnapshot })
})

app.get('/api/v1/admin/ai-usage/stream', async (c) => {
  // § 11: spend is not the audit trail and not tenant message traffic, so it
  // has its own capability rather than borrowing one that answers a different
  // question.
  const actor = await requireCapability(c, CAPABILITY.USAGE_READ)
  if (typeof actor !== 'string') return actor
  void actor

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController | null = null
  let stopHeartbeat: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller
      addAiUsageSseClient(controller)
      try { controller.enqueue(encoder.encode(`:connected\n\n`)) } catch {}

      // Initial push: current snapshot if available
      if (latestAiUsageSnapshot) {
        try {
          controller.enqueue(encoder.encode(`event: ai-usage-update\ndata: ${JSON.stringify(latestAiUsageSnapshot)}\n\n`))
        } catch {}
      }

      // A named `ping`, which this stream's clients read as one.
      stopHeartbeat = startStreamKeepalive(
        () => controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`)),
        20000,
      )
    },
    cancel() {
      stopHeartbeat?.()
      if (controllerRef) removeAiUsageSseClient(controllerRef)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// --- Admin UI ---

app.get('/admin', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) return c.redirect('/')
  if (payload.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)

  return c.html(renderAdminPage())
})

// (Search route moved before :agent route)

// --- File Upload ---

/**
 * Where this server is reachable from other machines (SPEC § 15.2).
 *
 * `download_url` MUST be absolute: a lane VM resolves it against its own origin
 * otherwise and gets a 404 on a route it does not serve. That is the identical
 * failure the hub already had for blob uploads, found in integration rather
 * than in either repository's tests, because each side agreed with itself.
 *
 * Defaults to loopback on the configured port, which is right for a single-host
 * deployment and wrong for every other one — so a cross-VM deployment sets it.
 */
const PUBLIC_URL = (
  process.env.AGENT_MESH_HTTP_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '')

const UPLOAD_DIR = join(STATE_DIR, 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

/**
 * § 15.2. Ten mebibytes, and the slack the multipart envelope adds on top.
 *
 * The envelope carries a boundary and per-part headers, so a request whose
 * body is exactly the limit describes a file slightly under it. Bounding the
 * envelope bounds the file, which is what can be checked before reading.
 *
 * Overridable because the refusal path is only reachable by exceeding it, and
 * a test that has to send ten megabytes to reach it is one that runs slowly
 * enough to be skipped.
 */
const UPLOAD_MAX_BYTES = parseInt(process.env.AGENT_MESH_UPLOAD_MAX_BYTES ?? '', 10) || 10 * 1024 * 1024
const UPLOAD_ENVELOPE_SLACK = 64 * 1024

/**
 * Refuse an upload without materialising it.
 *
 * The goal was memory: an oversized upload used to be parsed into memory by
 * `formData()` and copied again by `arrayBuffer()` before anything checked its
 * size. Deciding from `Content-Length` keeps that from happening, and it is
 * kept.
 *
 * **The connection is left unusable, and there is no clean fix in this stack.**
 * The client is mid-send; whatever it has already written sits in the socket
 * and is read as the start of the next request, which then fails to parse. All
 * three answers were tried:
 *
 *   - `body.cancel()` — disposes of this side, does not stop the sender.
 *   - `Connection: close` — the correct HTTP answer; this stack ignores it.
 *   - draining the body — leaves the server waiting on a sender that may never
 *     finish, which is a worse failure than the one being fixed.
 *
 * So: refuse early, and a caller that has been refused must open a new
 * connection rather than reuse this one. Recorded in docs/deferred.md, because
 * it is a real edge and pretending otherwise is how it becomes somebody's
 * afternoon — it cost one here, presenting as "the server crashes on large
 * uploads". It does not crash.
 */
async function refuseUpload(c: any, status: number, error: string) {
  try { await c.req.raw.body?.cancel() } catch { /* already gone */ }
  return c.json({ error }, status)
}

app.post('/api/v1/upload', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  // **Refuse on the declaration, before the body is read** (§ 15.2).
  //
  // `c.req.formData()` parses the whole multipart body into memory before
  // anything can look at it, and `file.arrayBuffer()` then copied it again —
  // so a 100 MiB upload cost 200 MiB and the size check ran after both. A
  // handful of concurrent uploads took the process down.
  //
  // Content-Length is checked first because it is the only bound available
  // *before* accepting bytes. It is a claim, so the real count is enforced
  // below as well; the declaration is the part that is easy to get right by
  // accident, and the part an honest client always sends.
  const declared = c.req.header('content-length')
  if (declared === undefined) {
    return refuseUpload(c, 411, 'Content-Length is required')
  }
  const declaredSize = Number(declared)
  if (!Number.isInteger(declaredSize) || declaredSize < 0) {
    return refuseUpload(c, 400, 'Content-Length must be a non-negative integer')
  }
  // The multipart envelope adds boundary and headers, so the declared body is
  // larger than the file. Bounding the envelope bounds the file.
  if (declaredSize > UPLOAD_MAX_BYTES + UPLOAD_ENVELOPE_SLACK) {
    return refuseUpload(c, 413, `File too large (max ${UPLOAD_MAX_BYTES} bytes)`)
  }

  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }

  if (file.size > UPLOAD_MAX_BYTES) {
    return c.json({ error: `File too large (max ${UPLOAD_MAX_BYTES} bytes)` }, 413)
  }

  // Hash by streaming rather than materialising a second copy. The parser
  // already holds one; there is no reason for this to hold another.
  const hash = createHash('sha256')
  const chunks: Uint8Array[] = []
  for await (const chunk of file.stream() as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    chunks.push(chunk)
  }
  const sha256 = hash.digest('hex')
  const bytes = Buffer.concat(chunks)

  // Opaque content-addressed id (SPEC §15.2). Preserve original extension for
  // best-effort MIME inference on the GET side.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const extMatch = safeName.match(/(\.[a-zA-Z0-9]{1,16})$/)
  const ext = extMatch ? extMatch[1]!.toLowerCase() : ''
  const id = ext ? `${sha256}${ext}` : sha256
  const filePath = join(UPLOAD_DIR, id)

  if (!existsSync(filePath)) {
    writeFileSync(filePath, bytes)
  }

  const mime = getMimeType(filePath)
  const uploaded_at = new Date().toISOString()

  return c.json({
    ok: true,
    // New SPEC §15.2 attachment metadata shape (also serves as upload response)
    id,
    name: file.name,
    mime,
    size: file.size,
    sha256,
    download_url: `${PUBLIC_URL}/api/v1/attachments/${id}`,
    uploaded_at,
    // Backward-compat fields (deprecated — single-host legacy clients only)
    file_path: filePath,
    filename: file.name,
  })
})

// --- Attachment pull-on-demand (SPEC § 15) ---
// Lane VMs fetch attachments by id from the core VM's primary store.
// v0.1 internal-mesh: unauthenticated, assumed to live on a trusted
// internal network. Future profiles MAY require a bearer token.
// Accept opaque sha256 hex ids (v0.1 contract), optionally with a short
// extension suffix (`<sha256>.<ext>`), or legacy `<ts>-<safe-name>` ids for
// pre-hash uploads (backward compat).
const SHA256_ID_RE = /^[0-9a-f]{64}(?:\.[a-zA-Z0-9]{1,16})?$/
const LEGACY_ID_RE = /^[0-9]+-[a-zA-Z0-9._-]+$/

/**
 * The identity behind an attachment request, person or agent (SPEC § 15.3).
 *
 * A person arrives with the session cookie. An agent signs the request the way
 * § 9.2.1 defines, with its own domain separator, and this verifies it against
 * the key the operator approved.
 *
 * **No nonce window here, and that is a stated limit rather than an
 * oversight.** § 8.1's window lives in the hub, and standing up a second one
 * in this process would be a second thing to get right. Without it a captured
 * signature is replayable for the freshness window — which grants exactly what
 * the original granted: reading bytes that caller was already entitled to
 * read. A download is idempotent, so replay adds nothing a retry would not.
 * The same shortcut would not be acceptable on anything that writes.
 */
async function attachmentCaller(
  c: any,
): Promise<{ identity: string } | { refusal: 401 | 403 }> {
  const session = await extractJwt(c)
  if (session) {
    // Authenticated but not approved is `403`, not `401`. They proved who they
    // are; what they lack is permission, and telling them to sign in sends
    // them to fix the wrong thing.
    return isUserApproved(session.github_login, session.role)
      ? { identity: session.github_login as string }
      : { refusal: 403 }
  }

  const header = c.req.header('authorization')
  if (!header) return { refusal: 401 }
  const auth = parseRestAuthorization(header)
  if (!auth) return { refusal: 401 }
  if (Math.abs(Math.floor(Date.now() / 1000) - auth.iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {
    return { refusal: 401 }
  }

  const db = agentsDb()
  const identity = keys.identityForFingerprint(db, auth.kid)
  if (!identity) return { refusal: 401 }

  const url = new URL(c.req.url)
  const outcome = verify.verifyForIdentity(
    db,
    identity,
    auth.kid,
    restSignaturePreimage({
      method: 'GET',
      path: url.pathname + url.search,
      kid: auth.kid,
      nonce: auth.nonce,
      iat: auth.iat,
      // A `GET` has no body, and § 9.2.1 spells that as the empty string
      // rather than the digest of nothing — the two are different bytes and a
      // client following the contract sends the first.
      bodySha256: '',
    }),
    auth.signature,
  )
  return outcome.ok ? { identity } : { refusal: 401 }
}

app.get('/api/v1/attachments/:id', async (c) => {
  const id = c.req.param('id')
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return c.json({ error: 'Invalid attachment id' }, 400)
  }
  // Primary gate: id MUST match sha256 format or legacy format. Anything else
  // is rejected before touching the filesystem.
  if (!SHA256_ID_RE.test(id) && !LEGACY_ID_RE.test(id)) {
    return c.json({ error: 'Invalid attachment id format' }, 400)
  }

  // § 15.3. Sender or recipient of a message carrying it — agent or person.
  //
  // The route was open on the reasoning that a content-addressed id is
  // unguessable and therefore a capability. That holds until the id appears in
  // a log line, an audit event or a forwarded `download_url`, and a capability
  // that travels inside the thing it protects cannot be withdrawn.
  const called = await attachmentCaller(c)
  if ('refusal' in called) {
    return c.json(
      called.refusal === 403
        ? { error: 'Account pending approval' }
        : { error: 'Unauthorized — sign in, or sign the request (SPEC § 9.2.1)' },
      called.refusal,
    )
  }
  const caller = called.identity
  if (!attachmentAccess.mayDownload(getHubDb(), caller, id)) {
    // Deliberately the same answer whether the attachment exists or the caller
    // is not party to it. Distinguishing them would turn this route into a
    // probe for which digests the mesh holds.
    return c.json({ error: 'Not found' }, 404)
  }

  const filePath = join(UPLOAD_DIR, id)
  if (!existsSync(filePath)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const { statSync } = require('fs') as typeof import('fs')
  const stat = statSync(filePath)
  if (!stat.isFile()) {
    return c.json({ error: 'Not a file' }, 400)
  }

  const contentType = getMimeType(filePath)
  // Best-effort display filename. For sha256 ids we lost the original name on
  // disk; legacy `<ts>-<name>` ids preserved it. Use sha256 itself otherwise.
  let filename = id
  if (LEGACY_ID_RE.test(id)) {
    const dashIdx = id.indexOf('-')
    filename = dashIdx > 0 ? id.slice(dashIdx + 1) : id
  }

  // Stream via Bun.file when available (avoids loading full body into RAM).
  // Falls back to readFileSync for non-bun runtimes.
  const file = (globalThis as any).Bun?.file
    ? (globalThis as any).Bun.file(filePath)
    : null
  const body: BodyInit = file
    ? (file.stream() as ReadableStream)
    : (new Uint8Array(readFileSync(filePath)) as unknown as BodyInit)

  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(stat.size),
    },
  })
})

// --- PWA support ---

app.get('/sw.js', (c) => {
  const sw = `
const CACHE_VERSION = '${BUILD_VERSION}';
const CACHE_NAME = 'mesh-' + CACHE_VERSION;

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first strategy — always get fresh content
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Agent Mesh', body: 'New message' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.svg',
      badge: '/icon-192.svg',
      tag: 'mesh-' + (data.data?.agent || 'default'),
      renotify: true,
      data: data.data || {},
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const agent = e.notification.data?.agent || '';
  const url = agent ? '/chat/' + encodeURIComponent(agent) : '/chat';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // Try to reuse existing window — use postMessage instead of navigate()
      // to avoid Chrome Android showing its "URL copy" notification
      for (const c of list) {
        try {
          c.postMessage({ type: 'navigate', url });
          return c.focus();
        } catch {}
      }
      // No existing window — open new one
      return clients.openWindow(url);
    })
  );
});
`
  return new Response(sw, {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
  })
})

app.get('/manifest.json', (c) => {
  return c.json({
    name: IS_DEV ? 'Agent Mesh (DEV)' : 'Agent Mesh',
    short_name: IS_DEV ? 'Mesh-dev' : 'Mesh',
    description: 'Multi-agent communication hub',
    start_url: '/chat',
    display: 'standalone',
    background_color: THEME.bg,
    theme_color: THEME.bg,
    icons: [
      { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
      { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
    ],
  })
})

const meshIconSvg = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.15)}" fill="#1a1a2e"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.4}" fill="#e94560"/>
  <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-weight="bold" font-size="${Math.round(size * 0.45)}" fill="#fff">M</text>
</svg>`

app.get('/icon-192.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml')
  return c.body(meshIconSvg(192))
})

app.get('/icon-512.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml')
  return c.body(meshIconSvg(512))
})

// --- Push Notification API ---

app.get('/api/v1/push/vapid-key', (c) => {
  return c.json({ publicKey: VAPID_PUBLIC_KEY || null })
})

app.post('/api/v1/push/subscribe', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Approval, not merely a session (§ 9.1). These two were the only `JWT`
  // routes that stopped at `extractJwt`, so a user whose access an operator has
  // not granted could still register a delivery endpoint against this
  // deployment — and would then be holding a subscription for a mesh they
  // cannot read.
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const subscription = body.subscription as { endpoint?: string, keys?: { p256dh?: string, auth?: string } } | undefined
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return c.json({ error: 'Missing subscription data (endpoint, keys.p256dh, keys.auth)' }, 400)
  }

  savePushSubscription(payload.github_login, {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
  })

  return c.json({ ok: true })
})

app.post('/api/v1/push/unsubscribe', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Approval, not merely a session (§ 9.1). These two were the only `JWT`
  // routes that stopped at `extractJwt`, so a user whose access an operator has
  // not granted could still register a delivery endpoint against this
  // deployment — and would then be holding a subscription for a mesh they
  // cannot read.
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const endpoint = body.endpoint as string | undefined
  if (!endpoint) {
    return c.json({ error: 'Missing endpoint' }, 400)
  }

  deletePushSubscription(endpoint)
  return c.json({ ok: true })
})

// --- 404 fallback ---

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

// --- Global error handler ---

app.onError((err, c) => {
  log.error('a request handler threw, so the caller is answered a 500', 'unhandled_error', {
    route: new URL(c.req.url).pathname,
    outcome: 'failed',
    reason: 'unhandled_exception',
    error: err instanceof Error ? err.message : String(err),
  })
  return c.json({ error: 'Internal server error' }, 500)
})

// --- Start server ---

/**
 * What a served process does before it answers anything, exported so a test
 * calling `app.fetch` can put the database in the same state.
 *
 * Ordering is the content here, not the list. Seeded users are web users and
 * must exist before `proxy_for` is declared — on a first boot the seed used to
 * run long after the hub connect, leaving the seeded admin unable to send until
 * the next restart. And § 11's grants are seeded **after** the users exist:
 * seeding grants against an empty table produces an admin who can do nothing,
 * every route answering 403 with the cause three hundred lines away.
 */
export async function startup(): Promise<void> {
  await seedLocalUsers()
  seedLegacyAdminGrants()
  await redeclareProxies().catch(() => {})
  // hub.db audit poller (1.5 s), so Chat Audits SSE carries every agent-mesh
  // conversation rather than only the sir-mirr proxy channel.
  startAuditPoller()
}

// **Everything below runs only when this file is the program.**
//
// It used to run on import, so importing this module bound port 3000 and
// seeded a database — which is why `test/harness.ts` spawns the service as a
// process rather than importing it, and why no coverage instrument has ever
// seen a line of the three thousand above: they execute in a child process.
// Behind this guard the routes can be exercised in-process with
// `app.fetch(request)`, while the spawned suite goes on testing the wiring
// that only a real process has — ports, signals, restart.
//
// Nothing imported this module before, so the guard changes no caller.
if (import.meta.main) {
  log.info(`agent-mesh-http: starting on port ${PORT}`, 'http_starting', {
    port: PORT,
    state_dir: STATE_DIR,
  })

  await startup()

  const server = Bun.serve({
    port: PORT,
    fetch: app.fetch,
    idleTimeout: 255, // max value, prevents SSE connection drops
  })

  log.info(`agent-mesh-http: listening on http://localhost:${server.port}`, 'http_listening', {
    port: server.port,
  })

  // The counters, into the same record as the lines. There is no metrics
  // endpoint here and journald is the record, so `journalctl -u agent-mesh-http
  // | grep counter_snapshot` is how an operator asks whether a path ran at all.
  const stopCounterSnapshots = startCounterHeartbeat(log, {
    intervalMs: Number(process.env.AGENT_MESH_COUNTER_SNAPSHOT_MS ?? 900_000),
  })

  // Graceful shutdown. The list is a value rather than a run of statements
  // because the defect here was an omission — `closeAuditAccessLog` imported
  // and never called — and `test/shutdown-closers.test.ts` checks this list
  // against the closers this file imports.
  const shutdown = (): void => runShutdown({
    closers: [
      ['counter snapshots', stopCounterSnapshots],
      ['the audit poller', stopAuditPoller],
      ...SHUTDOWN_CLOSERS,
    ],
    stop: () => server.stop(),
    exit: (code) => process.exit(code),
  })

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

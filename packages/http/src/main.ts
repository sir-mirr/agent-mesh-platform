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
try {
  const envPath = process.env.AGENT_MESH_ENV_FILE ?? process.env.AGENT_MESH_HTTP_ENV_FILE
  if (envPath) {
    const envContent = readFs(envPath, 'utf8')
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx)
        const val = trimmed.slice(eqIdx + 1)
        if (!process.env[key]) process.env[key] = val
      }
    }
  }
} catch {}

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import { randomBytes, createHash } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
} from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openStore, type MessageRow } from '@agent-mesh/store'
import { provisionHuman, provisionAllHumans, provisionSelf } from './provision'
import { listPending as listPendingKeys, keyHistory, decide as decideKey, closeAgentsDb } from './keys-admin'
import { insertMessage, getMessageHistory, getConversation, searchMessages, closeDb, upsertUser, getUser, isAllowedToMessage, createPendingApproval, getPendingApproval, listPendingApprovals, approveUser as dbApproveUser, denyUser as dbDenyUser, getDb, savePushSubscription, getPushSubscriptions, deletePushSubscription, verifyLocalUser, seedLocalUsers, listRegistryAgents, getRegistryAgent, countRegistryAgents, listRegistryAgentIds, listApprovedWebUserIds, isRegistryAgentApproved, upsertApprovedWebUser, type DbMessage } from './db'
import webpush from 'web-push'
import { renderAdminPage } from './ui/admin'
import { renderAgentNotFoundPage, renderChatPage, renderPendingApprovalPage } from './ui/chat'
import { renderLandingPage } from './ui/landing'
import { BUILD_VERSION, IS_DEV, THEME } from './ui/theme'
import { getGithubAuthUrl, exchangeCodeForToken, getGithubUser, signJwt, verifyJwt, type JwtPayload } from './auth'

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
const HUB_IDENTITY = 'http-server' + (IS_DEV ? '-dev' : '')
let hubWs: WebSocket | null = null
let hubConnected = false

function connectToHub(): void {
  try {
    hubWs = new WebSocket(HUB_URL)
    hubWs.onopen = async () => {
      hubConnected = true
      console.log(`[http-server] connected to hub at ${HUB_URL}`)

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
        console.warn(`[http-server] could not register own identity: ${self.reason}`)
      }
      const webUsers = listApprovedWebUserIds()
      await provisionAllHumans(webUsers)

      hubWs!.send(JSON.stringify({
        jsonrpc: '2.0', method: 'mesh.connect',
        params: { identity: HUB_IDENTITY, description: 'Agent Mesh Web UI', proxy_for: webUsers },
        id: 1,
      }))
      if (webUsers.length > 0) {
        console.log(`[http-server] proxying for: ${webUsers.join(', ')}`)
      }
    }
    hubWs.onmessage = (e) => {
      try {
        const raw = typeof e.data === 'string' ? e.data : String(e.data)
        const data = JSON.parse(raw)
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
            content: msg.content ?? '',
            reply_to: msg.reply_to ?? null,
            status: 'delivered',
            ts: msg.ts,
          })
          // 3. Send push notification
          sendPushNotificationForMessage(msg.to, msg.from, msg.content)
          console.log(`[http-server] hub→sse: ${msg.from} → ${msg.to}`)
        }
        if (data.method === 'mesh.delivered' && data.params) {
          const d = data.params
          console.log(`[http-server] mesh.delivered: ${d.from} → ${d.to} (${d.id}), pushing to SSE key ${d.to}:${d.from}`)
          // Notify sender's SSE that message was delivered (show typing indicator)
          pushToSSE(d.to, d.from, 'delivered', { id: d.id, to: d.to, ts: d.ts })
        }
      } catch {}
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

connectToHub()

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

function hasActiveSSE(toUser: string): boolean {
  for (const [key, set] of sseClients) {
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

function addAuditSseClient(c: AuditSseClient): void {
  auditSseClients.add(c)
  if (auditSseClients.size > 50) {
    console.warn(`[chat-audits/stream] high client count: ${auditSseClients.size}`)
  }
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

function startAuditPoller(): void {
  if (auditPollerInterval) return
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
    console.log(`[http-server] audit poller initial last ts=${lastSeenMessageTs} id=${lastSeenMessageId}`)
  } catch (err) {
    console.error('[http-server] audit poller init error:', err)
    lastSeenMessageTs = '1970-01-01 00:00:00'
    lastSeenMessageId = ''
  }

  auditPollerInterval = setInterval(() => {
    try {
      const db = getHubDb()
      const rows = db.prepare(`
        SELECT id, from_agent, to_agent, content, reply_to, status, ts
          FROM messages
         WHERE (ts > $ts) OR (ts = $ts AND id > $id)
         ORDER BY ts ASC, id ASC
         LIMIT 200
      `).all({ $ts: lastSeenMessageTs, $id: lastSeenMessageId }) as MsgRow[]
      if (rows.length > 0) {
        console.log(`[http-server] audit poller picked ${rows.length} new rows`)
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
      }
    } catch (err) {
      console.error('[http-server] audit poller error:', err)
    }
  }, 1500)
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
  if (aiUsageSseClients.size > 50) {
    console.warn(`[ai-usage/stream] high client count: ${aiUsageSseClients.size}`)
  }
}

function removeAiUsageSseClient(c: ReadableStreamDefaultController): void {
  aiUsageSseClients.delete(c)
}

function broadcastAiUsage(snapshot: AiUsageSnapshot): void {
  if (aiUsageSseClients.size === 0) return
  const encoder = new TextEncoder()
  const payload = encoder.encode(`event: ai-usage-update\ndata: ${JSON.stringify(snapshot)}\n\n`)
  for (const controller of aiUsageSseClients) {
    try { controller.enqueue(payload) } catch { aiUsageSseClients.delete(controller) }
  }
}

function sendPushNotificationForMessage(toUser: string, fromAgent: string, content: string): void {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return
  // Skip push if user has active SSE connection (web/app is open)
  if (hasActiveSSE(toUser)) return
  try {
    const subs = getPushSubscriptions(toUser)
    if (subs.length === 0) return
    const payload = JSON.stringify({
      title: fromAgent,
      body: content.length > 100 ? content.slice(0, 100) + '...' : content,
      data: { agent: fromAgent, url: '/chat' },
    })
    for (const sub of subs) {
      webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, payload).catch(() => {
        deletePushSubscription(sub.endpoint)
      })
    }
    console.log(`agent-mesh-http: push sent to ${toUser} from ${fromAgent}`)
  } catch {}
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

function notifyApprovalRequest(githubLogin: string, _githubId: number): void {
  // Deployment-specific. Unset means approvals wait in /api/v1/admin/pending
  // without an out-of-band ping.
  if (!ADMIN_NOTIFY_IDENTITY) {
    console.log(`agent-mesh-http: approval pending for ${githubLogin}; AGENT_MESH_ADMIN_NOTIFY_IDENTITY unset, no notification sent`)
    return
  }
  const msg = `새 사용자 승인 요청: ${githubLogin} (GitHub). /api/v1/admin/pending에서 확인하세요.`
  sendViaHub(ADMIN_NOTIFY_IDENTITY, msg, 'system').catch(() => {
    console.error('agent-mesh-http: failed to send approval notification via hub')
  })
}

type Message = {
  id: string
  from: string
  to: string
  ts: string
  content: string
  reply_to?: string
  file_path?: string
  status: 'pending' | 'delivered' | 'read'
}

// --- Hono App ---

const app = new Hono()

// CORS — allow all origins (Phase 1)
app.use('/*', cors())

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

app.post('/auth/local', async (c) => {
  const body = await c.req.parseBody()
  const username = body.username as string
  const password = body.password as string

  if (!username || !password) {
    return c.redirect('/?error=missing')
  }

  const user = await verifyLocalUser(username, password)
  if (!user) {
    return c.redirect('/?error=invalid')
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
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/chat',
      'Set-Cookie': `mesh_token=${jwt}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    },
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
        'Set-Cookie': `mesh_token=${jwt}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return c.json({ error: 'OAuth callback failed', detail: message }, 500)
  }
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
    github_id: user.github_id,
    github_login: user.github_login,
    role: user.role,
    approved,
    created_at: user.created_at,
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

app.get('/api/v1/health', (c) => {
  const agentCount = countRegistryAgents()
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000)

  return c.json({
    status: 'ok',
    version: BUILD_VERSION,
    agent_count: agentCount,
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

  const agents = listRegistryAgents().map(entry => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    channel: entry.channel,
    type: entry.type,
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

  // Send via hub (best-effort — message is already persisted in SQLite)
  await sendViaHub(to, text, from, replyTo).catch(() => null)

  // Push to SSE clients so sender's UI updates immediately
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
  // Auth from query param (EventSource can't set headers)
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Missing token' }, 401)
  let payload: JwtPayload
  try { payload = await verifyJwt(token) } catch { return c.json({ error: 'Invalid token' }, 401) }
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

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        try { send('ping', { ts: Date.now() }) } catch { clearInterval(heartbeat) }
      }, 30000)

      // Cleanup on close
      c.req.raw.signal.addEventListener('abort', () => {
        removeSSEClient(agentId, userLogin, controller)
        clearInterval(heartbeat)
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

function isPathAllowed(filePath: string): boolean {
  // Resolve to absolute path and prevent traversal
  const { resolve } = require('path') as typeof import('path')
  const resolved = resolve(filePath)

  // Block path traversal attempts
  if (resolved !== filePath && filePath.includes('..')) {
    return false
  }

  return ALLOWED_FILE_PREFIXES.some(prefix => resolved.startsWith(prefix))
}

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

  // Security: validate path
  const { resolve } = require('path') as typeof import('path')
  const resolved = resolve(filePath)

  if (!isPathAllowed(resolved)) {
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
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const pending = listPendingApprovals()
  return c.json({ pending })
})

// --- Key approval (SPEC § 10.2) -------------------------------------------
//
// On this service rather than the hub because approval is the one step in the
// key lifecycle that must know who is asking. The hub cannot authenticate a
// caller, so an approval route there would let anyone reaching the port approve
// their own key.

/** Reject anything without a valid admin JWT. Returns the login, or the response. */
async function requireAdmin(c: any): Promise<string | Response> {
  const payload = await extractJwt(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (payload.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)
  return payload.github_login as string
}

app.get('/api/v1/admin/keys/pending', async (c) => {
  const actor = await requireAdmin(c)
  if (typeof actor !== 'string') return actor
  const r = listPendingKeys()
  return c.json(r.body, r.status as any)
})

app.get('/api/v1/admin/keys/:identity', async (c) => {
  const actor = await requireAdmin(c)
  if (typeof actor !== 'string') return actor
  const r = keyHistory(c.req.param('identity'))
  return c.json(r.body, r.status as any)
})

for (const decision of ['approve', 'deny', 'revoke'] as const) {
  app.post(`/api/v1/admin/keys/${decision}`, async (c) => {
    const actor = await requireAdmin(c)
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
      console.log(`[http-server] ${actor} ${decision}d key ${fingerprint}` + (reason ? ` (${reason})` : ''))
    }
    return c.json(r.body, r.status as any)
  })
}

app.post('/api/v1/admin/approve', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

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
    console.warn(`[http-server] approved ${githubLogin} but could not register the mesh identity: ${provisioned.reason}`)
  }

  // Grant wildcard messaging policy
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, '*')`).run(githubLogin)

  return c.json({ ok: true, github_login: githubLogin, status: 'approved' })
})

app.post('/api/v1/admin/deny', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

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
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const q = c.req.query()
  const beforeId = typeof q.before_id === 'string' && q.before_id ? q.before_id : null
  const fromAgent = typeof q.from_agent === 'string' && q.from_agent ? q.from_agent : null
  const toAgent = typeof q.to_agent === 'string' && q.to_agent ? q.to_agent : null
  const search = typeof q.search === 'string' && q.search ? q.search : null

  let limit = parseInt(q.limit ?? '100', 10)
  if (!Number.isFinite(limit) || limit <= 0) limit = 100
  if (limit > 200) limit = 200

  try {
    const db = getHubDb()

    // Resolve cursor: ts of before_id (if any). PK id is not sortable lexically,
    // so we anchor pagination on ts (+ id as secondary tiebreak).
    let cursorTs: string | null = null
    if (beforeId) {
      const row = db.query('SELECT ts FROM messages WHERE id = ?').get(beforeId) as { ts: string } | undefined
      if (row) cursorTs = row.ts
    }

    const where: string[] = []
    const params: any[] = []
    if (cursorTs !== null) {
      // Strictly older than cursor ts, or same ts but different id (strictly ordered).
      where.push('(ts < ? OR (ts = ? AND id < ?))')
      params.push(cursorTs, cursorTs, beforeId)
    }
    if (fromAgent) {
      where.push('from_agent = ?')
      params.push(fromAgent)
    }
    if (toAgent) {
      where.push('to_agent = ?')
      params.push(toAgent)
    }
    if (search) {
      where.push('content LIKE ?')
      params.push('%' + search + '%')
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''
    // Fetch limit+1 to detect has_more
    const sql = `SELECT id, from_agent, to_agent, content, reply_to, status, ts FROM messages ${whereClause} ORDER BY ts DESC, id DESC LIMIT ?`
    const rows = db.query(sql).all(...params, limit + 1) as Array<{
      id: string
      from_agent: string
      to_agent: string
      content: string
      reply_to: string | null
      status: string | null
      ts: string
    }>

    const hasMore = rows.length > limit
    const messages = hasMore ? rows.slice(0, limit) : rows
    const oldestId = messages.length > 0 ? messages[messages.length - 1]!.id : null

    return c.json({ messages, has_more: hasMore, oldest_id: oldestId })
  } catch (e: any) {
    console.error('[chat-audits] query failed:', e?.message ?? e)
    return c.json({ error: 'Failed to query chat audits', detail: String(e?.message ?? e) }, 500)
  }
})

app.get('/api/v1/admin/chat-audits/stream', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

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
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null

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
              console.log(`[chat-audits/stream] gap-too-large: ${gapCount} > 100, sent summary (last_event_id=${lastEventId})`)
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
              console.log(`[chat-audits/stream] gap fetch sent ${rows.length} msgs (last_event_id=${lastEventId})`)
            }
          } else {
            console.log(`[chat-audits/stream] last_event_id=${lastEventId} not found in hub.db (skipping gap fetch)`)
          }
        } catch (err) {
          console.error('[chat-audits/stream] gap fetch failed:', err)
        }
      }

      // 30s keepalive comment to keep proxies from closing the idle stream
      keepaliveInterval = setInterval(() => {
        try { controller.enqueue(encoder.encode(`:keepalive\n\n`)) } catch {
          if (keepaliveInterval) clearInterval(keepaliveInterval)
        }
      }, 30000)
    },
    cancel() {
      if (keepaliveInterval) clearInterval(keepaliveInterval)
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
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }
  try {
    const db = getHubDb()
    const rows = db.query(
      'SELECT DISTINCT a FROM (SELECT from_agent AS a FROM messages UNION SELECT to_agent AS a FROM messages) ORDER BY a COLLATE NOCASE'
    ).all() as Array<{ a: string }>
    return c.json({ agents: rows.map(r => r.a).filter(Boolean) })
  } catch (e: any) {
    console.error('[chat-audits/agents] query failed:', e?.message ?? e)
    return c.json({ agents: [] })
  }
})

// --- AI Usage (task #79) ---
// 맥허브 ai-usage-monitor가 이 엔드포인트로 snapshot을 5분마다 push한다.
// Admin Panel UI는 /api/v1/admin/ai-usage(GET) + /stream(SSE)으로 구독한다.

app.post('/api/v1/ingest/ai-usage', async (c) => {
  const token = process.env.AI_USAGE_INGEST_TOKEN
  if (!token) {
    return c.json({ error: 'ingest disabled (AI_USAGE_INGEST_TOKEN not set)' }, 503)
  }
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? ''
  const expected = `Bearer ${token}`
  if (auth !== expected) {
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
  console.log(`[ai-usage/ingest] snapshot accepted: source=${snapshot.source} accounts=${snapshot.accounts.length} ts=${snapshot.ts}`)
  return c.json({ ok: true, accepted_at: snapshot.last_updated_at })
})

app.get('/api/v1/admin/ai-usage', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }
  return c.json({ snapshot: latestAiUsageSnapshot })
})

app.get('/api/v1/admin/ai-usage/stream', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController | null = null
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null

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

      // 20s heartbeat — keep proxies from closing idle stream (ping event)
      heartbeatInterval = setInterval(() => {
        try { controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`)) } catch {
          if (heartbeatInterval) clearInterval(heartbeatInterval)
        }
      }, 20000)
    },
    cancel() {
      if (heartbeatInterval) clearInterval(heartbeatInterval)
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

const UPLOAD_DIR = join(STATE_DIR, 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

app.post('/api/v1/upload', async (c) => {
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {
    return c.json({ error: 'Account pending approval' }, 403)
  }

  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }

  if (file.size > 10 * 1024 * 1024) {
    return c.json({ error: 'File too large (max 10MB)' }, 413)
  }

  const buffer = await file.arrayBuffer()
  const bytes = Buffer.from(buffer)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

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
    download_url: `/api/v1/attachments/${id}`,
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

  const filePath = join(UPLOAD_DIR, id)
  if (!existsSync(filePath)) {
    return c.json({ error: 'Attachment not found' }, 404)
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
  console.error('agent-mesh-http: unhandled error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// --- Start server ---

console.log(`agent-mesh-http: starting on port ${PORT}`)
console.log(`agent-mesh-http: STATE_DIR = ${STATE_DIR}`)

// Seed default local admin user
await seedLocalUsers()

// Start hub.db audit poller (1.5s interval) so Chat Audits SSE captures
// all agent-mesh conversations, not just the sir-mirr proxy channel.
startAuditPoller()

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255, // max value, prevents SSE connection drops
})

console.log(`agent-mesh-http: listening on http://localhost:${server.port}`)

// Graceful shutdown
function shutdown(): void {
  console.log('agent-mesh-http: shutting down')
  closeDb()
  closeAgentsDb()
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

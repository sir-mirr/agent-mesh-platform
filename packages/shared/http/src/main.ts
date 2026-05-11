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
import { insertMessage, getMessageHistory, getConversation, searchMessages, closeDb, upsertUser, getUser, isAllowedToMessage, createPendingApproval, getPendingApproval, listPendingApprovals, approveUser as dbApproveUser, denyUser as dbDenyUser, getDb, savePushSubscription, getPushSubscriptions, deletePushSubscription, verifyLocalUser, seedLocalUsers, type DbMessage } from './db'
import webpush from 'web-push'
import { getGithubAuthUrl, exchangeCodeForToken, getGithubUser, signJwt, verifyJwt, type JwtPayload } from './auth'

// --- Configuration ---

const STATE_DIR = process.env.AGENT_MESH_STATE_DIR ?? '/srv/agent-mesh-lab/state/shared'
const PORT = parseInt(process.env.AGENT_MESH_HTTP_PORT ?? '3000', 10)
const REGISTRY_FILE = join(STATE_DIR, 'registry.json')
const HUB_DB_PATH = join(STATE_DIR, 'hub.db')
const startTime = Date.now()
const IS_DEV = process.env.NODE_ENV === 'development'

// --- Hub DB (read-only audit access) ---
let _hubDb: Database | null = null
function getHubDb(): Database {
  if (_hubDb) return _hubDb
  _hubDb = new Database(HUB_DB_PATH, { readonly: true })
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
    hubWs.onopen = () => {
      hubConnected = true
      console.log(`[http-server] connected to hub at ${HUB_URL}`)
      // Get web users from registry to proxy for them
      const reg = loadRegistry()
      const webUsers = Object.entries(reg.agents)
        .filter(([_, e]) => e.type === 'user' && e.approved)
        .map(([id]) => id)
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

type MsgRow = {
  id: string
  from_agent: string
  to_agent: string
  content: string
  reply_to: string | null
  status: string | null
  ts: string
}

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

const BUILD_VERSION = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) // e.g. "20260402081500"

// Dev environment uses lighter colors for visual distinction
const THEME = {
  bg: IS_DEV ? '#1e2a3a' : '#1a1a2e',
  sidebar: IS_DEV ? '#1a3050' : '#16213e',
  border: IS_DEV ? '#1a4070' : '#0f3460',
  accent: IS_DEV ? '#3498db' : '#e94560',
  envLabel: IS_DEV ? '<span style="font-size:0.7rem;background:#3498db;color:#fff;padding:2px 6px;border-radius:4px;margin-left:8px;">DEV</span>' : '',
}

// Ensure state directory exists
mkdirSync(STATE_DIR, { recursive: true })

// --- Registry helpers ---

type AgentEntry = {
  name: string
  description?: string
  channel?: string   // "native" | "web" | "discord"
  type?: string      // "agent" | "user"
  approved?: boolean
}

type Registry = {
  agents: Record<string, AgentEntry>
}

function loadRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Registry
    // Backward compatibility: fill in defaults for entries missing new fields
    for (const [id, entry] of Object.entries(raw.agents)) {
      if (entry.channel === undefined) entry.channel = 'native'
      if (entry.type === undefined) entry.type = 'agent'
      if (entry.approved === undefined) entry.approved = true
    }
    return raw
  } catch {
    return { agents: {} }
  }
}

function saveRegistry(reg: Registry): void {
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n')
}

function isUserApproved(githubLogin: string, role: string): boolean {
  // Admin is always approved
  if (role === 'admin') return true

  // Check registry
  const reg = loadRegistry()
  const entry = reg.agents[githubLogin]
  if (entry && entry.approved === true) return true

  // Check pending_approvals table
  const pending = getPendingApproval(githubLogin)
  if (pending && pending.status === 'approved') return true

  return false
}

function notifyApprovalRequest(githubLogin: string, _githubId: number): void {
  // Send notification via hub
  const msg = `새 사용자 승인 요청: ${githubLogin} (GitHub). /api/v1/admin/pending에서 확인하세요.`
  sendViaHub('arumi', msg, 'system').catch(() => {
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
  const error = c.req.query('error')
  const errorHtml = error === 'invalid'
    ? `<div style="color:${THEME.accent}; font-size:0.85rem; margin-top:8px;">Invalid username or password</div>`
    : error === 'missing'
      ? `<div style="color:${THEME.accent}; font-size:0.85rem; margin-top:8px;">Username and password are required</div>`
      : ''
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>L's Agent Mesh</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .container {
    text-align: center;
    padding: 40px;
  }
  h1 {
    font-size: 3rem;
    font-weight: 700;
    margin-bottom: 8px;
    background: linear-gradient(135deg, ${THEME.accent}, ${THEME.border});
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .subtitle {
    color: #aaa;
    font-size: 1.1rem;
    margin-bottom: 48px;
  }
  .login-btn {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 14px 32px;
    background: ${THEME.sidebar};
    color: #e0e0e0;
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    font-size: 1.1rem;
    text-decoration: none;
    transition: all 0.2s;
    cursor: pointer;
  }
  .login-btn:hover {
    background: ${THEME.border};
    border-color: ${THEME.accent};
    transform: translateY(-1px);
  }
  .login-btn.primary {
    background: linear-gradient(135deg, ${THEME.accent}, ${IS_DEV ? '#2980b9' : '#c73652'});
    border: none;
    color: #fff;
    font-weight: 600;
  }
  .login-btn.primary:hover {
    filter: brightness(1.1);
    transform: translateY(-1px);
  }
  .login-btn svg {
    width: 24px;
    height: 24px;
    fill: currentColor;
  }
</style>
</head>
<body>
  <div class="container">
    <h1>L's Agent Mesh${IS_DEV ? ' <span style="font-size:1rem;vertical-align:middle;background:#3498db;color:#fff;padding:4px 10px;border-radius:6px;">DEV</span>' : ''}</h1>
    <p class="subtitle">Multi-agent communication hub</p>
    <a href="/auth/github" class="login-btn primary">
      <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Login with GitHub
    </a>
    <div style="margin-top:32px; color:#555; font-size:0.9rem;">&mdash; or &mdash;</div>
    <form action="/auth/local" method="POST" style="margin-top:24px; display:flex; flex-direction:column; align-items:center; gap:12px; width:100%;">
      <input name="username" type="text" placeholder="Username" required style="width:280px; padding:14px 16px; background:${THEME.sidebar}; border:1px solid ${THEME.border}; border-radius:8px; color:#e0e0e0; font-size:1rem; outline:none;">
      <input name="password" type="password" placeholder="Password" required style="width:280px; padding:14px 16px; background:${THEME.sidebar}; border:1px solid ${THEME.border}; border-radius:8px; color:#e0e0e0; font-size:1rem; outline:none;">
      <button type="submit" class="login-btn" style="width:280px; justify-content:center;">Login</button>
    </form>
    ${errorHtml}
    <div style="margin-top:48px;color:#555;font-size:0.8rem;">Agent Mesh v2</div>
  </div>
</body>
</html>`)
})

// --- Chat Page ---

function renderPendingApprovalPage(user: { github_login: string; role: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh - Pending Approval</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .container {
    text-align: center;
    padding: 40px;
    max-width: 480px;
  }
  .avatar {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    border: 3px solid #0f3460;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 600;
    margin-bottom: 12px;
    color: #e94560;
  }
  .login-name {
    font-size: 1.1rem;
    color: #888;
    margin-bottom: 24px;
  }
  .status-msg {
    font-size: 1rem;
    color: #ccc;
    line-height: 1.6;
    margin-bottom: 32px;
  }
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid #555;
    border-top-color: #e94560;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    vertical-align: middle;
    margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .poll-status {
    font-size: 0.85rem;
    color: #555;
    margin-top: 8px;
  }
  .logout-btn {
    display: inline-block;
    padding: 8px 20px;
    background: #16213e;
    color: #888;
    border: 1px solid #0f3460;
    border-radius: 6px;
    text-decoration: none;
    font-size: 0.9rem;
    cursor: pointer;
    margin-top: 16px;
  }
  .logout-btn:hover { color: #e94560; border-color: #e94560; }
</style>
</head>
<body>
  <div class="container">
    <img class="avatar" src="https://github.com/${user.github_login}.png?size=160" alt="">
    <h1>승인 대기 중</h1>
    <div class="login-name">${user.github_login}</div>
    <div class="status-msg">
      접근 승인을 요청했습니다.<br>
      관리자의 승인을 기다려주세요.
    </div>
    <div>
      <span class="spinner"></span>
      <span class="poll-status" id="pollStatus">승인 여부 확인 중...</span>
    </div>
    <button class="logout-btn" onclick="document.cookie='mesh_token=; path=/; max-age=0'; location.href='/';">Logout</button>
  </div>
<script>
const TOKEN = document.cookie.split('; ').find(c => c.startsWith('mesh_token='))?.split('=').slice(1).join('=') || '';
async function checkApproval() {
  try {
    const res = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const data = await res.json();
    if (data.approved) {
      location.reload();
    }
  } catch(e) {}
}
setInterval(checkApproval, 5000);
</script>
</body>
</html>`
}

function renderAgentNotFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh - Not Found</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .container {
    text-align: center;
    padding: 40px;
    max-width: 480px;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 600;
    margin-bottom: 16px;
    color: ${THEME.accent};
  }
  .message {
    font-size: 1rem;
    color: #888;
    margin-bottom: 32px;
  }
  .home-btn {
    display: inline-block;
    padding: 12px 28px;
    background: ${THEME.sidebar};
    color: #e0e0e0;
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    font-size: 1rem;
    text-decoration: none;
    transition: all 0.2s;
  }
  .home-btn:hover {
    background: ${THEME.border};
    border-color: ${THEME.accent};
  }
</style>
</head>
<body>
  <div class="container">
    <h1>Agent Not Found</h1>
    <p class="message">등록된 에이전트가 없습니다</p>
    <a href="/chat" class="home-btn">홈으로</a>
  </div>
</body>
</html>`
}

function renderChatPage(user: { github_login: string; role: string }, initialAgent: string = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Agent Mesh - Chat</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    height: 100%;
    margin: 0;
  }
  body {
    display: flex;
    overflow: hidden;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }

  /* Sidebar */
  .sidebar {
    width: 260px;
    min-width: 260px;
    background: ${THEME.sidebar};
    border-right: 1px solid ${THEME.border};
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid #0f3460;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sidebar-header h2 {
    font-size: 1rem;
    color: ${THEME.accent};
    font-weight: 600;
  }
  .user-info {
    padding: 12px 16px;
    border-bottom: 1px solid ${THEME.border};
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.9rem;
  }
  .user-info img {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }
  .user-info .username {
    color: #ccc;
    flex: 1;
  }
  .logout-btn {
    color: #888;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 10px 12px;
    border-radius: 4px;
  }
  .logout-btn:hover { color: #e94560; background: #1a1a2e; }
  .agent-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .agent-item {
    padding: 12px 16px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: all 0.15s;
    font-size: 0.9rem;
    min-height: 44px;
  }
  .agent-item:hover {
    background: #1a1a2e;
  }
  .agent-item.active {
    background: ${IS_DEV ? '#1a2a40' : '#1a1a2e'};
    border-left-color: ${THEME.accent};
    border-left-width: 3px;
  }
  .agent-item .agent-name {
    font-weight: 500;
    font-size: 0.95rem;
  }
  .agent-item .agent-desc {
    font-size: 0.78rem;
    color: #999;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Main chat area */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  #chatArea {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .chat-header {
    padding: 14px 20px;
    border-bottom: 1px solid #0f3460;
    background: #16213e;
    font-weight: 600;
    font-size: 1rem;
  }
  .chat-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chat-messages::before {
    content: '';
    flex: 1;
  }
  .msg {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 0.9rem;
    line-height: 1.45;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .msg.sent {
    align-self: flex-end;
    background: ${IS_DEV ? '#1a3a5a' : '#0f3460'};
    border-bottom-right-radius: 4px;
  }
  .msg.received {
    align-self: flex-start;
    background: ${IS_DEV ? '#1a2a3a' : '#16213e'};
    border: 1px solid ${IS_DEV ? '#1a4070' : '#0f3460'};
    border-left: 3px solid ${IS_DEV ? '#2a6090' : '#1a4a70'};
    border-bottom-left-radius: 4px;
  }
  .msg .meta {
    font-size: 0.72rem;
    color: #999;
    margin-top: 4px;
  }
  .no-agent {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #555;
    font-size: 1.1rem;
  }

  /* Input area */
  .chat-input {
    padding: 12px 20px;
    border-top: 1px solid #0f3460;
    background: #16213e;
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-shrink: 0;   /* 보강: 키보드 열림 + 긴 목록 상황에서 컨테이너 축소 방지 */
  }
  .chat-input > #attachBtn,
  .chat-input > #sendBtn { flex-shrink: 0; }
  .input-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .file-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #0f3460;
    color: #e0e0e0;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 0.8rem;
    max-width: 220px;
  }
  .file-chip .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .file-chip .close {
    background: none;
    border: none;
    color: #bbb;
    cursor: pointer;
    padding: 0 2px;
    font-size: 0.9rem;
    line-height: 1;
    min-height: 0;
  }
  .file-chip .close:hover { color: #e94560; }
  .chat-input textarea {
    background: ${THEME.bg};
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    color: #e0e0e0;
    padding: 8px 12px;
    font-size: 16px;
    line-height: 1.45;
    font-family: inherit;
    resize: none;
    outline: none;
    min-height: 44px;
    max-height: 208px;
    overflow-y: hidden;
    touch-action: pan-y;
    width: 100%;
    box-sizing: border-box;
  }
  .chat-input textarea:focus {
    /* 포커스 halo: 브랜드 accent 35% opacity. 향후 에러 상태는 solid border로 분리 */
    border-color: ${THEME.border};
    box-shadow: 0 0 0 2px ${THEME.accent}59;
  }
  .chat-input button {
    padding: 12px 20px;
    background: ${IS_DEV ? '#2980b9' : 'linear-gradient(135deg, #3498db, #2980b9)'};
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.15s;
    white-space: nowrap;
    min-height: 44px;
  }
  .chat-input button:hover { background: ${IS_DEV ? '#2471a3' : '#2471a3'}; }
  .chat-input button:disabled { background: #555; cursor: not-allowed; opacity: 0.6; }
  /* Send 버튼: 44x44 아이콘 버튼 */
  .chat-input #sendBtn {
    padding: 0;
    width: 44px;
    min-width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .chat-input #sendBtn svg { width: 20px; height: 20px; }

  /* Search */
  .search-toggle-btn {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 6px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }
  .search-toggle-btn:hover { color: #e94560; background: #1a1a2e; }
  .search-panel {
    border-bottom: 1px solid #0f3460;
    padding: 8px 12px;
    background: #16213e;
  }
  .search-input-wrap {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search-input-wrap input {
    flex: 1;
    background: #1a1a2e;
    border: 1px solid #0f3460;
    border-radius: 6px;
    color: #e0e0e0;
    padding: 7px 10px;
    font-size: 0.85rem;
    outline: none;
  }
  .search-input-wrap input:focus { border-color: #e94560; }
  .search-go-btn {
    background: #0f3460;
    color: #e0e0e0;
    border: none;
    border-radius: 6px;
    padding: 7px 12px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .search-go-btn:hover { background: #e94560; }
  .search-close-btn {
    background: none;
    border: none;
    color: #888;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 4px 6px;
  }
  .search-close-btn:hover { color: #e94560; }
  .search-results {
    max-height: 300px;
    overflow-y: auto;
    margin-top: 6px;
  }
  .search-result-item {
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.82rem;
    border-bottom: 1px solid #0f346033;
  }
  .search-result-item:hover { background: #1a1a2e; }
  .search-result-item .sr-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
  }
  .search-result-item .sr-agent { color: #e94560; font-weight: 500; }
  .search-result-item .sr-time { color: #555; font-size: 0.75rem; }
  .search-result-item .sr-content {
    color: #aaa;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search-empty { color: #555; font-size: 0.82rem; padding: 12px 4px; text-align: center; }

  /* Unread badge */
  .unread-dot {
    background: #e94560;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-left: 8px;
    flex-shrink: 0;
  }
  .agent-item .agent-name-row {
    display: flex;
    align-items: center;
  }

  /* Date separator */
  .date-separator {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 12px 0 4px;
    font-size: 0.75rem;
    color: #777;
  }
  .date-separator::before,
  .date-separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #0f3460;
  }
  .date-separator span {
    white-space: nowrap;
  }

  /* Mobile */
  @media (max-width: 768px) {
    .sidebar { width: 200px; min-width: 200px; }
    .msg { max-width: 85%; }
  }
  @media (max-width: 520px) {
    body { flex-direction: column; }
    .sidebar {
      width: 100%;
      min-width: 100%;
      flex: 1;
      border-right: none;
      border-bottom: none;
      overflow-y: auto;
    }
    .sidebar.collapsed { display: none; }
    .main { flex: 1; min-height: 0; display: none; }
    .sidebar.collapsed + .main { display: flex; }
    .back-btn {
      display: inline-block;
      background: none;
      border: none;
      color: #e94560;
      font-size: 1.1rem;
      cursor: pointer;
      padding: 0 8px 0 0;
    }
    .chat-input {
      padding: 8px 12px;
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
    .chat-input textarea { min-height: 44px; max-height: 208px; font-size: 16px; }
  }
  @media (display-mode: standalone) {
    .chat-input {
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
  }
  @media (min-width: 521px) {
    .back-btn { display: none; }
  }
  .typing-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    color: #bbb;
    font-size: 0.85rem;
  }
  .typing-indicator .dots {
    display: flex;
    gap: 4px;
  }
  .typing-indicator .dots span {
    width: 8px;
    height: 8px;
    background: ${THEME.accent};
    border-radius: 50%;
    animation: typing-bounce 1.4s infinite ease-in-out;
  }
  .typing-indicator .dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator .dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing-bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
</style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <h2>Agent Mesh${THEME.envLabel}</h2>
      <button class="search-toggle-btn" onclick="toggleSearch()" title="Search messages">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </div>
    <div class="search-panel" id="searchPanel" style="display:none;">
      <div class="search-input-wrap">
        <input type="text" id="searchInput" placeholder="Search messages..." onkeydown="if(event.key==='Enter')doSearch()" />
        <button class="search-go-btn" onclick="doSearch()">Go</button>
        <button class="search-close-btn" onclick="toggleSearch()">&times;</button>
      </div>
      <div class="search-results" id="searchResults"></div>
    </div>
    <div class="user-info">
      <img id="avatar" src="https://github.com/${user.github_login}.png?size=56" alt="" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div style=\\'width:28px;height:28px;border-radius:50%;background:${THEME.border};display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:600;color:#e0e0e0;\\'>${user.github_login.charAt(0).toUpperCase()}</div>')">
      <span class="username">${user.github_login}</span>
      ${user.role === 'admin' ? '<a href="/admin" style="color:#888;font-size:0.8rem;padding:10px 8px;text-decoration:none;">Admin</a>' : ''}
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="agent-list" id="agentList">
      <div style="padding: 16px; color: #555; font-size: 0.85rem;">Loading agents...</div>
    </div>
  </div>

  <div class="main">
    <div class="chat-header" id="chatHeader" style="display:none;"><button class="back-btn" onclick="showSidebar()">&#9664;</button><span id="chatTitle"></span></div>
    <div id="chatArea">
      <div class="no-agent"></div>
    </div>
  </div>

<script>
const MY_LOGIN = '${user.github_login}';
const INITIAL_AGENT = '${initialAgent}';
const TOKEN = document.cookie.split('; ').find(c => c.startsWith('mesh_token='))?.split('=').slice(1).join('=') || '';

// --- KST timestamp helpers (Asia/Seoul, browser-locale independent via Intl) ---
function kstParts(isoOrSqliteUtc) {
  const s = String(isoOrSqliteUtc).trim();
  const withT = s.includes('T') ? s : s.replace(' ', 'T');
  const withZ = /Z$|[+-]\\d\\d:?\\d\\d$/.test(withT) ? withT : withT + 'Z';
  const d = new Date(withZ);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24, // Intl may give "24" for midnight in some locales; normalize
    minute: Number(get('minute')),
    second: Number(get('second')),
    date: d,
  };
}
function toKST(isoOrSqliteUtc) {
  const p = kstParts(isoOrSqliteUtc);
  if (!p) return String(isoOrSqliteUtc);
  const pad = n => String(n).padStart(2, '0');
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + ' ' +
         pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second) + ' KST';
}

let currentAgent = null;
let agents = [];
let eventSource = null;
let lastMsgCount = 0;
let lastMsgKey = '';
let isFirstLoad = true;
let agentLatestTs = {}; // { agentId: isoTimestamp } — latest message per agent

const headers = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// --- Unread tracking (localStorage) ---
function getLastReadTs() {
  try { return JSON.parse(localStorage.getItem('mesh_lastRead') || '{}'); } catch { return {}; }
}
function setLastReadTs(agentId, ts) {
  const data = getLastReadTs();
  data[agentId] = ts;
  localStorage.setItem('mesh_lastRead', JSON.stringify(data));
}
function hasUnread(agentId) {
  const latest = agentLatestTs[agentId];
  if (!latest) return false;
  const lastRead = getLastReadTs()[agentId];
  if (!lastRead) return true;
  return latest > lastRead;
}

async function loadAgents() {
  try {
    const res = await fetch('/api/v1/agents', { headers });
    const data = await res.json();
    agents = (data.agents || []).filter(a => a.id !== MY_LOGIN);
    // Fetch latest message ts for each agent (for unread dots)
    await refreshUnreadState();
    renderAgents();
  } catch(e) {
    document.getElementById('agentList').innerHTML = '<div style="padding:16px;color:#e94560;">Failed to load agents</div>';
  }
}

async function refreshUnreadState() {
  const promises = agents.map(async (a) => {
    try {
      const res = await fetch('/api/v1/messages/' + encodeURIComponent(a.id) + '?limit=10', { headers });
      const data = await res.json();
      const msgs = (data.messages || []).filter(m =>
        (m.from === a.id && m.to === MY_LOGIN) || (m.from === MY_LOGIN && m.to === a.id)
      );
      if (msgs.length > 0) {
        // Find the latest message from the OTHER agent (incoming)
        const incoming = msgs.filter(m => m.from === a.id);
        if (incoming.length > 0) {
          agentLatestTs[a.id] = incoming[incoming.length - 1].ts;
        }
      }
    } catch {}
  });
  await Promise.all(promises);
}

function renderAgents() {
  const el = document.getElementById('agentList');
  if (agents.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:#555;font-size:0.85rem;">No agents registered</div>';
    return;
  }
  const mobile = window.innerWidth <= 520;
  el.innerHTML = agents.map(a => {
    const dot = hasUnread(a.id) ? '<span class="unread-dot"></span>' : '';
    const inner = '<div class="agent-name-row"><span class="agent-name">' + escHtml(a.name) + '</span>' + dot + '</div>' +
      (a.description ? '<div class="agent-desc">' + escHtml(a.description) + '</div>' : '');
    if (mobile) {
      return '<a href="/chat/' + encodeURIComponent(a.id) + '" class="agent-item' + (currentAgent === a.id ? ' active' : '') + '" style="display:block;text-decoration:none;color:inherit;">' + inner + '</a>';
    }
    return '<div class="agent-item' + (currentAgent === a.id ? ' active' : '') + '" onclick="selectAgent(\\'' + a.id.replace(/'/g, "\\\\'") + '\\')">' + inner + '</div>';
  }).join('');
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

var pollTimer = null;
function connectSSE(agentId) {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  eventSource = new EventSource('/api/v1/events/' + encodeURIComponent(agentId) + '?token=' + encodeURIComponent(TOKEN));
  eventSource.addEventListener('message', function(e) {
    lastMsgCount = 0;
    lastMsgKey = '';
    try {
      var msg = JSON.parse(e.data);
      if (msg.from === agentId) hideTyping();
    } catch(err) { hideTyping(); }
    loadMessages();
  });
  eventSource.addEventListener('delivered', function(e) {
    showTyping();
  });
  eventSource.addEventListener('connected', function(e) {
    console.log('SSE connected for', agentId);
  });
  eventSource.onerror = function() {
    setTimeout(function() {
      if (currentAgent === agentId) connectSSE(agentId);
    }, 5000);
  };
  // Polling fallback: check for new messages every 5s in case SSE push is missed
  pollTimer = setInterval(function() {
    if (currentAgent === agentId) loadMessages();
  }, 5000);
}

function selectAgent(id, skipPush) {
  currentAgent = id;
  if (!skipPush) history.pushState({ view: 'chat', agent: id }, '', '/chat/' + encodeURIComponent(id));
  isFirstLoad = true;
  lastMsgCount = 0;
  lastMsgKey = '';
  // Mark as read
  setLastReadTs(id, new Date().toISOString());
  const agent = agents.find(a => a.id === id);
  document.getElementById('chatHeader').style.display = '';
  document.getElementById('chatTitle').textContent = agent ? agent.name + ' (' + id + ')' : id;
  renderAgents();
  showChatUI();
  loadMessages();
  connectSSE(id);
  // Mobile: collapse sidebar
  if (window.innerWidth <= 520) {
    document.querySelector('.sidebar').classList.add('collapsed');
  }
}

function closeChatToSidebar() {
  currentAgent = null;
  if (eventSource) { eventSource.close(); eventSource = null; }
  document.querySelector('.sidebar').classList.remove('collapsed');
  const header = document.getElementById('chatHeader');
  if (header) header.style.display = 'none';
  const area = document.getElementById('chatArea');
  if (area) area.innerHTML = '<div class="no-agent"></div>';
  renderAgents();
}

function showSidebar() {
  // popstate 컨텍스트 외 직접 호출(닫기 버튼 등) — history 추가 후 SPA 전환
  if (currentAgent !== null) {
    history.pushState(null, '', '/chat');
  }
  closeChatToSidebar();
}

function showChatUI() {
  document.getElementById('chatArea').innerHTML =
    '<div class="chat-messages" id="messages"></div>' +
    '<div id="typingIndicator" class="typing-indicator" style="display:none;">' +
      '<div class="dots"><span></span><span></span><span></span></div>' +
      '<span id="typingText">응답 대기 중...</span>' +
    '</div>' +
    '<input type="file" id="fileUploadInput" style="display:none;" onchange="onFileSelected(this)">' +
    '<div class="chat-input">' +
    '<button id="attachBtn" onclick="triggerFileUpload()" title="Attach file" style="background:none;border:1px solid #0f3460;border-radius:8px;color:#888;cursor:pointer;padding:10px 12px;font-size:1.1rem;min-height:44px;transition:all 0.15s;">&#x1F4CE;</button>' +
    '<div class="input-wrapper">' +
    '<div class="file-chip-row" id="fileChipRow" style="display:none;">' +
    '<span class="file-chip" id="fileChip"><span class="name" id="fileChipName"></span><button class="close" type="button" onclick="clearFileUpload()" aria-label="Remove file">&#x2715;</button></span>' +
    '</div>' +
    '<textarea id="msgInput" rows="1" placeholder="Message" onkeydown="handleKey(event)" oninput="updateSendBtnState(); autoResizeInput(this);"></textarea>' +
    '</div>' +
    '<button id="sendBtn" onclick="sendMessage()" disabled aria-label="Send"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg></button>' +
    '</div>';
  if (window.innerWidth > 520) {
    document.getElementById('msgInput').focus();   // 데스크톱만 자동 focus
  }
  updateSendBtnState();
}

function updateSendBtnState() {
  const input = document.getElementById('msgInput');
  const btn = document.getElementById('sendBtn');
  if (!input || !btn) return;
  btn.disabled = input.value.trim().length === 0;
}

let pendingFilePath = null;

function triggerFileUpload() {
  document.getElementById('fileUploadInput').click();
}

function onFileSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const row = document.getElementById('fileChipRow');
  const btn = document.getElementById('attachBtn');
  document.getElementById('fileChipName').textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + 'KB)';
  row.style.display = 'flex';
  btn.style.borderColor = '#e94560';
  btn.style.color = '#e94560';
}

function clearFileUpload() {
  const row = document.getElementById('fileChipRow');
  const btn = document.getElementById('attachBtn');
  document.getElementById('fileUploadInput').value = '';
  document.getElementById('fileChipName').textContent = '';
  row.style.display = 'none';
  btn.style.borderColor = '#0f3460';
  btn.style.color = '#888';
  pendingFilePath = null;
}

function clearFilePath() {
  document.getElementById('filePathInput').value = '';
  toggleFileInput();
}

// --- FR-017: Relative time + Date grouping (KST) ---
function relativeTime(ts) {
  const now = Date.now();
  const d = new Date(ts);
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return diffMin + '분 전';
  if (diffHr < 24) return diffHr + '시간 전';
  if (diffDay < 7) return diffDay + '일 전';
  const p = kstParts(ts);
  if (!p) return String(ts);
  const pad = n => String(n).padStart(2, '0');
  return pad(p.month) + '/' + pad(p.day) + ' ' + pad(p.hour) + ':' + pad(p.minute);
}

function dateSeparatorHtml(prevTs, currentTs) {
  const prev = prevTs ? kstParts(prevTs) : null;
  const cur = kstParts(currentTs);
  if (!cur) return '';
  // Check if same calendar day in KST
  if (prev && prev.year === cur.year && prev.month === cur.month && prev.day === cur.day) {
    return '';
  }
  const nowP = kstParts(new Date().toISOString());
  let diffDays = Infinity;
  if (nowP) {
    // Compute day diff from KST calendar date using UTC-midnight arithmetic on components
    const todayUtc = Date.UTC(nowP.year, nowP.month - 1, nowP.day);
    const curUtc = Date.UTC(cur.year, cur.month - 1, cur.day);
    diffDays = Math.round((todayUtc - curUtc) / 86400000);
  }
  let label;
  if (diffDays === 0) label = '오늘';
  else if (diffDays === 1) label = '어제';
  else label = cur.month + '월 ' + cur.day + '일';
  return '<div class="date-separator"><span>' + label + '</span></div>';
}

var typingTimer = null;
function showTyping() {
  var el = document.getElementById('typingIndicator');
  if (el) {
    var label = document.getElementById('typingText');
    if (label && currentAgent) {
      var agent = agents.find(function(a) { return a.id === currentAgent; });
      label.textContent = (agent ? agent.name : currentAgent) + ' 응답 중...';
    }
    el.style.display = 'flex';
    var msgEl = document.getElementById('messages');
    if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
  }
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(function() { hideTyping(); }, 60000);
}
function hideTyping() {
  var el = document.getElementById('typingIndicator');
  if (el) el.style.display = 'none';
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
}

async function loadMessages() {
  if (!currentAgent) return;
  try {
    const res = await fetch('/api/v1/messages/' + encodeURIComponent(currentAgent) + '?limit=100', { headers });
    const data = await res.json();
    const msgs = data.messages || [];
    // Update if messages changed (compare last message ID)
    const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
    const prevLastId = lastMsgCount > 0 ? String(lastMsgCount) : '';
    const newKey = msgs.length + ':' + lastId;
    if (newKey !== lastMsgKey) {
      // Check if the new message is from the agent (not from me)
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (lastMsg && lastMsg.from === currentAgent) hideTyping();
      lastMsgKey = newKey;
      lastMsgCount = msgs.length;
      renderMessages(msgs);
    }
    // Update unread tracking: mark latest incoming message ts
    const incoming = msgs.filter(m => m.from === currentAgent && m.to === MY_LOGIN);
    if (incoming.length > 0) {
      agentLatestTs[currentAgent] = incoming[incoming.length - 1].ts;
      // Since user is viewing, update lastRead
      setLastReadTs(currentAgent, new Date().toISOString());
    }
  } catch(e) {}
}

function renderMessages(msgs) {
  const el = document.getElementById('messages');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;

  // Filter messages relevant to this conversation (between user and agent)
  const relevant = msgs.filter(m =>
    (m.from === MY_LOGIN && m.to === currentAgent) ||
    (m.from === currentAgent && m.to === MY_LOGIN) ||
    (m.to === currentAgent && m.from === MY_LOGIN) ||
    (m.to === MY_LOGIN && m.from === currentAgent)
  );

  let html = '';
  let prevTs = null;
  for (let i = 0; i < relevant.length; i++) {
    const m = relevant[i];
    const isSent = m.from === MY_LOGIN;
    const timeStr = relativeTime(m.ts);
    const kp = kstParts(m.ts);
    const pad2 = n => String(n).padStart(2, '0');
    const absTime = kp ? (kp.month + '/' + kp.day + ' ' + pad2(kp.hour) + ':' + pad2(kp.minute) + ' KST') : String(m.ts);
    // Date separator
    const sep = dateSeparatorHtml(prevTs, m.ts);
    if (sep) html += sep;
    prevTs = m.ts;
    let fileHtml = '';
    if (m.file_path) {
      const fileName = m.file_path.split('/').pop() || m.file_path;
      fileHtml = '<div class="file-attachment" style="margin-top:6px;padding:6px 10px;background:rgba(15,52,96,0.5);border:1px solid #0f3460;border-radius:6px;font-size:0.82rem;">' +
        '<a href="#" onclick="event.preventDefault();window.open(\\'/api/v1/files?path=' + encodeURIComponent(m.file_path) + '\\',\\'_system\\');" style="color:#e94560;text-decoration:none;" title="' + escHtml(m.file_path) + '">&#x1F4CE; ' + escHtml(fileName) + '</a>' +
        '<span style="color:#555;margin-left:6px;font-family:monospace;font-size:0.75rem;">' + escHtml(m.file_path) + '</span>' +
        '</div>';
    }
    html += '<div class="msg ' + (isSent ? 'sent' : 'received') + '" data-msgid="' + escHtml(m.id) + '">' +
      escHtml(m.content) +
      fileHtml +
      '<div class="meta">' + (isSent ? 'You' : escHtml(m.from)) + ' &middot; ' + absTime + ' (' + timeStr + ')' + '</div>' +
      '</div>';
  }
  el.innerHTML = html;

  if (pendingScrollToMsg) {
    scrollToAndHighlight();
  } else if (isFirstLoad || wasAtBottom) {
    el.scrollTop = el.scrollHeight;
    isFirstLoad = false;
  }
}

async function sendMessage() {
  const input = document.getElementById('msgInput');
  const btn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('filePathInput');
  const text = input.value.trim();
  if (!text || !currentAgent) return;

  btn.disabled = true;
  input.value = '';
  input.style.height = '44px';

  const msgPayload = { to: currentAgent, text };

  try {
    // Upload file first if selected
    const fileEl = document.getElementById('fileUploadInput');
    if (fileEl && fileEl.files && fileEl.files[0]) {
      const formData = new FormData();
      formData.append('file', fileEl.files[0]);
      const uploadRes = await fetch('/api/v1/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN },
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (uploadRes.ok && uploadData.file_path) {
        msgPayload.file_path = uploadData.file_path;
      } else {
        alert(uploadData.error || 'Upload failed');
        btn.disabled = false;
        input.value = text;
        return;
      }
    }

    const res = await fetch('/api/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(msgPayload)
    });
    const data = await res.json();
    if (!res.ok && data.error) {
      alert(data.error);
      input.value = text;
    } else {
      clearFileUpload();
    }
    lastMsgCount = 0; // Force refresh
    lastMsgKey = '';
    isFirstLoad = true; // Force scroll to bottom
    await loadMessages();
  } catch(e) {
    input.value = text;
  }
  updateSendBtnState();
  input.focus();
}

const isMobile = window.innerWidth <= 520;

const MAX_INPUT_HEIGHT = 208; // 8줄 기준: 16px * 1.45 * 8 ≈ 185.6px + padding(16) + border(2) ≈ 204px → 208px

function autoResizeInput(el) {
  el.style.height = 'auto';                                // flex 제약 해제 트릭 — natural size 재계산 유도
  const newH = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT);
  el.style.height = newH + 'px';
  el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.isComposing) {
    if (isMobile) {
      // Mobile: Enter = newline, send only via button
      return;
    }
    // PC: Enter = send, Shift+Enter or Ctrl+Enter = newline
    if (!e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
  }
}

function logout() {
  document.cookie = 'mesh_token=; path=/; max-age=0';
  location.href = '/';
}

// --- Search ---
function toggleSearch() {
  const panel = document.getElementById('searchPanel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  if (!visible) {
    document.getElementById('searchInput').focus();
  } else {
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('searchInput').value = '';
  }
}

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  const resultsEl = document.getElementById('searchResults');
  if (!q) { resultsEl.innerHTML = ''; return; }

  resultsEl.innerHTML = '<div class="search-empty">Searching...</div>';
  try {
    const res = await fetch('/api/v1/messages/search?q=' + encodeURIComponent(q) + '&limit=50', { headers });
    const data = await res.json();
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">No results found</div>';
      return;
    }
    const searchQuery = q;
    resultsEl.innerHTML = msgs.map(m => {
      const other = m.from === MY_LOGIN ? m.to : m.from;
      const time = (function(){ const kp = kstParts(m.ts); const pad2 = n => String(n).padStart(2, '0'); return kp ? (kp.month + '/' + kp.day + ' ' + pad2(kp.hour) + ':' + pad2(kp.minute) + ' KST') : String(m.ts); })();
      const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
      return '<div class="search-result-item" onclick="searchNav(\\'' + other.replace(/'/g, "\\\\'") + '\\',\\'' + m.id.replace(/'/g, "\\\\'") + '\\',\\'' + searchQuery.replace(/'/g, "\\\\'") + '\\')">' +
        '<div class="sr-header"><span class="sr-agent">' + escHtml(m.from === MY_LOGIN ? 'You -> ' + other : other) + '</span><span class="sr-time">' + time + '</span></div>' +
        '<div class="sr-content">' + escHtml(preview) + '</div></div>';
    }).join('');
  } catch(e) {
    resultsEl.innerHTML = '<div class="search-empty">Search failed</div>';
  }
}

let pendingScrollToMsg = null;
let pendingHighlight = null;

function searchNav(agentId, msgId, query) {
  // Close search panel and navigate to that agent's chat
  toggleSearch();
  pendingScrollToMsg = msgId;
  pendingHighlight = query;
  if (agents.find(a => a.id === agentId)) {
    selectAgent(agentId);
  }
}

function scrollToAndHighlight() {
  if (!pendingScrollToMsg) return;
  const msgId = pendingScrollToMsg;
  const query = pendingHighlight;
  pendingScrollToMsg = null;
  pendingHighlight = null;

  setTimeout(() => {
    const el = document.getElementById('messages');
    if (!el) return;
    // Find the message element by data-id
    const msgEl = el.querySelector('[data-msgid="' + msgId + '"]');
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      msgEl.style.outline = '2px solid ' + '${THEME.accent}';
      msgEl.style.outlineOffset = '4px';
      setTimeout(() => { msgEl.style.outline = ''; msgEl.style.outlineOffset = ''; }, 3000);
    }
    // Highlight search text
    if (query) {
      const allMsgs = el.querySelectorAll('.msg');
      allMsgs.forEach(m => {
        const textNodes = m.childNodes;
        textNodes.forEach(n => {
          if (n.nodeType === 3 && n.textContent.includes(query)) {
            const span = document.createElement('span');
            span.innerHTML = n.textContent.replace(new RegExp('(' + query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi'), '<mark style="background:${THEME.accent};color:#fff;padding:1px 3px;border-radius:3px;">$1</mark>');
            n.parentNode.replaceChild(span, n);
            setTimeout(() => {
              span.querySelectorAll('mark').forEach(mk => { mk.style.background = 'transparent'; mk.style.color = 'inherit'; });
            }, 3000);
          }
        });
      });
    }
  }, 500);
}

// Fix viewport height for PWA / mobile browsers
function fixViewportHeight() {
  document.body.style.height = window.innerHeight + 'px';
}
fixViewportHeight();
window.addEventListener('resize', fixViewportHeight);

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\\/chat\\/(.+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (agents.find(a => a.id === id)) selectAgent(id, true);
  } else {
    // URL이 /chat (id 없음) — SPA 내 sidebar 복귀
    closeChatToSidebar();
  }
});

// Init
loadAgents().then(() => {
  if (INITIAL_AGENT && agents.find(a => a.id === INITIAL_AGENT)) {
    // SPA 뒤로가기 흐름 정렬: sidebar entry → chat entry 순으로 history 구성
    // 결과: 뒤로가기 1회 → URL /chat → popstate → closeChatToSidebar
    history.replaceState({ view: 'sidebar' }, '', '/chat');
    history.pushState({ view: 'chat', agent: INITIAL_AGENT }, '', '/chat/' + encodeURIComponent(INITIAL_AGENT));
    selectAgent(INITIAL_AGENT, true); // skipPush=true (already pushed above)
  }
});
// Global message polling — always refresh current chat every 3s
setInterval(() => {
  if (currentAgent) loadMessages();
}, 3000);
// Periodically refresh unread state for sidebar dots (every 15s)
setInterval(async () => {
  if (agents.length > 0) {
    await refreshUnreadState();
    renderAgents();
  }
}, 15000);

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'activated') {
          location.reload();
        }
      });
    });
  });
  // Handle navigation requests from SW notificationclick (avoids Chrome Android URL notification)
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) {
      window.location.href = e.data.url;
    }
  });
}

// Request notification permission and subscribe to push
async function setupPushNotifications() {
  if (!('Notification' in window) || !('PushManager' in window)) return;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const reg = await navigator.serviceWorker.ready;

  // Get VAPID key
  const vapidRes = await fetch('/api/v1/push/vapid-key');
  const { publicKey } = await vapidRes.json();
  if (!publicKey) return;

  // Convert VAPID key
  const vapidKey = urlBase64ToUint8Array(publicKey);

  // Subscribe
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKey
    });
  }

  // Send subscription to server
  await fetch('/api/v1/push/subscribe', {
    method: 'POST',
    headers,
    body: JSON.stringify({ subscription: sub.toJSON() })
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Call after SW registration
setupPushNotifications();
</script>
</body>
</html>`
}

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
  const reg = loadRegistry()
  if (!reg.agents[agentId]) {
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
  const reg = loadRegistry()
  const agentCount = Object.keys(reg.agents).length
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

  const reg = loadRegistry()
  const agents = Object.entries(reg.agents).map(([id, entry]) => ({
    id,
    name: entry.name,
    description: entry.description ?? null,
    channel: entry.channel ?? 'native',
    type: entry.type ?? 'agent',
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
  const reg = loadRegistry()
  if (!reg.agents[to]) {
    return c.json({
      error: `Agent "${to}" not found in registry`,
      known_agents: Object.keys(reg.agents),
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
  const reg = loadRegistry()
  if (!reg.agents[githubLogin]) {
    reg.agents[githubLogin] = {
      name: githubLogin,
      channel: 'web',
      type: 'user',
      approved: true,
    }
  } else {
    reg.agents[githubLogin].approved = true
  }
  saveRegistry(reg)

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

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh - Admin</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  /* --- AI Usage iter2 (task #79) --- design tokens */
  :root {
    --level-none:   #2ecc71;
    --level-info:   #3498db;
    --level-warn:   #facc15;
    --level-danger: #f97316;
    --level-stop:   #dc2626;
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 14px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    min-height: 100vh;
    padding: 20px;
    max-width: 800px;
    margin: 0 auto;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  h1 { font-size: 1.4rem; color: ${THEME.accent}; }
  .back-link { color: #aaa; text-decoration: none; font-size: 0.9rem; }
  .back-link:hover { color: ${THEME.accent}; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 1.1rem; margin-bottom: 12px; color: #ccc; }
  .card {
    background: #16213e;
    border: 1px solid #0f3460;
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .card .info { flex: 1; }
  .card .name { font-weight: 600; font-size: 0.95rem; }
  .card .meta { font-size: 0.8rem; color: #999; margin-top: 2px; }
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    min-height: 36px;
  }
  .btn-approve { background: #2ecc71; color: #fff; }
  .btn-approve:hover { background: #27ae60; }
  .btn-deny { background: #e74c3c; color: #fff; margin-left: 6px; }
  .btn-deny:hover { background: #c0392b; }
  .empty { color: #555; font-size: 0.9rem; padding: 20px; text-align: center; }
  .status { font-size: 0.85rem; padding: 4px 10px; border-radius: 4px; }
  .status-approved { background: #2ecc7133; color: #2ecc71; }
  .status-denied { background: #e74c3c33; color: #e74c3c; }
  .status-pending { background: #f39c1233; color: #f39c12; }
  /* --- Tabs --- */
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid ${THEME.border};
    margin-bottom: 20px;
  }
  .tab {
    padding: 10px 18px;
    background: transparent;
    color: #888;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 500;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: #ccc; }
  .tab.active {
    color: ${THEME.accent};
    border-bottom-color: ${THEME.accent};
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  /* --- Chat Audits --- */
  .audit-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    padding: 12px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: 8px;
  }
  .audit-filters select,
  .audit-filters input[type="text"] {
    padding: 8px 10px;
    background: ${THEME.bg};
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.9rem;
    outline: none;
  }
  .audit-filters input[type="text"] { flex: 1; min-width: 160px; }
  .audit-filters select { min-width: 130px; }
  .audit-filters button {
    padding: 8px 14px;
    background: ${THEME.accent};
    color: #fff;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
  }
  .audit-filters button:hover { filter: brightness(1.1); }
  .audit-status {
    font-size: 0.8rem;
    color: #888;
    padding: 8px 4px;
    text-align: center;
  }
  .audit-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 70vh;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    background: ${THEME.bg};
  }
  .audit-msg {
    padding: 10px 12px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    font-size: 0.88rem;
  }
  .audit-msg .hdr {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 6px;
    font-size: 0.78rem;
    color: #999;
    margin-bottom: 6px;
  }
  .audit-msg .route { color: ${THEME.accent}; font-weight: 500; }
  .audit-msg .route .arrow { color: #777; margin: 0 4px; }
  .audit-msg .content { color: #e0e0e0; white-space: pre-wrap; word-break: break-word; }
  .audit-msg .reply-to { font-size: 0.72rem; color: #777; margin-top: 4px; font-family: monospace; }
  .audit-msg .expand-btn {
    display: inline-block;
    margin-left: 4px;
    color: ${THEME.accent};
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
  }
  /* --- v2: Chat Audits live indicator, glow, floating pill --- */
  .audit-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .audit-header-row h2 { margin-bottom: 0; }
  .live-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #aaa;
    padding: 4px 10px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: 14px;
    font-variant-numeric: tabular-nums;
  }
  .live-dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: #666;
    box-shadow: 0 0 6px rgba(255,255,255,0.05);
  }
  .live-indicator[data-state="live"]  .live-dot { background: #2ecc71; box-shadow: 0 0 6px rgba(46,204,113,0.6); }
  .live-indicator[data-state="reconnecting"] .live-dot { background: #f39c12; box-shadow: 0 0 6px rgba(243,156,18,0.6); animation: live-pulse 1s ease-in-out infinite; }
  .live-indicator[data-state="offline"] .live-dot { background: #e74c3c; box-shadow: 0 0 6px rgba(231,76,60,0.6); }
  @keyframes live-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
  /* glow fade — accent-tinted halo that fades out */
  @keyframes glow-fade {
    0%   { box-shadow: 0 0 0 1px ${THEME.accent}66, 0 0 10px 2px ${THEME.accent}55; }
    100% { box-shadow: 0 0 0 1px transparent, 0 0 0 0 transparent; }
  }
  .audit-msg.glow { animation: glow-fade 600ms ease-out 1; }
  .audit-msg.recovered {
    background: ${THEME.bg};
    border-left: 3px solid #666;
    opacity: 0.85;
  }
  .audit-msg.recovered .route::before {
    content: '↺ ';
    color: #888;
  }
  /* floating pill (scenario B) */
  .audit-list-wrap {
    position: relative;
  }
  .audit-pill {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 16px;
    background: ${THEME.accent};
    color: #fff;
    border: none;
    border-radius: 18px;
    padding: 8px 16px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    display: none;
    z-index: 5;
    min-height: 36px;
  }
  .audit-pill.show { display: inline-block; }
  .audit-pill:hover { filter: brightness(1.1); }
  /* clear-filter button */
  .audit-filters .clear-btn {
    padding: 8px 10px;
    background: transparent;
    color: #aaa;
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    line-height: 1;
    min-width: 36px;
  }
  .audit-filters .clear-btn:hover { color: ${THEME.accent}; border-color: ${THEME.accent}; background: ${THEME.sidebar}; }
  /* counters line */
  .audit-counters {
    font-size: 0.78rem;
    color: #888;
    padding: 2px 4px 6px;
    font-variant-numeric: tabular-nums;
  }
  /* --- AI Usage iter2 (task #79) --- */
  .ai-usage-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .ai-usage-header-row h2 { margin-bottom: 0; }
  .ai-usage-meta {
    font-size: 0.82rem;
    color: #aaa;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: var(--radius-lg);
  }
  .ai-usage-meta.stale {
    color: var(--level-warn);
    border-color: var(--level-warn);
  }
  .ai-usage-meta .warn-icon { font-size: 0.9rem; }
  .ai-usage-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .ai-usage-card {
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: var(--radius-md);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: opacity 0.2s;
  }
  /* --- AI Usage iter2 (task #79) --- D-04: stale readability */
  .ai-usage-card.stale {
    opacity: 0.7;
    filter: saturate(0.5);
  }
  .ai-usage-card .account-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ai-usage-card .account-name {
    font-weight: 600;
    font-size: 0.95rem;
    color: #e0e0e0;
  }
  .ai-usage-card .provider-badge {
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: var(--radius-md);
    background: ${THEME.bg};
    color: #aaa;
    border: 1px solid ${THEME.border};
  }
  /* --- AI Usage iter5 (task #80) S-03: provider-badge --strong (탭 카드 강조) --- */
  .provider-badge.provider-badge--strong {
    font-size: 0.82rem;
    padding: 3px 12px;
    font-weight: 700;
    color: #e8e8e8;
    background: rgba(255,255,255,0.10);
    border: 1px solid rgba(255,255,255,0.22);
  }
  /* --- AI Usage iter2 (task #79) --- D-06: plan-badge neutral style */
  .ai-usage-card .plan-badge {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.08);
    color: #cfd3d9;
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-weight: 500;
  }
  .ai-usage-window {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ai-usage-window .window-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    color: #bbb;
    gap: 8px;
  }
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 탭 카드 window-label 글자 단위 wrap 방지 --- */
  .ai-usage-window .window-label { font-weight: 500; white-space: nowrap; }
  /* --- AI Usage iter2 (task #79) --- U-01: reset highlight (card) */
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 탭 카드 window-resets 글자 단위 wrap 방지 --- */
  .ai-usage-window .window-resets {
    color: #e0e0e0;
    font-size: 0.78rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }
  .ai-usage-window .window-resets .reset-icon {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .progress-bar {
    width: 100%;
    height: 8px;
    background: ${THEME.bg};
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid ${THEME.border};
  }
  .progress-fill {
    height: 100%;
    border-radius: var(--radius-sm);
    transition: width 0.3s ease-out, background-color 0.3s;
  }
  .ai-usage-window .window-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.72rem;
    color: #999;
    margin-top: 2px;
  }
  .level-badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: var(--radius-md);
    font-weight: 500;
    text-transform: uppercase;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  /* --- AI Usage iter5 (task #80) V-01: 색약 보조 아이콘 --- */
  .level-icon {
    font-style: normal;
    font-size: 0.8em;
    line-height: 1;
  }
  .level-none   { background: rgba(46, 204, 113, 0.2);  color: var(--level-none); }
  .level-info   { background: rgba(52, 152, 219, 0.2);  color: var(--level-info); }
  .level-warn   { background: rgba(250, 204, 21, 0.22); color: var(--level-warn); }
  .level-danger { background: rgba(249, 115, 22, 0.22); color: var(--level-danger); }
  .level-stop   { background: rgba(220, 38, 38, 0.25);  color: var(--level-stop); }
  .progress-fill.level-none   { background: var(--level-none); }
  .progress-fill.level-info   { background: var(--level-info); }
  .progress-fill.level-warn   { background: var(--level-warn); }
  .progress-fill.level-danger { background: var(--level-danger); }
  .progress-fill.level-stop   { background: var(--level-stop); }
  /* --- AI Usage iter2 (task #79) --- D-08: minimal-mode-badge 한글+크기 */
  .minimal-mode-badge {
    font-size: 0.78rem;
    padding: 1px 6px;
    border-radius: var(--radius-md);
    background: rgba(155, 89, 182, 0.25);
    color: #c199d8;
    margin-left: 6px;
  }
  .ai-usage-footer {
    font-size: 0.74rem;
    color: #888;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px dashed ${THEME.border};
  }
  /* --- AI Usage iter2 (task #79) --- D-05: footer hierarchy */
  .ai-usage-footer .api-error {
    color: var(--level-stop);
    font-weight: 600;
    font-size: 0.82rem;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ai-usage-footer .api-error .err-icon { font-size: 0.95rem; }
  .ai-usage-footer .fail-count {
    color: var(--level-danger);
    font-size: 0.76rem;
  }
  .ai-usage-footer .last-success {
    color: #888;
    font-size: 0.72rem;
    margin-left: auto;
  }
  /* Legacy .warn kept for any stray callers */
  .ai-usage-footer .warn { color: var(--level-stop); }
  /* --- AI Usage Summary Box (always visible, task #79 follow-up) --- */
  .ai-usage-summary {
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: var(--radius-md);
    padding: 10px 14px;
    margin: 10px 0 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: opacity 0.2s;
  }
  /* --- AI Usage iter2 (task #79) --- D-04: stale readability (summary) */
  .ai-usage-summary.stale {
    opacity: 0.7;
    filter: saturate(0.5);
  }
  .ai-usage-summary-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 6px 2px;
    min-height: 34px;
    font-size: 0.8rem;
    color: #bbb;
  }
  .ai-usage-summary-row + .ai-usage-summary-row {
    border-top: 1px dashed ${THEME.border};
  }
  .ai-usage-summary-row .provider-badge {
    font-size: 0.74rem;
    padding: 2px 10px;
    border-radius: var(--radius-md);
    background: ${THEME.bg};
    color: #e0e0e0;
    border: 1px solid ${THEME.border};
    font-weight: 600;
    min-width: 54px;
    text-align: center;
  }
  /* --- AI Usage iter2 (task #79) --- D-06: plan-hint-badge neutral */
  .ai-usage-summary-row .plan-hint-badge {
    font-size: 0.7rem;
    padding: 1px 8px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.08);
    color: #cfd3d9;
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-weight: 500;
  }
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 라벨 글자 단위 wrap 방지 --- */
  .ai-usage-summary-row .window-label {
    font-size: 0.76rem;
    color: #aaa;
    margin-left: 4px;
    white-space: nowrap;
  }
  .ai-usage-summary-row .window-percent {
    font-size: 0.8rem;
    color: #e0e0e0;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    min-width: 36px;
    text-align: right;
  }
  .ai-usage-summary-row .mini-progress {
    flex: 0 1 110px;
    min-width: 70px;
    max-width: 140px;
    height: 5px;
    background: ${THEME.bg};
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid ${THEME.border};
  }
  .ai-usage-summary-row .mini-progress-fill {
    height: 100%;
    border-radius: var(--radius-sm);
    transition: width 0.3s ease-out, background-color 0.3s;
    width: 0%;
  }
  .ai-usage-summary-row .mini-progress-fill.level-none   { background: var(--level-none); }
  .ai-usage-summary-row .mini-progress-fill.level-info   { background: var(--level-info); }
  .ai-usage-summary-row .mini-progress-fill.level-warn   { background: var(--level-warn); }
  .ai-usage-summary-row .mini-progress-fill.level-danger { background: var(--level-danger); }
  .ai-usage-summary-row .mini-progress-fill.level-stop   { background: var(--level-stop); }
  /* --- AI Usage iter2 (task #79) --- U-01: reset highlight (summary row) */
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 리셋 텍스트 글자 단위 wrap 방지 --- */
  .ai-usage-summary-row .window-resets {
    font-size: 0.78rem;
    color: #e0e0e0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-right: 2px;
    white-space: nowrap;
  }
  .ai-usage-summary-row .window-resets .reset-icon {
    font-size: 0.82rem;
    opacity: 0.85;
  }
  .ai-usage-summary-row .summary-sep {
    color: #555;
    margin: 0 2px;
  }
  /* --- AI Usage iter3 (task #79) S-02: summary-win 그룹 wrapper — narrow viewport flex-wrap 단위 보장 */
  .ai-usage-summary-row .summary-win {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
  }
  .ai-usage-summary .summary-empty {
    font-size: 0.8rem;
    color: #888;
    padding: 6px 2px;
  }
  /* --- AI Usage iter5 (task #80) V-02-b: row-identity 그룹 wrapper — provider+badge+dot 묶음 --- */
  .ai-usage-summary-row .row-identity {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
  /* --- AI Usage iter3 (task #79) --- S-06: status dot (api_error / failures) */
  .ai-usage-summary-row .status-dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.15);
    cursor: help;
  }
  .ai-usage-summary-row .status-dot-error {
    background: var(--level-stop);
    box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.25);
  }
  .ai-usage-summary-row .status-dot-warn {
    background: var(--level-danger);
    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.25);
  }
  /* --- AI Usage iter3 (task #79) --- S-01: summary-row minimal mode badge spacing override */
  .ai-usage-summary-row .minimal-mode-badge {
    margin-left: 2px;
  }
  /* --- AI Usage iter3 (task #79) --- Z-02: SSE disconnect banner */
  /* --- AI Usage iter5 (task #80) V-03: sticky banner --- */
  .ai-usage-disconnect-banner {
    display: none;
    background: rgba(220, 38, 38, 0.18);
    border: 1px solid var(--level-stop);
    color: #ffb3b3;
    font-size: 0.82rem;
    font-weight: 500;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    margin: 10px 0 8px;
    animation: ai-usage-banner-fadein 0.25s ease-out;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .ai-usage-disconnect-banner.visible {
    display: block;
  }
  @keyframes ai-usage-banner-fadein {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* M01-4 base: 데스크톱 기본 — mobile 라벨 숨김, desktop 라벨 표시 */
  /* 반드시 @media (max-width:640px) 블록보다 먼저 선언해야 override 방지 */
  .tab .tab-label-desktop { display: inline; }
  .tab .tab-label-mobile { display: none; }

  /* --- AI Usage M-01 mobile (task #80): 모바일 세로 반응형 --- */
  @media (max-width: 640px) {
    /* 요약 박스 컴팩트 */
    .ai-usage-summary {
      padding: 6px 8px;
      margin: 6px 0 8px;
      gap: 4px;
    }
    .ai-usage-summary-row {
      gap: 6px;
      padding: 4px 2px;
      min-height: 26px;
      font-size: 0.72rem;
    }
    .ai-usage-summary-row + .ai-usage-summary-row {
      border-top-width: 1px;
    }
    .ai-usage-summary-row .provider-badge {
      font-size: 0.68rem;
      padding: 1px 6px;
      min-width: 42px;
    }
    .ai-usage-summary-row .window-label {
      font-size: 0.68rem;
    }
    .ai-usage-summary-row .window-percent {
      font-size: 0.72rem;
      min-width: 28px;
    }
    .ai-usage-summary-row .mini-progress {
      flex: 0 1 60px;
      min-width: 40px;
      max-width: 90px;
    }
    .ai-usage-summary-row .window-resets {
      font-size: 0.68rem;
    }
    /* 요약 박스 max-height → 화면 50% 초과 금지 */
    .ai-usage-summary {
      max-height: 50vh;
      overflow-y: auto;
    }
    /* 탭 버튼 컴팩트 + 한 줄 유지 */
    .tab {
      padding: 8px 10px;
      font-size: 0.78rem;
      white-space: nowrap;
    }
    /* 배너 sticky 유지, 모바일 padding 축소 */
    .ai-usage-disconnect-banner {
      font-size: 0.76rem;
      padding: 6px 10px;
    }
    /* M01-4: 탭 라벨 모바일 축약 "AI 계정 상황" → "AI 계정" */
    .tab .tab-label-desktop { display: none; }
    .tab .tab-label-mobile { display: inline; }
  }

</style>
</head>
<body>
  <div class="header">
    <h1>Admin Panel</h1>
    <a class="back-link" href="/chat">← Chat</a>
  </div>

  <!-- --- AI Usage iter3 (task #79) --- Z-02: SSE disconnect banner -->
  <div class="ai-usage-disconnect-banner" id="ai-usage-disconnect-banner" role="alert" aria-live="polite">
    ⚠ 실시간 연결 끊김 · 재시도 중...
  </div>

  <!-- --- AI Usage iter5 (task #80) Z-07: role=region + aria-label --- -->
  <div class="ai-usage-summary" id="ai-usage-summary" role="region" aria-label="AI 계정 사용량 요약">
    <div class="summary-empty" id="ai-usage-summary-empty">AI 계정 사용량을 불러오는 중입니다...</div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="approvals" onclick="switchTab('approvals')">Pending Approvals</button>
    <button class="tab" data-tab="ai-usage" onclick="switchTab('ai-usage')"><span class="tab-label-desktop">AI 계정 상황</span><span class="tab-label-mobile">AI 계정</span></button>
    <button class="tab" data-tab="audits" onclick="switchTab('audits')">Chat Audits</button>
  </div>

  <div id="tab-approvals" class="tab-panel active">
    <div class="section">
      <h2>Pending Approvals</h2>
      <div id="pendingList"><div class="empty">Loading...</div></div>
    </div>

    <div class="section">
      <h2>Registered Users</h2>
      <div id="userList"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- --- AI Usage iter5 (task #80) Z-07: role=region + aria-label --- -->
  <div id="tab-ai-usage" class="tab-panel" role="region" aria-label="AI 계정 사용량 상세">
    <div class="section">
      <div class="ai-usage-header-row">
        <h2>AI 계정 상황</h2>
        <span id="aiUsageMeta" class="ai-usage-meta" role="status" aria-live="polite">
          <span id="aiUsageMetaText">대기 중...</span>
        </span>
      </div>
      <div id="aiUsageGrid" class="ai-usage-grid">
        <div class="empty">Loading...</div>
      </div>
    </div>
  </div>

  <div id="tab-audits" class="tab-panel">
    <div class="section">
      <div class="audit-header-row">
        <h2>Chat Audits</h2>
        <span id="auditLiveIndicator" class="live-indicator" data-state="offline" role="status" aria-live="polite" title="SSE connection state">
          <span class="live-dot" aria-hidden="true"></span>
          <span id="auditLiveLabel">offline</span>
        </span>
      </div>
      <div class="audit-filters">
        <select id="auditFromAgent" aria-label="Filter by from agent"><option value="">(from: all)</option></select>
        <select id="auditToAgent" aria-label="Filter by to agent"><option value="">(to: all)</option></select>
        <input type="text" id="auditSearch" placeholder="Search content..." aria-label="Search content" />
        <button onclick="applyAuditFilters()">Apply</button>
        <button class="clear-btn" id="auditClearBtn" onclick="clearAuditFilters()" aria-label="Clear filters" title="Clear filters">×</button>
      </div>
      <div id="auditCounters" class="audit-counters" aria-live="polite"></div>
      <div id="auditTopStatus" class="audit-status"></div>
      <div class="audit-list-wrap">
        <div id="auditList" class="audit-list" role="log" aria-live="polite" aria-relevant="additions" aria-label="Chat audit log">
          <div class="empty">Select the tab to load messages...</div>
        </div>
        <button type="button" id="auditPill" class="audit-pill" onclick="scrollAuditsToBottom()" aria-label="Scroll to newest messages">⬇ 새 메시지 0개 · 바닥으로</button>
      </div>
    </div>
  </div>

<script>
const TOKEN = document.cookie.split('; ').find(c => c.startsWith('mesh_token='))?.split('=').slice(1).join('=') || '';
const headers = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// --- KST timestamp helper (Asia/Seoul, browser-locale independent via Intl) ---
function toKST(isoOrSqliteUtc) {
  if (isoOrSqliteUtc == null) return '';
  const s = String(isoOrSqliteUtc).trim();
  const withT = s.includes('T') ? s : s.replace(' ', 'T');
  const withZ = /Z$|[+-]\\d\\d:?\\d\\d$/.test(withT) ? withT : withT + 'Z';
  const d = new Date(withZ);
  if (isNaN(d.getTime())) return String(isoOrSqliteUtc);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
         get('hour') + ':' + get('minute') + ':' + get('second') + ' KST';
}

async function loadPending() {
  try {
    const res = await fetch('/api/v1/admin/pending', { headers });
    const data = await res.json();
    const list = data.pending || [];
    const el = document.getElementById('pendingList');
    if (list.length === 0) {
      el.innerHTML = '<div class="empty">승인 대기 중인 사용자가 없습니다</div>';
      return;
    }
    el.innerHTML = list.map(p =>
      '<div class="card">' +
      '<div class="info"><div class="name">' + esc(p.github_login) + '</div>' +
      '<div class="meta">GitHub ID: ' + p.github_id + ' · ' + toKST(p.requested_at) + '</div></div>' +
      '<div><button class="btn btn-approve" onclick="approve(\\'' + esc(p.github_login) + '\\')">승인</button>' +
      '<button class="btn btn-deny" onclick="deny(\\'' + esc(p.github_login) + '\\')">거부</button></div>' +
      '</div>'
    ).join('');
  } catch(e) {
    document.getElementById('pendingList').innerHTML = '<div class="empty">Failed to load</div>';
  }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/v1/agents', { headers });
    const data = await res.json();
    const users = (data.agents || []).filter(a => a.type === 'user');
    const agents = (data.agents || []).filter(a => a.type !== 'user');
    const el = document.getElementById('userList');
    const all = [...users.map(u => ({...u, isUser: true})), ...agents.map(a => ({...a, isUser: false}))];
    if (all.length === 0) {
      el.innerHTML = '<div class="empty">등록된 사용자/에이전트가 없습니다</div>';
      return;
    }
    el.innerHTML = all.map(u =>
      '<div class="card"><div class="info"><div class="name">' + esc(u.name) +
      (u.isUser ? ' <span class="status status-approved">user</span>' : ' <span style="font-size:0.8rem;color:#555;">agent</span>') +
      '</div><div class="meta">' + (u.description || '') + '</div></div></div>'
    ).join('');
  } catch(e) {}
}

async function approve(login) {
  if (!confirm(login + ' 사용자를 승인하시겠습니까?')) return;
  await fetch('/api/v1/admin/approve', { method: 'POST', headers, body: JSON.stringify({ github_login: login }) });
  loadPending();
  loadUsers();
}

async function deny(login) {
  if (!confirm(login + ' 사용자를 거부하시겠습니까?')) return;
  await fetch('/api/v1/admin/deny', { method: 'POST', headers, body: JSON.stringify({ github_login: login }) });
  loadPending();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Tabs ---

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
  if (name === 'audits') {
    if (!auditState.initialized) {
      auditState.initialized = true;
      loadAuditAgents();
      resetAndLoadAudits();
    } else {
      // Re-open SSE if we came back to the tab.
      connectAuditStream();
    }
  } else {
    // Leaving audits tab: close SSE to stop receiving (and free resources).
    disconnectAuditStream();
  }
  // --- AI Usage (task #79) ---
  // Summary box is always visible + auto-refreshing via SSE, so we keep the
  // stream alive regardless of tab. The tab-detail grid re-renders on next
  // snapshot even if we enter/leave the tab. Init-on-demand only if the page
  // didn't auto-init (fallback safety).
  if (name === 'ai-usage' && !aiUsageState.initialized) {
    aiUsageState.initialized = true;
    initAiUsage();
  }
}

// --- Chat Audits ---

const auditState = {
  initialized: false,
  loading: false,
  hasMore: true,
  oldestId: null,
  messages: [],     // newest-first internally
  expanded: {},     // id -> true when full content shown
  filters: { from_agent: '', to_agent: '', search: '' },
  reqSeq: 0,
  searchDebounce: null,
  eventSource: null,
  reconnectTimer: null,
  seenIds: new Set(),   // de-dupe vs initial load
  // v2: live indicator state
  liveState: 'offline',          // 'live' | 'reconnecting' | 'offline'
  reconnectAttempts: 0,
  // v2: floating pill — count of new messages arrived while scrolled up
  pendingNewCount: 0,
  // v2: throttled batching via rAF when bursts happen
  rafQueued: false,
  rafQueue: [],
  // v2: counters
  totalCount: 0,     // total messages received (loaded + live)
  hiddenCount: 0,    // live messages that didn't match filter
};

async function loadAuditAgents() {
  try {
    const res = await fetch('/api/v1/admin/chat-audits/agents', { headers });
    const data = await res.json();
    const agents = data.agents || [];
    const fromSel = document.getElementById('auditFromAgent');
    const toSel = document.getElementById('auditToAgent');
    const fromCur = fromSel.value;
    const toCur = toSel.value;
    fromSel.innerHTML = '<option value="">(from: all)</option>' + agents.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
    toSel.innerHTML = '<option value="">(to: all)</option>' + agents.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
    fromSel.value = fromCur;
    toSel.value = toCur;
  } catch(e) { /* ignore */ }
}

function applyAuditFilters() {
  auditState.filters.from_agent = document.getElementById('auditFromAgent').value || '';
  auditState.filters.to_agent = document.getElementById('auditToAgent').value || '';
  auditState.filters.search = document.getElementById('auditSearch').value || '';
  resetAndLoadAudits();
}

function clearAuditFilters() {
  // (Scenario E): clear dropdowns/search, then full reload + reconnect.
  document.getElementById('auditFromAgent').value = '';
  document.getElementById('auditToAgent').value = '';
  document.getElementById('auditSearch').value = '';
  auditState.filters.from_agent = '';
  auditState.filters.to_agent = '';
  auditState.filters.search = '';
  resetAndLoadAudits();
}

// --- v2: Live indicator ---
function setAuditLiveState(next) {
  if (auditState.liveState === next) return;
  auditState.liveState = next;
  const ind = document.getElementById('auditLiveIndicator');
  const lbl = document.getElementById('auditLiveLabel');
  if (!ind || !lbl) return;
  ind.setAttribute('data-state', next);
  if (next === 'live') lbl.textContent = 'live';
  else if (next === 'reconnecting') lbl.textContent = 'reconnecting…';
  else lbl.textContent = 'offline';
}

// --- v2: Counters line ---
function updateAuditCounters() {
  const el = document.getElementById('auditCounters');
  if (!el) return;
  const match = auditState.messages.length;
  const total = auditState.totalCount;
  const hidden = auditState.hiddenCount;
  el.textContent = '전체 ' + total + ' · 필터 매치 ' + match + ' · 숨김 ' + hidden;
}

// --- v2: Floating pill ---
function updateAuditPill() {
  const pill = document.getElementById('auditPill');
  if (!pill) return;
  if (auditState.pendingNewCount > 0) {
    const n = auditState.pendingNewCount > 99 ? '99+' : String(auditState.pendingNewCount);
    pill.textContent = '⬇ 새 메시지 ' + n + '개 · 바닥으로';
    pill.classList.add('show');
  } else {
    pill.classList.remove('show');
  }
}

function scrollAuditsToBottom() {
  const list = document.getElementById('auditList');
  if (!list) return;
  list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  auditState.pendingNewCount = 0;
  updateAuditPill();
}

function isAuditNearBottom() {
  const list = document.getElementById('auditList');
  if (!list) return true;
  return (list.scrollHeight - list.scrollTop - list.clientHeight) < 50;
}

function resetAndLoadAudits() {
  auditState.loading = false;
  auditState.hasMore = true;
  auditState.oldestId = null;
  auditState.messages = [];
  auditState.expanded = {};
  auditState.seenIds = new Set();
  auditState.pendingNewCount = 0;
  auditState.rafQueue = [];
  auditState.rafQueued = false;
  auditState.totalCount = 0;
  auditState.hiddenCount = 0;
  updateAuditPill();
  updateAuditCounters();
  const list = document.getElementById('auditList');
  list.innerHTML = '<div class="audit-status">Loading...</div>';
  document.getElementById('auditTopStatus').textContent = '';
  // Restart the SSE stream with new filters (also covers initial connection).
  disconnectAuditStream();
  loadOlderAudits(true).then(() => {
    connectAuditStream();
  });
}

async function loadOlderAudits(initial) {
  if (auditState.loading) return;
  if (!initial && !auditState.hasMore) return;
  auditState.loading = true;
  const mySeq = ++auditState.reqSeq;
  const topStatus = document.getElementById('auditTopStatus');
  topStatus.textContent = auditState.oldestId ? 'Loading older...' : '';

  const params = new URLSearchParams();
  params.set('limit', '100');
  if (auditState.oldestId) params.set('before_id', auditState.oldestId);
  if (auditState.filters.from_agent) params.set('from_agent', auditState.filters.from_agent);
  if (auditState.filters.to_agent) params.set('to_agent', auditState.filters.to_agent);
  if (auditState.filters.search) params.set('search', auditState.filters.search);

  try {
    const res = await fetch('/api/v1/admin/chat-audits?' + params.toString(), { headers });
    if (mySeq !== auditState.reqSeq) { auditState.loading = false; return; } // stale
    const data = await res.json();
    const batch = data.messages || [];
    // Merge: batch is ts DESC (newest first). Append to end of our newest-first array.
    auditState.messages = auditState.messages.concat(batch);
    for (const m of batch) auditState.seenIds.add(m.id);
    auditState.hasMore = !!data.has_more;
    auditState.oldestId = data.oldest_id || auditState.oldestId;
    // Counters: initial load seeds totalCount from loaded-range.
    auditState.totalCount = auditState.messages.length;
    updateAuditCounters();
    renderAudits(initial);
  } catch(e) {
    topStatus.textContent = 'Failed to load.';
  } finally {
    auditState.loading = false;
  }
}

function renderAudits(initialLoad) {
  const list = document.getElementById('auditList');
  const topStatus = document.getElementById('auditTopStatus');

  if (auditState.messages.length === 0) {
    list.innerHTML = '<div class="empty">No messages match the current filters.</div>';
    topStatus.textContent = '';
    return;
  }

  // Render in chronological order (oldest at top, newest at bottom).
  // Our internal array is newest-first, so iterate reversed.
  const rendered = [];
  rendered.push('<div id="auditSentinel" style="height:1px;"></div>');
  for (let i = auditState.messages.length - 1; i >= 0; i--) {
    rendered.push(renderAuditMsg(auditState.messages[i]));
  }
  // Preserve scroll position if not initial load — we're prepending older content.
  const prevScrollHeight = list.scrollHeight;
  const prevScrollTop = list.scrollTop;

  list.innerHTML = rendered.join('');

  if (initialLoad) {
    // Scroll to the bottom to show newest.
    list.scrollTop = list.scrollHeight;
  } else {
    // Older messages were prepended. Keep viewing position stable.
    const newHeight = list.scrollHeight;
    list.scrollTop = prevScrollTop + (newHeight - prevScrollHeight);
  }

  if (auditState.hasMore) {
    topStatus.textContent = '';
    observeAuditSentinel();
  } else {
    topStatus.textContent = 'No more messages';
  }
}

function renderAuditMsg(m) {
  const content = m.content || '';
  const expanded = !!auditState.expanded[m.id];
  const truncate = content.length > 500 && !expanded;
  const shown = truncate ? content.slice(0, 500) + '…' : content;
  const expandBtn = content.length > 500
    ? '<button class="expand-btn" onclick="toggleAuditExpand(\\'' + esc(m.id).replace(/'/g, "\\\\'") + '\\')">' + (expanded ? 'collapse' : 'expand') + '</button>'
    : '';
  const replyLine = m.reply_to ? '<div class="reply-to">↩ reply_to: ' + esc(m.reply_to) + '</div>' : '';
  const statusBadge = m.status ? ' <span style="font-size:0.72rem;color:#777;">[' + esc(m.status) + ']</span>' : '';
  const extraCls = m.recovered ? ' recovered' : '';
  return (
    '<div class="audit-msg' + extraCls + '" data-id="' + esc(m.id) + '">' +
      '<div class="hdr">' +
        '<span class="route">' + esc(m.from_agent) + '<span class="arrow">→</span>' + esc(m.to_agent) + statusBadge + '</span>' +
        '<span>' + esc(toKST(m.ts)) + '</span>' +
      '</div>' +
      '<div class="content">' + esc(shown) + expandBtn + '</div>' +
      replyLine +
    '</div>'
  );
}

function toggleAuditExpand(id) {
  auditState.expanded[id] = !auditState.expanded[id];
  // Re-render in place (cheap for ~100s of messages)
  const list = document.getElementById('auditList');
  const prevScrollTop = list.scrollTop;
  const prevScrollHeight = list.scrollHeight;
  renderAudits(false);
  // After re-render above, prevScrollHeight diff already handled; but renderAudits uses
  // its own old/new heights captured before innerHTML replacement. For toggle, we want
  // to preserve the top offset; since renderAudits sees no height change for initial=false,
  // and our captured prev-values came before its call (stale), this is approximate but fine.
}

// IntersectionObserver for infinite scroll upward (sentinel at top).
let auditObserver = null;
function observeAuditSentinel() {
  const list = document.getElementById('auditList');
  const sentinel = document.getElementById('auditSentinel');
  if (!sentinel) return;
  if (auditObserver) auditObserver.disconnect();
  auditObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && auditState.hasMore && !auditState.loading) {
        loadOlderAudits(false);
      }
    }
  }, { root: list, rootMargin: '100px 0px 0px 0px', threshold: 0 });
  auditObserver.observe(sentinel);
}

// --- Chat Audits SSE (live tail) — v2 ---

const AUDIT_MAX_RECONNECT = 5;   // after N failed attempts → offline, stop auto-retry

function disconnectAuditStream() {
  if (auditState.eventSource) {
    try { auditState.eventSource.close(); } catch(e) {}
    auditState.eventSource = null;
  }
  if (auditState.reconnectTimer) {
    clearTimeout(auditState.reconnectTimer);
    auditState.reconnectTimer = null;
  }
  // When explicitly disconnected (leaving tab, filter change, etc.), reflect offline.
  setAuditLiveState('offline');
}

function connectAuditStream() {
  // Close any prior connection first.
  if (auditState.eventSource) {
    try { auditState.eventSource.close(); } catch(e) {}
    auditState.eventSource = null;
  }
  if (auditState.reconnectTimer) {
    clearTimeout(auditState.reconnectTimer);
    auditState.reconnectTimer = null;
  }
  const params = new URLSearchParams();
  if (auditState.filters.from_agent) params.set('from_agent', auditState.filters.from_agent);
  if (auditState.filters.to_agent) params.set('to_agent', auditState.filters.to_agent);
  if (auditState.filters.search) params.set('search', auditState.filters.search);
  const qs = params.toString();
  // EventSource uses same-origin cookie auth (mesh_token) — no custom headers needed.
  // EventSource auto-attaches Last-Event-ID header on reconnects (tracked from id: fields).
  const url = '/api/v1/admin/chat-audits/stream' + (qs ? ('?' + qs) : '');
  let es;
  try { es = new EventSource(url); }
  catch(e) { setAuditLiveState('offline'); return; }
  auditState.eventSource = es;
  setAuditLiveState('reconnecting');   // assume reconnecting until onopen
  es.onopen = () => {
    auditState.reconnectAttempts = 0;
    setAuditLiveState('live');
  };
  es.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || !msg.id) return;
      if (auditState.seenIds.has(msg.id)) return;   // dedupe
      queueLiveAuditMessage(msg);
    } catch(e) {}
  });
  es.addEventListener('gap-too-large', (ev) => {
    try {
      const info = JSON.parse(ev.data) || {};
      const status = document.getElementById('auditTopStatus');
      if (status) status.textContent = '복구할 메시지가 많습니다 (' + (info.count || '?') + '). 수동 새로고침 권장.';
    } catch(e) {}
  });
  es.onerror = () => {
    if (!auditState.eventSource) return;
    // EventSource itself will silently retry at the browser default — but we want an
    // explicit backoff + offline detection + Last-Event-ID gap fetch via a fresh EventSource.
    try { es.close(); } catch(e) {}
    auditState.eventSource = null;
    auditState.reconnectAttempts++;
    if (auditState.reconnectAttempts >= AUDIT_MAX_RECONNECT) {
      setAuditLiveState('offline');
      return;
    }
    setAuditLiveState('reconnecting');
    if (auditState.reconnectTimer) clearTimeout(auditState.reconnectTimer);
    // Exponential backoff capped at 30s (1→2→4→8→16→30).
    const delay = Math.min(30000, 1000 * Math.pow(2, auditState.reconnectAttempts - 1));
    auditState.reconnectTimer = setTimeout(() => {
      const panel = document.getElementById('tab-audits');
      if (panel && panel.classList.contains('active')) {
        connectAuditStream();
      }
    }, delay);
  };
}

// Queue + rAF batch — burst-safe (scenario 1-1: 20+ msg/s without frame drop).
function queueLiveAuditMessage(msg) {
  // Filter-match check on client side as well (defense-in-depth — server filters already applied).
  const f = auditState.filters;
  const matches =
    (!f.from_agent || msg.from_agent === f.from_agent) &&
    (!f.to_agent   || msg.to_agent   === f.to_agent) &&
    (!f.search     || (msg.content || '').toLowerCase().includes(f.search.toLowerCase()));
  auditState.totalCount++;
  if (!matches) {
    auditState.hiddenCount++;
    updateAuditCounters();
    return;
  }
  auditState.rafQueue.push(msg);
  if (!auditState.rafQueued) {
    auditState.rafQueued = true;
    requestAnimationFrame(flushLiveAuditBatch);
  }
}

function flushLiveAuditBatch() {
  auditState.rafQueued = false;
  const batch = auditState.rafQueue;
  auditState.rafQueue = [];
  if (batch.length === 0) return;
  const list = document.getElementById('auditList');
  if (!list) return;
  // Full render if still on placeholder / first live msg.
  const empty = list.querySelector('.empty');
  if (empty || !list.querySelector('#auditSentinel')) {
    for (const m of batch) {
      if (auditState.seenIds.has(m.id)) continue;
      auditState.seenIds.add(m.id);
      auditState.messages.unshift(m);
    }
    renderAudits(true);
    updateAuditCounters();
    return;
  }
  const nearBottom = isAuditNearBottom();
  const frag = document.createDocumentFragment();
  const newNodes = [];
  for (const m of batch) {
    if (auditState.seenIds.has(m.id)) continue;
    auditState.seenIds.add(m.id);
    auditState.messages.unshift(m);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderAuditMsg(m);
    const node = wrapper.firstElementChild;
    if (node) {
      frag.appendChild(node);
      newNodes.push(node);
    }
  }
  list.appendChild(frag);
  // Glow only live messages, not recovered ones (recovered already has its own styling).
  for (const n of newNodes) {
    if (!n.classList.contains('recovered') && document.visibilityState !== 'hidden') {
      n.classList.add('glow');
      setTimeout(((node) => () => { try { node.classList.remove('glow'); } catch(e) {} })(n), 650);
    }
  }
  if (nearBottom) {
    list.scrollTop = list.scrollHeight;
    auditState.pendingNewCount = 0;
  } else {
    // User is scrolled up — don't yank their view. Show pill with count.
    auditState.pendingNewCount += newNodes.length;
  }
  updateAuditPill();
  updateAuditCounters();
}

// Debounced search on typing.
document.addEventListener('DOMContentLoaded', () => {
  const searchEl = document.getElementById('auditSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      if (auditState.searchDebounce) clearTimeout(auditState.searchDebounce);
      auditState.searchDebounce = setTimeout(() => { applyAuditFilters(); }, 400);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (auditState.searchDebounce) clearTimeout(auditState.searchDebounce);
        applyAuditFilters();
      }
    });
  }
  const fromEl = document.getElementById('auditFromAgent');
  const toEl = document.getElementById('auditToAgent');
  if (fromEl) fromEl.addEventListener('change', applyAuditFilters);
  if (toEl) toEl.addEventListener('change', applyAuditFilters);
  // Auto-hide pill when user scrolls to bottom manually.
  const listEl = document.getElementById('auditList');
  if (listEl) {
    listEl.addEventListener('scroll', () => {
      if (isAuditNearBottom() && auditState.pendingNewCount > 0) {
        auditState.pendingNewCount = 0;
        updateAuditPill();
      }
    }, { passive: true });
  }
});

window.addEventListener('beforeunload', () => {
  disconnectAuditStream();
  disconnectAiUsageStream();
});

// --- AI Usage (task #79) ---

const aiUsageState = {
  initialized: false,
  snapshot: null,          // last rendered snapshot (preserved on error)
  eventSource: null,
  stalenessTicker: null,
  loadTimeoutId: null,     // --- AI Usage iter5 (task #80) S-04: load timeout ---
};

// last_updated_at 5.5분 이상 경과 시 stale 판정
const AI_USAGE_STALE_MS = 5.5 * 60 * 1000;

async function initAiUsage() {
  // --- AI Usage iter5 (task #80) S-04: 10초 load timeout fallback ---
  aiUsageState.loadTimeoutId = setTimeout(() => {
    if (!aiUsageState.snapshot) {
      const grid = document.getElementById('aiUsageGrid');
      if (grid) grid.innerHTML = '<div class="empty">수집이 지연되고 있습니다. 다음 cycle(최대 5분)까지 기다려주세요.</div>';
      const summary = document.getElementById('ai-usage-summary');
      if (summary && !aiUsageState.snapshot) {
        summary.innerHTML = '<div class="summary-empty">수집이 지연되고 있습니다. 다음 cycle(최대 5분)까지 기다려주세요.</div>';
      }
    }
  }, 10000);

  // Initial load: fetch current snapshot once, then open SSE for live updates.
  try {
    const res = await fetch('/api/v1/admin/ai-usage', { headers });
    if (res.ok) {
      const data = await res.json();
      if (data && data.snapshot) {
        clearTimeout(aiUsageState.loadTimeoutId);
        renderAiUsage(data.snapshot);
      } else {
        renderAiUsageEmpty();
      }
    } else {
      renderAiUsageEmpty();
    }
  } catch(e) {
    renderAiUsageEmpty();
  }
  subscribeAiUsageSSE();
  startStalenessTicker();
}

// --- AI Usage iter2 (task #79) --- D-09: 사용자 친화 한국어 empty copy
function renderAiUsageEmpty() {
  const grid = document.getElementById('aiUsageGrid');
  if (grid) grid.innerHTML = '<div class="empty">아직 사용량 데이터가 없습니다. 첫 수집까지 최대 5분 걸릴 수 있습니다.</div>';
  const metaText = document.getElementById('aiUsageMetaText');
  if (metaText) metaText.textContent = '대기 중...';
  const meta = document.getElementById('aiUsageMeta');
  if (meta) meta.classList.remove('stale');
  // Summary box: show empty hint (do not overwrite if a snapshot is already rendered)
  const summary = document.getElementById('ai-usage-summary');
  if (summary && !aiUsageState.snapshot) {
    summary.classList.remove('stale');
    summary.innerHTML = '<div class="summary-empty" id="ai-usage-summary-empty">아직 사용량 데이터가 없습니다. 첫 수집까지 최대 5분 걸릴 수 있습니다.</div>';
  }
}

function renderAiUsage(snapshot) {
  // snapshot이 null/undefined이면 기존 DOM 유지 (에러 시 마지막 값 유지)
  if (!snapshot || !Array.isArray(snapshot.accounts)) return;
  aiUsageState.snapshot = snapshot;
  const grid = document.getElementById('aiUsageGrid');
  if (grid) {
    if (snapshot.accounts.length === 0) {
      grid.innerHTML = '<div class="empty">표시할 계정이 없습니다.</div>'; // D-09: 그대로 유지 — 이미 한국어 사용자 친화
    } else {
      grid.innerHTML = snapshot.accounts.map(renderAiUsageCard).join('');
    }
  }
  // Also update the always-visible summary box (task #79 follow-up)
  renderAiUsageSummary(snapshot);
  updateAiUsageMeta();
}

function renderAiUsageSummary(snapshot) {
  const summary = document.getElementById('ai-usage-summary');
  if (!summary) return;
  if (!snapshot || !Array.isArray(snapshot.accounts) || snapshot.accounts.length === 0) {
    summary.innerHTML = '<div class="summary-empty">표시할 계정이 없습니다.</div>';
    return;
  }
  summary.innerHTML = snapshot.accounts.map(renderAiUsageSummaryRow).join('');
}

// --- AI Usage iter2 (task #79) --- U-01 + D-01: reset 승격, ARIA 부여, last_success_at per-row 제거
// --- AI Usage iter3 (task #79) --- S-01: summary-row minimal 배지, S-06: status dot
function renderAiUsageSummaryRow(acc) {
  if (!acc || typeof acc !== 'object') return '';
  const providerLabel = providerDisplayName(acc.provider);
  const planBadge = acc.plan_hint
    ? '<span class="plan-hint-badge">' + esc(acc.plan_hint) + '</span>'
    : '';
  const fiveHour = renderSummaryWindow('5시간 누적', acc.five_hour, providerLabel);
  const weekly = renderSummaryWindow('주간', acc.weekly, providerLabel);
  const sep = (fiveHour && weekly) ? '<span class="summary-sep">·</span>' : '';
  // S-01: weekly.minimal_mode_active 시 row 끝에 "최소 모드" 배지 (V-04: title에 "주간" 명시)
  const minimalBadge = (acc.weekly && acc.weekly.minimal_mode_active)
    ? '<span class="minimal-mode-badge" title="주간 최소 모드 활성">최소 모드</span>'
    : '';
  // S-06: status dot (api_error → red, consecutive_failures>0 → orange, else none)
  let statusDot = '';
  if (acc.api_error) {
    const errMsg = String(acc.api_error).slice(0, 100);
    statusDot = '<span class="status-dot status-dot-error" title="API 오류: ' + esc(errMsg) + '" ' +
      'aria-label="API 오류 발생: ' + esc(errMsg) + '" role="img"></span>';
  } else if (typeof acc.consecutive_failures === 'number' && acc.consecutive_failures > 0) {
    const n = acc.consecutive_failures;
    statusDot = '<span class="status-dot status-dot-warn" title="연속 실패 ' + n + '회" ' +
      'aria-label="연속 실패 ' + n + '회" role="img"></span>';
  }
  // --- AI Usage iter5 (task #80) V-02-b: status-dot provider 옆에 배치 → narrow wrap 시 귀속 명확
  return (
    '<div class="ai-usage-summary-row" data-provider="' + esc(acc.provider || '') + '" data-account-id="' + esc(acc.account_id || '') + '">' +
      '<span class="row-identity">' +
        '<span class="provider-badge">' + esc(providerLabel) + '</span>' +
        planBadge +
        statusDot +
      '</span>' +
      fiveHour +
      sep +
      weekly +
      minimalBadge +
    '</div>'
  );
}

// --- AI Usage iter2 (task #79) --- U-01 + D-01: reset 시간 강조 + ARIA
// --- AI Usage M-01 mobile (task #80): 요약 박스는 compact reset 텍스트 사용 ---
// --- AI Usage iter6 (task #80) C-01: data-mobile-label 속성 추가 (모바일 @media::before 축약 대응) ---
const SUMMARY_WINDOW_MOBILE_LABEL: Record<string, string> = {
  '5시간 누적': '5h',
  '주간': '주간',
};
function renderSummaryWindow(label, win, providerLabel) {
  if (!win || typeof win !== 'object') return '';
  const ratio = typeof win.ratio === 'number' ? Math.max(0, Math.min(1, win.ratio)) : 0;
  const pct = Math.round(ratio * 100);
  const level = typeof win.level === 'string' ? win.level.toLowerCase() : 'none';
  // M-01: 요약 박스는 항상 compact reset 텍스트 ("3h 19m" 등), 탭 카드(renderWindow)는 full 유지
  const resetText = win.resets_at ? formatRelativeFutureCompact(win.resets_at) : '';
  const fullResetText = win.resets_at ? formatRelativeFuture(win.resets_at) : '';
  const resetHtml = resetText
    ? '<span class="window-resets" title="' + esc(fullResetText) + '"><span class="reset-icon" aria-hidden="true">⏰</span>' + esc(resetText) + '</span>'
    : '';
  const ariaLabel = (providerLabel ? providerLabel + ' ' : '') + label + ' 사용량 ' + pct + ' 퍼센트';
  // C-01: data-mobile-label — @media::before content: attr(data-mobile-label) 로 모바일 축약 렌더링
  const mobileLabel = SUMMARY_WINDOW_MOBILE_LABEL[label] ?? label;
  // --- AI Usage iter3 (task #79) S-02: 4토큰(label/percent/progress/resets)을 summary-win wrapper로 묶어 narrow viewport wrap 단위 보장
  return (
    '<span class="summary-win">' +
      '<span class="window-label" data-mobile-label="' + esc(mobileLabel) + '">' + esc(label) + '</span>' +
      '<span class="window-percent">' + pct + '%</span>' +
      '<div class="mini-progress" title="' + esc(String(win.level || 'NONE')) + '" ' +
        'role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" ' +
        'aria-label="' + esc(ariaLabel) + '">' +
        '<div class="mini-progress-fill level-' + esc(level) + '" style="width:' + pct + '%;"></div>' +
      '</div>' +
      resetHtml +
    '</span>'
  );
}

// --- AI Usage iter2 (task #79) --- D-10: "5시간 창" → "5시간 누적"
function renderAiUsageCard(acc) {
  if (!acc || typeof acc !== 'object') return '';
  const providerLabel = providerDisplayName(acc.provider);
  const planBadge = acc.plan_hint
    ? '<span class="plan-badge">' + esc(acc.plan_hint) + '</span>'
    : '';
  const fiveHourHtml = acc.five_hour ? renderWindow('5h', '5시간 누적', acc.five_hour, providerLabel) : '';
  const weeklyHtml = acc.weekly ? renderWindow('weekly', '주간', acc.weekly, providerLabel) : '';
  const footer = renderCardFooter(acc);
  return (
    '<div class="ai-usage-card" data-account-id="' + esc(acc.account_id) + '">' +
      '<div class="account-hdr">' +
        '<span class="account-name">' + esc(acc.account_id || '(unknown)') + '</span>' +
        '<span class="provider-badge provider-badge--strong">' + esc(providerLabel) + '</span>' +
      '</div>' +
      (planBadge ? '<div>' + planBadge + '</div>' : '') +
      fiveHourHtml +
      weeklyHtml +
      footer +
    '</div>'
  );
}

function providerDisplayName(provider) {
  if (!provider) return 'unknown';
  const p = String(provider);
  if (p === 'anthropic-claude') return 'Claude';
  if (p === 'openai-codex') return 'Codex';
  return p;
}

// --- AI Usage iter5 (task #80) V-01: 색약 보조 아이콘 맵 ---
function levelIcon(level) {
  switch ((level || '').toLowerCase()) {
    case 'none':   return '✓';
    case 'info':   return 'ⓘ';
    case 'warn':   return '⚠';
    case 'danger': return '▲';
    case 'stop':   return '⛔';
    default:       return '';
  }
}

// --- AI Usage iter2 (task #79) --- U-01 + D-01 + D-08: reset 승격, ARIA, 한글 "최소 모드"
function renderWindow(kind, label, win, providerLabel) {
  if (!win || typeof win !== 'object') return '';
  const ratio = typeof win.ratio === 'number' ? Math.max(0, Math.min(1, win.ratio)) : 0;
  const pct = Math.round(ratio * 100);
  const level = typeof win.level === 'string' ? win.level.toLowerCase() : 'none';
  const levelCls = 'level-' + level;
  const resetText = win.resets_at ? formatRelativeFuture(win.resets_at) : '';
  const resetHtml = resetText
    ? '<span class="window-resets" title="리셋 예정"><span class="reset-icon" aria-hidden="true">⏰</span>' + esc(resetText) + '</span>'
    : '';
  const minimalMode = win.minimal_mode_active
    ? '<span class="minimal-mode-badge" title="최소 모드 활성">최소 모드</span>'
    : '';
  const ariaLabel = (providerLabel ? providerLabel + ' ' : '') + label + ' 사용량 ' + pct + ' 퍼센트';
  return (
    '<div class="ai-usage-window" data-kind="' + esc(kind) + '">' +
      '<div class="window-hdr">' +
        '<span class="window-label">' + esc(label) + minimalMode + '</span>' +
        resetHtml +
      '</div>' +
      '<div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" ' +
        'aria-label="' + esc(ariaLabel) + '">' +
        '<div class="progress-fill ' + levelCls + '" style="width:' + pct + '%;"></div>' +
      '</div>' +
      '<div class="window-footer">' +
        /* --- AI Usage iter5 (task #80) V-01: 색약 보조 아이콘 --- */
        '<span class="level-badge ' + levelCls + '">' +
          '<span class="level-icon" aria-hidden="true">' + levelIcon(level) + '</span> ' +
          esc(win.level || 'NONE') +
        '</span>' +
        '<span>' + pct + '%</span>' +
      '</div>' +
    '</div>'
  );
}

// --- AI Usage iter2 (task #79) --- D-05: footer 위계 (api_error 큰 글씨 → fail count → last_success 작게)
function renderCardFooter(acc) {
  const parts = [];
  if (acc.api_error) {
    parts.push('<span class="api-error" title="' + esc(String(acc.api_error)) + '">' +
      '<span class="err-icon" aria-hidden="true">⚠</span>API 에러</span>');
  }
  if (typeof acc.consecutive_failures === 'number' && acc.consecutive_failures > 0) {
    parts.push('<span class="fail-count">연속 실패 ' + acc.consecutive_failures + '회</span>');
  }
  // D-05: api_error 없을 때만 last_success_at 표시 — 에러가 묻히지 않도록
  if (!acc.api_error && acc.last_success_at) {
    parts.push('<span class="last-success">마지막 성공: ' + esc(formatRelativePast(acc.last_success_at)) + '</span>');
  }
  if (parts.length === 0) return '';
  return '<div class="ai-usage-footer">' + parts.join('') + '</div>';
}

// --- AI Usage iter3 (task #79) --- Z-02: SSE disconnect banner helpers
function showAiUsageDisconnectBanner() {
  const banner = document.getElementById('ai-usage-disconnect-banner');
  if (banner) banner.classList.add('visible');
}
function hideAiUsageDisconnectBanner() {
  const banner = document.getElementById('ai-usage-disconnect-banner');
  if (banner) banner.classList.remove('visible');
}

function subscribeAiUsageSSE() {
  if (aiUsageState.eventSource) {
    try { aiUsageState.eventSource.close(); } catch(e) {}
    aiUsageState.eventSource = null;
  }
  let es;
  try {
    es = new EventSource('/api/v1/admin/ai-usage/stream');
  } catch(e) {
    // Construction failed — treat as disconnected
    showAiUsageDisconnectBanner();
    return;
  }
  aiUsageState.eventSource = es;
  es.addEventListener('ai-usage-update', (ev) => {
    try {
      const snap = JSON.parse(ev.data);
      // --- AI Usage iter5 (task #80) S-04: snapshot 수신 시 load timeout 취소 ---
      if (aiUsageState.loadTimeoutId) {
        clearTimeout(aiUsageState.loadTimeoutId);
        aiUsageState.loadTimeoutId = null;
      }
      renderAiUsage(snap);
      // Successful frame → connection healthy, hide banner
      hideAiUsageDisconnectBanner();
    } catch(e) { /* keep previous snapshot on parse error */ }
  });
  es.addEventListener('ping', () => { /* heartbeat — no-op */ });
  // --- AI Usage iter3 (task #79) --- Z-02: onopen / onerror for disconnect banner
  es.onopen = () => {
    hideAiUsageDisconnectBanner();
  };
  es.onerror = () => {
    // EventSource auto-reconnects; show banner while readyState != OPEN
    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
    if (es.readyState !== 1) {
      showAiUsageDisconnectBanner();
    }
  };
}

function disconnectAiUsageStream() {
  if (aiUsageState.eventSource) {
    try { aiUsageState.eventSource.close(); } catch(e) {}
    aiUsageState.eventSource = null;
  }
  if (aiUsageState.stalenessTicker) {
    clearInterval(aiUsageState.stalenessTicker);
    aiUsageState.stalenessTicker = null;
  }
}

function startStalenessTicker() {
  if (aiUsageState.stalenessTicker) clearInterval(aiUsageState.stalenessTicker);
  aiUsageState.stalenessTicker = setInterval(updateStalenessTicker, 30000);
}

function updateStalenessTicker() {
  updateAiUsageMeta();
  // Also refresh relative times inside cards (last_success_at / resets_at)
  // by re-rendering with the preserved snapshot — cheap for small grids.
  if (aiUsageState.snapshot) renderAiUsage(aiUsageState.snapshot);
}

function updateAiUsageMeta() {
  const meta = document.getElementById('aiUsageMeta');
  const metaText = document.getElementById('aiUsageMetaText');
  const summary = document.getElementById('ai-usage-summary');
  const snap = aiUsageState.snapshot;
  if (!snap || !snap.last_updated_at) {
    if (metaText) metaText.textContent = '대기 중...';
    if (meta) meta.classList.remove('stale');
    if (summary) summary.classList.remove('stale');
    return;
  }
  const ts = Date.parse(snap.last_updated_at);
  const age = Date.now() - ts;
  const rel = formatRelativePast(snap.last_updated_at);
  const grid = document.getElementById('aiUsageGrid');
  if (age > AI_USAGE_STALE_MS) {
    if (meta) meta.classList.add('stale');
    if (metaText) metaText.innerHTML = '<span class="warn-icon">⚠</span> 갱신 지연 · 마지막 갱신 ' + esc(rel);
    if (grid) grid.querySelectorAll('.ai-usage-card').forEach(c => c.classList.add('stale'));
    if (summary) summary.classList.add('stale');
  } else {
    if (meta) meta.classList.remove('stale');
    if (metaText) metaText.textContent = '마지막 갱신: ' + rel;
    if (grid) grid.querySelectorAll('.ai-usage-card').forEach(c => c.classList.remove('stale'));
    if (summary) summary.classList.remove('stale');
  }
}

function formatRelativePast(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = Date.now() - t;
  if (diff < 0) return '방금';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + '초 전';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 ' + (m % 60) + '분 전';
  const d = Math.floor(h / 24);
  return d + '일 전';
}

function formatRelativeFuture(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = t - Date.now();
  if (diff <= 0) return '리셋됨';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + '초 뒤 리셋';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분 뒤 리셋';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return h + '시간 ' + rem + '분 뒤 리셋';
  const d = Math.floor(h / 24);
  return d + '일 뒤 리셋';
}

// --- AI Usage M-01 mobile (task #80): 요약 박스 전용 compact reset helper ---
// 변환 예시: "3h 19m" / "55m" / "3d" / "리셋됨"
function formatRelativeFutureCompact(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = t - Date.now();
  if (diff <= 0) return '리셋됨';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? h + 'h ' + rem + 'm' : h + 'h';
  const d = Math.floor(h / 24);
  return d + 'd';
}

loadPending();
loadUsers();
// Auto-initialize AI Usage summary box on page load (task #79 follow-up).
// Always-visible summary box + 5-min auto refresh via SSE, regardless of tab.
if (document.getElementById('ai-usage-summary') && !aiUsageState.initialized) {
  aiUsageState.initialized = true;
  initAiUsage();
}
</script>
</body>
</html>`)
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
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

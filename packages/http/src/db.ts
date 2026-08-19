/**
 * SQLite database layer for agent-mesh HTTP API.
 * Uses bun:sqlite with WAL mode for concurrent read performance.
 */

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { checkpointForShutdown, openAt, stateDir } from '@agent-mesh/store'

const DB_PATH = join(stateDir(), 'agent-mesh.db')
const LEGACY_REGISTRY_FILE = join(stateDir(), 'registry.json')

let _db: Database | null = null

/**
 * `agent-mesh.db` is this service's own store — users, policies, approvals,
 * push subscriptions, the agent registry. Nothing else opens it, which is why
 * it is not one of the shared stores in @agent-mesh/store.
 */
export function getDb(): Database {
  if (_db) return _db

  _db = openAt(DB_PATH, { create: true })

  _db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to TEXT,
      status TEXT DEFAULT 'pending',
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Migration: add file_path column (idempotent)
  try {
    _db.exec(`ALTER TABLE messages ADD COLUMN file_path TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Index for fetching history by agent
  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent)
  `)
  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent)
  `)

  // Auth tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      github_id INTEGER PRIMARY KEY,
      github_login TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_login TEXT NOT NULL,
      allowed_agent TEXT NOT NULL,
      UNIQUE(github_login, allowed_agent)
    )
  `)

  _db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      github_login TEXT PRIMARY KEY,
      github_id INTEGER NOT NULL,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending'
    )
  `)

  _db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_login TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  _db.exec(`
    CREATE TABLE IF NOT EXISTS local_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'member',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  ensureAgentRegistrySchema(_db)
  importLegacyRegistry(_db)

  return _db
}

/**
 * The http-server's own agent list. Distinct from the hub's `agents` table
 * (hub.db), which this process only ever reads. Named `agent_registry` so the
 * two are not confused at a call site.
 */
export function ensureAgentRegistrySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      channel TEXT NOT NULL DEFAULT 'native',
      type TEXT NOT NULL DEFAULT 'agent',
      approved INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_registry_type_approved
      ON agent_registry(type, approved)
  `)
}

/**
 * One-time import of the pre-DB `registry.json` file store.
 *
 * Runs only while the table is empty, so an operator editing the JSON after the
 * import will not silently resurrect stale rows — the table is the source of
 * truth from the first successful import onward. The file is left on disk
 * rather than deleted; it costs nothing and is the only copy of the prior state
 * if an import needs to be reviewed.
 */
export function importLegacyRegistry(db: Database, registryPath: string = LEGACY_REGISTRY_FILE): void {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_registry').get() as { cnt: number }
  if (row.cnt > 0) return
  if (!existsSync(registryPath)) return

  type LegacyEntry = {
    name?: string
    description?: string
    channel?: string
    type?: string
    approved?: boolean
  }

  let agents: Record<string, LegacyEntry>
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { agents?: Record<string, LegacyEntry> }
    agents = parsed.agents ?? {}
  } catch (error) {
    console.error(`[db] could not read ${registryPath}, skipping registry import:`, error)
    return
  }

  const entries = Object.entries(agents)
  if (entries.length === 0) return

  // Same defaults the old loadRegistry() applied on read.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agent_registry (id, name, description, channel, type, approved)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const importAll = db.transaction((rows: Array<[string, LegacyEntry]>) => {
    for (const [id, entry] of rows) {
      insert.run(
        id,
        entry.name ?? id,
        entry.description ?? null,
        entry.channel ?? 'native',
        entry.type ?? 'agent',
        entry.approved === false ? 0 : 1,
      )
    }
  })
  importAll(entries)
  console.log(`[db] imported ${entries.length} agent(s) from ${registryPath} into agent_registry`)
}

// --- Agent registry ---

export type DbRegistryAgent = {
  id: string
  name: string
  description: string | null
  channel: string
  type: string
  approved: number
  created_at: string
  updated_at: string
}

export function listRegistryAgents(): DbRegistryAgent[] {
  const db = getDb()
  return db.prepare('SELECT * FROM agent_registry ORDER BY id ASC').all() as DbRegistryAgent[]
}

export function getRegistryAgent(id: string): DbRegistryAgent | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM agent_registry WHERE id = ?').get(id) as DbRegistryAgent) ?? null
}

export function countRegistryAgents(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_registry').get() as { cnt: number }
  return row.cnt
}

export function listRegistryAgentIds(): string[] {
  const db = getDb()
  const rows = db.prepare('SELECT id FROM agent_registry ORDER BY id ASC').all() as Array<{ id: string }>
  return rows.map(r => r.id)
}

/** Approved web users the http-server declares as `proxy_for` on mesh.connect. */
export function listApprovedWebUserIds(): string[] {
  const db = getDb()
  const rows = db.prepare(
    "SELECT id FROM agent_registry WHERE type = 'user' AND approved = 1 ORDER BY id ASC",
  ).all() as Array<{ id: string }>
  return rows.map(r => r.id)
}

export function isRegistryAgentApproved(id: string): boolean {
  const entry = getRegistryAgent(id)
  return entry !== null && entry.approved === 1
}

/** Register an approved web user, or approve one that already exists. */
export function upsertApprovedWebUser(githubLogin: string): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO agent_registry (id, name, channel, type, approved)
    VALUES (?, ?, 'web', 'user', 1)
    ON CONFLICT(id) DO UPDATE SET approved = 1, updated_at = CURRENT_TIMESTAMP
  `).run(githubLogin, githubLogin)
}

export type DbMessage = {
  id: string
  from_agent: string
  to_agent: string
  content: string
  reply_to: string | null
  file_path: string | null
  status: string
  ts: string
}

export function insertMessage(msg: {
  id: string
  from: string
  to: string
  content: string
  reply_to?: string
  file_path?: string
  status: string
  ts: string
}): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (id, from_agent, to_agent, content, reply_to, file_path, status, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(msg.id, msg.from, msg.to, msg.content, msg.reply_to ?? null, msg.file_path ?? null, msg.status, msg.ts)
}

/**
 * Correct a message's status once its fate is known.
 *
 * **The row is written before the hub is asked**, because a message that
 * reaches storage and then fails to route is recoverable and one that is
 * routed and never stored is not. The consequence is that the status inserted
 * is a guess, and until this existed nothing ever revised it: a send the hub
 * refused was answered `failed` to the caller and left `pending` in the table,
 * so the response and the record disagreed and every later read — the history
 * route, the conversation view, search — served the record.
 *
 * Reports whether it matched, because the id comes from a caller in some paths
 * and a silent no-op is how a correction stops happening without anything
 * saying so.
 */
export function updateMessageStatus(id: string, status: string): boolean {
  const db = getDb()
  const result = db.prepare(`UPDATE messages SET status = ? WHERE id = ?`).run(status, id)
  return result.changes > 0
}

export function getMessageHistory(agent: string, limit: number = 20): DbMessage[] {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT id, from_agent, to_agent, content, reply_to, file_path, status, ts
    FROM messages
    WHERE from_agent = ? OR to_agent = ?
    ORDER BY ts DESC
    LIMIT ?
  `)
  const rows = stmt.all(agent, agent, limit) as DbMessage[]
  return rows.reverse() // chronological order
}

export function getConversation(agent1: string, agent2: string, limit: number = 20): DbMessage[] {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT id, from_agent, to_agent, content, reply_to, file_path, status, ts
    FROM messages
    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
    ORDER BY ts DESC
    LIMIT ?
  `)
  const rows = stmt.all(agent1, agent2, agent2, agent1, limit) as DbMessage[]
  return rows.reverse() // chronological order
}

// --- User management ---

export type DbUser = {
  github_id: number
  github_login: string
  role: string
  created_at: string
}

export function upsertUser(githubId: number, githubLogin: string): DbUser {
  const db = getDb()

  // Check if this is the very first user — they become admin
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }
  const isFirstUser = countRow.cnt === 0

  const role = isFirstUser ? 'admin' : 'member'

  db.prepare(`
    INSERT INTO users (github_id, github_login, role)
    VALUES (?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login
  `).run(githubId, githubLogin, role)

  // If first user, grant wildcard access
  if (isFirstUser) {
    db.prepare(`
      INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, '*')
    `).run(githubLogin)
  }

  return db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as DbUser
}

export function getUser(githubId: number): DbUser | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as DbUser) ?? null
}

export type DbPolicy = {
  id: number
  github_login: string
  allowed_agent: string
}

export function getUserPolicies(githubLogin: string): DbPolicy[] {
  const db = getDb()
  return db.prepare('SELECT * FROM policies WHERE github_login = ?').all(githubLogin) as DbPolicy[]
}

export function isAllowedToMessage(githubLogin: string, role: string, targetAgent: string): boolean {
  // Admin can message any agent
  if (role === 'admin') return true

  const policies = getUserPolicies(githubLogin)
  return policies.some(p => p.allowed_agent === '*' || p.allowed_agent === targetAgent)
}

// --- Pending Approvals ---

export type DbPendingApproval = {
  github_login: string
  github_id: number
  requested_at: string
  status: string
}

export function createPendingApproval(githubLogin: string, githubId: number): DbPendingApproval {
  const db = getDb()
  db.prepare(`
    INSERT OR IGNORE INTO pending_approvals (github_login, github_id, status)
    VALUES (?, ?, 'pending')
  `).run(githubLogin, githubId)
  return db.prepare('SELECT * FROM pending_approvals WHERE github_login = ?').get(githubLogin) as DbPendingApproval
}

export function getPendingApproval(githubLogin: string): DbPendingApproval | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM pending_approvals WHERE github_login = ?').get(githubLogin) as DbPendingApproval) ?? null
}

export function listPendingApprovals(): DbPendingApproval[] {
  const db = getDb()
  return db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY requested_at ASC").all() as DbPendingApproval[]
}

export function approveUser(githubLogin: string): boolean {
  const db = getDb()
  const result = db.prepare("UPDATE pending_approvals SET status = 'approved' WHERE github_login = ? AND status = 'pending'").run(githubLogin)
  return result.changes > 0
}

export function denyUser(githubLogin: string): boolean {
  const db = getDb()
  const result = db.prepare("UPDATE pending_approvals SET status = 'denied' WHERE github_login = ? AND status = 'pending'").run(githubLogin)
  return result.changes > 0
}

export function searchMessages(query: string, userLogin: string, limit: number = 50): DbMessage[] {
  const db = getDb()
  // Escape LIKE special characters
  const escaped = query.replace(/[%_]/g, ch => '\\' + ch)
  const pattern = `%${escaped}%`
  const stmt = db.prepare(`
    SELECT id, from_agent, to_agent, content, reply_to, file_path, status, ts
    FROM messages
    WHERE content LIKE ? ESCAPE '\\'
      AND (from_agent = ? OR to_agent = ?)
    ORDER BY ts DESC
    LIMIT ?
  `)
  return stmt.all(pattern, userLogin, userLogin, limit) as DbMessage[]
}

// --- Push Subscriptions ---

export type DbPushSubscription = {
  id: number
  github_login: string
  endpoint: string
  p256dh: string
  auth: string
  created_at: string
}

export function savePushSubscription(githubLogin: string, sub: { endpoint: string, keys: { p256dh: string, auth: string } }): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO push_subscriptions (github_login, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
  `).run(githubLogin, sub.endpoint, sub.keys.p256dh, sub.keys.auth)
}

export function getPushSubscriptions(githubLogin: string): DbPushSubscription[] {
  const db = getDb()
  return db.prepare('SELECT * FROM push_subscriptions WHERE github_login = ?').all(githubLogin) as DbPushSubscription[]
}

export function deletePushSubscription(endpoint: string): void {
  const db = getDb()
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
}

// --- Local Users ---

export type DbLocalUser = {
  id: number
  username: string
  password_hash: string
  display_name: string | null
  role: string
  created_at: string
}

export function createLocalUser(username: string, passwordHash: string, displayName?: string, role?: string): DbLocalUser {
  const db = getDb()
  db.prepare(`
    INSERT INTO local_users (username, password_hash, display_name, role)
    VALUES (?, ?, ?, ?)
  `).run(username, passwordHash, displayName ?? null, role ?? 'member')
  return db.prepare('SELECT * FROM local_users WHERE username = ?').get(username) as DbLocalUser
}

export function getLocalUser(username: string): DbLocalUser | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM local_users WHERE username = ?').get(username) as DbLocalUser) ?? null
}

export async function verifyLocalUser(username: string, password: string): Promise<DbLocalUser | null> {
  const user = getLocalUser(username)
  if (!user) return null
  const valid = await Bun.password.verify(password, user.password_hash)
  return valid ? user : null
}

export async function seedLocalUsers(): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as cnt FROM local_users').get() as { cnt: number }
  if (row.cnt === 0) {
    // **`admin`/`admin` unless the deployment says otherwise.**
    //
    // The quickstart signs in with it and so does every test, so removing it
    // would break the documented path on the machine it was written for. On a
    // host that is not that machine it is a published password: anyone who can
    // reach the page can try it, and the front end used to fill both boxes in
    // for them (fixed by agent-mesh-local-pm in `963465a`).
    //
    // So a deployment states one, and one that does not is told what it has.
    // Not a refusal to start — that would take the local path away to close a
    // hole the local path does not have — and not a random password either,
    // which would only be printed once and lost.
    const supplied = process.env.AGENT_MESH_ADMIN_PASSWORD
    const hash = await Bun.password.hash(supplied ?? 'admin', { algorithm: 'bcrypt' })
    createLocalUser('admin', hash, 'Admin', 'admin')
    if (supplied) {
      console.log('[db] seeded admin local user with AGENT_MESH_ADMIN_PASSWORD')
    } else {
      console.warn(
        '[db] seeded admin local user with the default password `admin`. ' +
          'Set AGENT_MESH_ADMIN_PASSWORD before first boot on any host others can reach.',
      )
    }
  }

  // Every local user is also a web user, and therefore a mesh participant.
  //
  // They were not, and the effect was silent: only the GitHub approval flow
  // called `upsertApprovedWebUser`, so a local user never appeared in the
  // registry, was never in the http server's `proxy_for`, and every message
  // they sent was refused by entitlement — a refusal the send path swallowed.
  // Messages showed in the UI because they had already been written locally,
  // and never reached the mesh.
  for (const user of db.prepare('SELECT username FROM local_users').all() as Array<{ username: string }>) {
    upsertApprovedWebUser(user.username)
  }
}

export function closeDb(): void {
  if (_db) {
    // Fold the log first. `close()` does not, whenever a statement is still
    // prepared against the handle — and whether one is at exit depends on when
    // the collector last ran, which is not something a shutdown path should
    // rest on. It was measured both ways here: `agent-mesh.db` folded on a
    // bare close, `audit.db` did not, in the same process on the same run.
    checkpointForShutdown(_db)
    _db.close()
    _db = null
  }
}

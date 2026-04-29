/**
 * SelfReminder service — PoC1
 *
 * 최소 구현: 1초 폴링 + claim + hub.mesh.send 발사.
 * 이번 PoC는 `once` 타입만 지원. cron/interval은 PoC2에서.
 *
 * 설계서: /home/ubuntu/ai/workspaces/arumi/tmp/self-reminder-design.md
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { CronExpressionParser } from "cron-parser";

const STATE_DIR =
  process.env.AGENT_MESH_STATE_DIR ?? "/srv/agent-mesh-lab/state/shared";
const DB_PATH =
  process.env.SELF_REMINDER_DB ??
  `${STATE_DIR}/self-reminder.db`;
const HUB_URL =
  process.env.HUB_URL ??
  process.env.AGENT_MESH_HUB_URL ??
  "ws://127.0.0.1:3100/ws";
const IDENTITY = process.env.SELF_REMINDER_IDENTITY ?? "self-reminder";
const POLL_MS = Number(process.env.SELF_REMINDER_POLL_MS ?? 1000);

function log(...args: unknown[]) {
  console.log(`[self-reminder ${new Date().toISOString()}]`, ...args);
}

// ---------------- DB ----------------
const db = new Database(DB_PATH, { create: true });
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA busy_timeout = 5000;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('once','cron','interval')),
    schedule_spec   TEXT NOT NULL,
    payload         TEXT NOT NULL,
    context         TEXT,
    idempotency_key TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','firing','paused','fired','cancelled','exhausted','dead')),
    next_fire_at    DATETIME,
    fire_count      INTEGER NOT NULL DEFAULT 0,
    last_fired_at   DATETIME,
    created_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    created_by      TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_idem_active
    ON reminders (agent_id, idempotency_key)
    WHERE status = 'active' AND idempotency_key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders (next_fire_at)
    WHERE status = 'active' AND next_fire_at IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders (agent_id, status);

  CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id     TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    scheduled_at    DATETIME NOT NULL,
    fired_at        DATETIME NOT NULL DEFAULT (datetime('now')),
    delivery_status TEXT NOT NULL CHECK (delivery_status IN ('firing','delivered','queued','failed','skipped','dedup')),
    hub_msg_id      TEXT,
    attempt         INTEGER NOT NULL DEFAULT 1,
    error           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_reminder ON audit_log (reminder_id, fired_at);
  CREATE INDEX IF NOT EXISTS idx_audit_agent_time ON audit_log (agent_id, fired_at DESC);
`);

const stmtSelectDue = db.prepare(`
  SELECT id, agent_id, type, schedule_spec, payload, context, next_fire_at
    FROM reminders
   WHERE status = 'active' AND next_fire_at <= datetime('now')
   ORDER BY next_fire_at ASC LIMIT 100
`);

const stmtClaim = db.prepare(`
  UPDATE reminders
     SET status = 'firing', updated_at = datetime('now')
   WHERE id = ? AND status = 'active'
`);

const stmtMarkFired = db.prepare(`
  UPDATE reminders
     SET status = 'fired',
         fire_count = fire_count + 1,
         last_fired_at = datetime('now'),
         updated_at = datetime('now'),
         next_fire_at = NULL
   WHERE id = ?
`);

const stmtAdvanceCron = db.prepare(`
  UPDATE reminders
     SET fire_count = fire_count + 1,
         last_fired_at = datetime('now'),
         updated_at = datetime('now'),
         status = 'active',
         next_fire_at = ?
   WHERE id = ?
`);

const stmtMarkDead = db.prepare(`
  UPDATE reminders SET status = 'dead', updated_at = datetime('now') WHERE id = ?
`);

const stmtRevertToActive = db.prepare(`
  UPDATE reminders SET status = 'active', updated_at = datetime('now') WHERE id = ?
`);

const stmtInsertAudit = db.prepare(`
  INSERT INTO audit_log (reminder_id, agent_id, scheduled_at, delivery_status, hub_msg_id, attempt, error)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Startup: recover stuck 'firing' rows (crash recovery — at-least-once)
const recovered = db
  .prepare(
    `UPDATE reminders SET status = 'active', updated_at = datetime('now') WHERE status = 'firing'`
  )
  .run();
if (recovered.changes > 0) log(`recovered ${recovered.changes} stuck 'firing' rows`);

// ---------------- Hub WebSocket ----------------
let hubWs: WebSocket | null = null;
let hubReady = false;
const pendingRpc = new Map<string, (res: any) => void>();

function hubConnect() {
  log(`connecting to hub ${HUB_URL} as ${IDENTITY}`);
  const ws = new WebSocket(HUB_URL);
  hubWs = ws;
  hubReady = false;

  ws.on("open", () => {
    log("hub ws open — registering");
    rpc("mesh.connect", { identity: IDENTITY, description: "SelfReminder service (PoC1)" })
      .then(() => {
        hubReady = true;
        log("hub registered");
      })
      .catch((err) => log("register failed:", err));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pendingRpc.has(String(msg.id))) {
        const resolve = pendingRpc.get(String(msg.id))!;
        pendingRpc.delete(String(msg.id));
        resolve(msg);
      }
      // We ignore notifications/* — service doesn't consume inbound messages in PoC1
    } catch (err) {
      log("hub msg parse error:", err);
    }
  });

  ws.on("close", (code, reason) => {
    log(`hub ws closed code=${code} reason="${reason?.toString() ?? ""}" — reconnect in 3s`);
    hubReady = false;
    hubWs = null;
    setTimeout(hubConnect, 3000);
  });

  ws.on("error", (err) => {
    log("hub ws error:", err.message);
  });
}

function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!hubWs || hubWs.readyState !== WebSocket.OPEN) {
      reject(new Error("hub ws not open"));
      return;
    }
    const id = randomUUID();
    pendingRpc.set(id, (res) => {
      if (res.error) reject(new Error(res.error.message ?? "rpc error"));
      else resolve(res.result);
    });
    hubWs.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pendingRpc.has(id)) {
        pendingRpc.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }
    }, 10000);
  });
}

// ---------------- Formatter ----------------
function formatPayload(r: {
  id: string;
  type: string;
  payload: string;
  context: string | null;
  next_fire_at: string;
}): string {
  const scheduled = r.next_fire_at.replace(" ", "T") + "Z";
  const fired = new Date().toISOString();

  // Extract task_id from context (if context is JSON and has task_id).
  let taskId: string | null = null;
  let parsedCtx: Record<string, unknown> | null = null;
  if (r.context) {
    try {
      const parsed = JSON.parse(r.context);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedCtx = parsed as Record<string, unknown>;
        if (typeof parsedCtx.task_id === "string") {
          taskId = parsedCtx.task_id;
        }
      }
    } catch {
      /* context not JSON — leave task_id null */
    }
  }

  const taskSuffix = taskId ? ` task=${taskId}` : "";
  const header = `[SELF-REMINDER ${r.id} scheduled=${scheduled} fired=${fired} type=${r.type}${taskSuffix}]`;
  let body = `${header}\n${r.payload}`;
  if (r.context) {
    if (parsedCtx) {
      // JSON context — put task_id first (if present), then remaining keys in original order.
      const entries = Object.entries(parsedCtx);
      const sorted = taskId
        ? [
            ["task_id", taskId] as [string, unknown],
            ...entries.filter(([k]) => k !== "task_id"),
          ]
        : entries;
      const lines = sorted.map(([k, v]) => `${k}: ${v}`).join("\n");
      if (lines) body += `\n\n--- context ---\n${lines}\n`;
    } else {
      /* context가 JSON이 아니면 그냥 문자열 붙임 */
      body += `\n\n--- context ---\n${r.context}\n`;
    }
  }
  return body;
}

// ---------------- Schedule advancement ----------------
function advanceOrComplete(r: {
  id: string;
  type: string;
  schedule_spec: string;
}): void {
  if (r.type === "once") {
    stmtMarkFired.run(r.id);
    return;
  }
  if (r.type === "cron") {
    try {
      const spec = JSON.parse(r.schedule_spec) as { cron: string; tz?: string };
      if (!spec.cron) throw new Error("cron field missing in schedule_spec");
      const iter = CronExpressionParser.parse(spec.cron, { tz: spec.tz ?? "UTC" });
      // Produce the next occurrence strictly after now.
      const nextDate = iter.next().toDate();
      // SQLite datetime expects 'YYYY-MM-DD HH:MM:SS' in UTC.
      const nextUtc = nextDate.toISOString().replace("T", " ").slice(0, 19);
      stmtAdvanceCron.run(nextUtc, r.id);
      log(`advanced cron ${r.id} → next=${nextUtc} (spec=${spec.cron} tz=${spec.tz ?? "UTC"})`);
    } catch (err: any) {
      stmtMarkDead.run(r.id);
      log(`cron advance failed for ${r.id}: ${err?.message ?? err} → status=dead`);
    }
    return;
  }
  // interval: PoC2 범위 밖. 현 단계는 fired로 종결.
  stmtMarkFired.run(r.id);
}

// ---------------- Scheduler tick ----------------
async function tick() {
  if (!hubReady) return;

  const due = stmtSelectDue.all() as Array<{
    id: string;
    agent_id: string;
    type: string;
    schedule_spec: string;
    payload: string;
    context: string | null;
    next_fire_at: string;
  }>;
  if (due.length === 0) return;

  for (const r of due) {
    // Claim
    const claim = stmtClaim.run(r.id);
    if (claim.changes !== 1) continue; // already claimed by another tick/instance

    stmtInsertAudit.run(r.id, r.agent_id, r.next_fire_at, "firing", null, 1, null);

    try {
      const content = formatPayload(r);
      const res = await rpc("mesh.send", {
        from: r.agent_id,
        to: r.agent_id,
        content,
      });
      const auditStatus = res?.status === "pending" ? "queued" : "delivered";
      stmtInsertAudit.run(r.id, r.agent_id, r.next_fire_at, auditStatus, res?.id ?? null, 1, null);

      advanceOrComplete(r);
      log(`fired ${r.id} (${r.agent_id}): ${auditStatus}`);
    } catch (err: any) {
      stmtInsertAudit.run(r.id, r.agent_id, r.next_fire_at, "failed", null, 1, err?.message ?? String(err));
      stmtRevertToActive.run(r.id);
      log(`fire failed ${r.id}: ${err?.message ?? err}`);
    }
  }
}

// ---------------- Main ----------------
hubConnect();
setInterval(tick, POLL_MS);
log(`self-reminder started. db=${DB_PATH} poll=${POLL_MS}ms identity=${IDENTITY}`);

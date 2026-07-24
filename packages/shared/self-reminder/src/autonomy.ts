import { Database } from "bun:sqlite";

export type AutonomyLane = "A" | "B" | "C";
export type AutonomyTaskStatus = "active" | "blocked" | "failed" | "verified_done";
export type AutonomyEventKind =
  | "created"
  | "progress"
  | "heartbeat"
  | "nudge"
  | "escalated"
  | "blocked"
  | "gate_pass"
  | "gate_fail"
  | "verified_done";

export interface AutonomyTask {
  task_id: string;
  manifest_sha256: string;
  lane: AutonomyLane;
  owner: string;
  status: AutonomyTaskStatus;
  phase: string;
  last_progress_at: string;
  last_heartbeat_at: string | null;
  next_action: string;
  approval_ref: string | null;
  escalation_level: number;
  updated_at: string;
}

export interface CreateAutonomyTaskInput {
  taskId: string;
  manifestSha256: string;
  lane: AutonomyLane;
  owner: string;
  phase: string;
  nextAction: string;
  approvalRef?: string;
}

export interface ProgressAutonomyTaskInput {
  taskId: string;
  actor: string;
  phase: string;
  nextAction: string;
}

export interface BlockAutonomyTaskInput {
  taskId: string;
  actor: string;
  reasonCode: "security_boundary" | "approval_required" | "unknown_decision";
  nextAction: string;
}

export interface GateResultInput {
  taskId: string;
  actor: string;
  profile: string;
  result: "pass" | "fail";
  artifactRef: string;
}

export interface WatchdogOptions {
  now?: () => Date;
  heartbeatAfterMs?: number;
  nudgeAfterMs?: number;
  escalateAfterMs?: number;
  pmRecipient?: string;
  finjaRecipient?: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface WatchdogRunResult {
  heartbeats: number;
  nudges: number;
  escalations: number;
}

export type WatchdogSend = (recipient: string, content: string) => Promise<unknown>;

const SAFE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function utcNow(now: Date): string {
  return now.toISOString();
}

function parseUtc(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("stored autonomy timestamp is invalid");
  return parsed;
}

function assertLabel(value: string, field: string): void {
  if (!SAFE_LABEL.test(value)) throw new Error(`${field} must be a safe identifier`);
}

function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("manifestSha256 must be a lowercase SHA-256 digest");
}

function assertLane(value: string): asserts value is AutonomyLane {
  if (value !== "A" && value !== "B" && value !== "C") throw new Error("lane must be A, B, or C");
}

function assertBlockReason(value: string): asserts value is BlockAutonomyTaskInput["reasonCode"] {
  if (value !== "security_boundary" && value !== "approval_required" && value !== "unknown_decision") {
    throw new Error("blocked reason must be an approved code");
  }
}

function assertGateResult(value: string): asserts value is GateResultInput["result"] {
  if (value !== "pass" && value !== "fail") throw new Error("gate result must be pass or fail");
}

function assertTaskMutable(task: AutonomyTask): void {
  if (task.status !== "active") throw new Error(`task is not active: ${task.status}`);
}

function recipients(...items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Minimal, typed state store for autonomous work. The evidence payload is
 * intentionally assembled here from safe identifiers and enums only: callers
 * cannot attach task prose, command text, credentials, or arbitrary JSON.
 */
export class AutonomyTaskStore {
  private readonly now: () => Date;
  private readonly heartbeatAfterMs: number;
  private readonly nudgeAfterMs: number;
  private readonly escalateAfterMs: number;
  private readonly pmRecipient: string;
  private readonly finjaRecipient: string;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;

  constructor(private readonly db: Database, options: WatchdogOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.heartbeatAfterMs = options.heartbeatAfterMs ?? 15 * 60_000;
    this.nudgeAfterMs = options.nudgeAfterMs ?? 30 * 60_000;
    this.escalateAfterMs = options.escalateAfterMs ?? 45 * 60_000;
    this.pmRecipient = options.pmRecipient ?? "synapse-pm";
    this.finjaRecipient = options.finjaRecipient ?? "finja";
    this.log = options.log ?? (() => {});
    if (this.heartbeatAfterMs <= 0 || this.nudgeAfterMs <= this.heartbeatAfterMs || this.escalateAfterMs <= this.nudgeAfterMs) {
      throw new Error("watchdog thresholds must be strictly increasing positive durations");
    }
    assertLabel(this.pmRecipient, "pmRecipient");
    assertLabel(this.finjaRecipient, "finjaRecipient");
    this.migrate();
  }

  create(input: CreateAutonomyTaskInput, actor = "autonomy-runner"): AutonomyTask {
    assertLabel(input.taskId, "taskId");
    assertSha256(input.manifestSha256);
    assertLane(input.lane);
    assertLabel(input.owner, "owner");
    assertLabel(input.phase, "phase");
    assertLabel(input.nextAction, "nextAction");
    assertLabel(actor, "actor");
    if (input.lane === "C" && !input.approvalRef) throw new Error("lane C requires approvalRef");
    if (input.approvalRef) assertLabel(input.approvalRef, "approvalRef");
    const now = utcNow(this.now());
    this.db.prepare(`
      INSERT INTO autonomy_tasks (
        task_id, manifest_sha256, lane, owner, status, phase, last_progress_at,
        last_heartbeat_at, next_action, approval_ref, escalation_level, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, 0, ?)
    `).run(input.taskId, input.manifestSha256, input.lane, input.owner, input.phase, now, input.nextAction, input.approvalRef ?? null, now);
    this.record(input.taskId, "created", actor, { lane: input.lane, phase: input.phase }, now);
    return this.requireTask(input.taskId);
  }

  progress(input: ProgressAutonomyTaskInput): AutonomyTask {
    assertLabel(input.taskId, "taskId");
    assertLabel(input.actor, "actor");
    assertLabel(input.phase, "phase");
    assertLabel(input.nextAction, "nextAction");
    const existing = this.requireTask(input.taskId);
    assertTaskMutable(existing);
    const now = utcNow(this.now());
    this.db.prepare(`
      UPDATE autonomy_tasks
         SET phase = ?, next_action = ?, last_progress_at = ?, escalation_level = 0, updated_at = ?
       WHERE task_id = ? AND status = 'active'
    `).run(input.phase, input.nextAction, now, now, input.taskId);
    this.record(input.taskId, "progress", input.actor, { phase: input.phase }, now);
    return this.requireTask(input.taskId);
  }

  heartbeat(taskId: string, actor = "autonomy-watchdog"): AutonomyTask {
    assertLabel(taskId, "taskId");
    assertLabel(actor, "actor");
    const existing = this.requireTask(taskId);
    assertTaskMutable(existing);
    const now = utcNow(this.now());
    this.db.prepare(`UPDATE autonomy_tasks SET last_heartbeat_at = ?, updated_at = ? WHERE task_id = ? AND status = 'active'`).run(now, now, taskId);
    this.record(taskId, "heartbeat", actor, { phase: existing.phase }, now);
    return this.requireTask(taskId);
  }

  block(input: BlockAutonomyTaskInput): AutonomyTask {
    assertLabel(input.taskId, "taskId");
    assertLabel(input.actor, "actor");
    assertLabel(input.nextAction, "nextAction");
    assertBlockReason(input.reasonCode);
    const existing = this.requireTask(input.taskId);
    assertTaskMutable(existing);
    const now = utcNow(this.now());
    this.db.prepare(`UPDATE autonomy_tasks SET status = 'blocked', next_action = ?, updated_at = ? WHERE task_id = ? AND status = 'active'`).run(input.nextAction, now, input.taskId);
    this.record(input.taskId, "blocked", input.actor, { reason_code: input.reasonCode }, now);
    return this.requireTask(input.taskId);
  }

  /** Gate results are the only lifecycle operation that can write verified_done. */
  recordGateResult(input: GateResultInput): AutonomyTask {
    assertLabel(input.taskId, "taskId");
    assertLabel(input.actor, "actor");
    assertLabel(input.profile, "profile");
    assertLabel(input.artifactRef, "artifactRef");
    assertGateResult(input.result);
    const existing = this.requireTask(input.taskId);
    assertTaskMutable(existing);
    const now = utcNow(this.now());
    if (input.result === "fail") {
      this.db.prepare(`UPDATE autonomy_tasks SET status = 'failed', updated_at = ? WHERE task_id = ? AND status = 'active'`).run(now, input.taskId);
      this.record(input.taskId, "gate_fail", input.actor, { profile: input.profile, artifact_ref: input.artifactRef }, now);
      return this.requireTask(input.taskId);
    }
    this.db.prepare(`UPDATE autonomy_tasks SET status = 'verified_done', phase = 'verified_done', next_action = 'none', updated_at = ? WHERE task_id = ? AND status = 'active'`).run(now, input.taskId);
    this.record(input.taskId, "gate_pass", input.actor, { profile: input.profile, artifact_ref: input.artifactRef }, now);
    this.record(input.taskId, "verified_done", input.actor, { profile: input.profile, artifact_ref: input.artifactRef }, now);
    return this.requireTask(input.taskId);
  }

  get(taskId: string): AutonomyTask | null {
    assertLabel(taskId, "taskId");
    return this.db.prepare(`
      SELECT task_id, manifest_sha256, lane, owner, status, phase, last_progress_at,
             last_heartbeat_at, next_action, approval_ref, escalation_level, updated_at
        FROM autonomy_tasks WHERE task_id = ?
    `).get(taskId) as AutonomyTask | null;
  }

  async tickWatchdog(send: WatchdogSend): Promise<WatchdogRunResult> {
    const now = this.now();
    const active = this.db.prepare(`
      SELECT task_id, manifest_sha256, lane, owner, status, phase, last_progress_at,
             last_heartbeat_at, next_action, approval_ref, escalation_level, updated_at
        FROM autonomy_tasks WHERE status = 'active' ORDER BY task_id ASC
    `).all() as AutonomyTask[];
    const result: WatchdogRunResult = { heartbeats: 0, nudges: 0, escalations: 0 };
    for (const task of active) {
      const progressAge = now.getTime() - parseUtc(task.last_progress_at).getTime();
      if (progressAge >= this.escalateAfterMs) {
        if (task.escalation_level >= 2) continue;
        if (this.transitionEscalation(task, 2, "escalated", now)) {
          await this.sendAll(send, recipients(this.finjaRecipient, this.pmRecipient), this.escalationMessage(task));
          result.escalations++;
        }
        continue;
      }
      if (progressAge >= this.nudgeAfterMs) {
        if (task.escalation_level >= 1) continue;
        if (this.transitionEscalation(task, 1, "nudge", now)) {
          await this.sendAll(send, [task.owner], this.nudgeMessage(task));
          result.nudges++;
        }
        continue;
      }
      const heartbeatAge = task.last_heartbeat_at ? now.getTime() - parseUtc(task.last_heartbeat_at).getTime() : Number.POSITIVE_INFINITY;
      if (progressAge >= this.heartbeatAfterMs && heartbeatAge >= this.heartbeatAfterMs) {
        this.heartbeat(task.task_id);
        await this.sendAll(send, recipients(task.owner, this.pmRecipient), this.heartbeatMessage(task));
        result.heartbeats++;
      }
    }
    return result;
  }

  private transitionEscalation(task: AutonomyTask, level: 1 | 2, kind: "nudge" | "escalated", nowDate: Date): boolean {
    const now = utcNow(nowDate);
    const changed = this.db.prepare(`
      UPDATE autonomy_tasks SET escalation_level = ?, updated_at = ?
       WHERE task_id = ? AND status = 'active' AND escalation_level < ?
    `).run(level, now, task.task_id, level);
    if (changed.changes !== 1) return false;
    this.record(task.task_id, kind, "autonomy-watchdog", { level, phase: task.phase }, now);
    return true;
  }

  private async sendAll(send: WatchdogSend, targetRecipients: string[], content: string): Promise<void> {
    await Promise.all(targetRecipients.map(async (recipient) => {
      try {
        await send(recipient, content);
      } catch {
        this.log("autonomy_watchdog_delivery_failed", { recipient, error_category: "hub_rpc_failed" });
      }
    }));
  }

  private heartbeatMessage(task: AutonomyTask): string {
    return `[AUTONOMY HEARTBEAT task=${task.task_id} phase=${task.phase} next_action=${task.next_action}]`;
  }

  private nudgeMessage(task: AutonomyTask): string {
    return `[AUTONOMY NUDGE task=${task.task_id} phase=${task.phase} next_action=${task.next_action}]`;
  }

  private escalationMessage(task: AutonomyTask): string {
    return `[AUTONOMY ESCALATION task=${task.task_id} phase=${task.phase} next_action=${task.next_action}]`;
  }

  private requireTask(taskId: string): AutonomyTask {
    const task = this.get(taskId);
    if (!task) throw new Error("autonomy task not found");
    return task;
  }

  private record(taskId: string, kind: AutonomyEventKind, actor: string, evidence: Record<string, unknown>, now: string): void {
    this.db.prepare(`INSERT INTO autonomy_events (task_id, kind, actor, occurred_at, evidence_json) VALUES (?, ?, ?, ?, ?)`).run(taskId, kind, actor, now, JSON.stringify(evidence));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_tasks (
        task_id TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('A','B','C')),
        owner TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','blocked','failed','verified_done')),
        phase TEXT NOT NULL,
        last_progress_at TEXT NOT NULL,
        last_heartbeat_at TEXT,
        next_action TEXT NOT NULL,
        approval_ref TEXT,
        escalation_level INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES autonomy_tasks(task_id),
        kind TEXT NOT NULL CHECK (kind IN ('created','progress','heartbeat','nudge','escalated','blocked','gate_pass','gate_fail','verified_done')),
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_tasks_status_progress ON autonomy_tasks(status, last_progress_at);
      CREATE INDEX IF NOT EXISTS idx_autonomy_events_task_time ON autonomy_events(task_id, occurred_at DESC);
    `);
  }
}

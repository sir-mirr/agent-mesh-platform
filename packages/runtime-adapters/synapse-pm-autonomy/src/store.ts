import { Database } from "bun:sqlite";

export type Lane = "A" | "B" | "C";
export type TaskStatus = "active" | "blocked" | "failed" | "verified_done";
export type EventKind = "created" | "progress" | "heartbeat" | "nudge" | "escalated" | "gate_pass" | "gate_fail" | "completion_accepted";

export interface TaskRecord {
  task_id: string;
  manifest_sha256: string;
  manifest_ref: string;
  lane: Lane;
  owner: string;
  status: TaskStatus;
  phase: string;
  next_action: string;
  last_progress_at: string;
  last_heartbeat_at: string | null;
  escalation_level: number;
  gate_artifact_ref: string | null;
}

export interface CreateTaskInput {
  taskId: string;
  manifestSha256: string;
  manifestRef: string;
  lane: Lane;
  owner: string;
  phase: string;
  nextAction: string;
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_REF = /^\.synapse\/[A-Za-z0-9][A-Za-z0-9._/:-]{0,246}\.json$/;

function assertLabel(value: string, field: string): void {
  if (!LABEL.test(value)) throw new Error(`${field} must be a safe identifier`);
}

function iso(now: () => Date): string { return now().toISOString(); }

export class SynapsePmAutonomyStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {
    this.migrate();
  }

  create(input: CreateTaskInput): TaskRecord {
    assertLabel(input.taskId, "taskId");
    assertLabel(input.owner, "owner");
    assertLabel(input.phase, "phase");
    assertLabel(input.nextAction, "nextAction");
    if (!SHA256.test(input.manifestSha256)) throw new Error("manifestSha256 must be a lowercase SHA-256 digest");
    if (!MANIFEST_REF.test(input.manifestRef) || input.manifestRef.includes("..")) throw new Error("manifestRef must be an allowlisted relative JSON path");
    if (input.lane !== "A" && input.lane !== "B" && input.lane !== "C") throw new Error("lane must be A, B, or C");
    const at = iso(this.now);
    this.db.prepare(`INSERT INTO autonomy_tasks (
      task_id, manifest_sha256, manifest_ref, lane, owner, status, phase, next_action,
      last_progress_at, last_heartbeat_at, escalation_level, gate_artifact_ref, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, 0, NULL, ?)`)
      .run(input.taskId, input.manifestSha256, input.manifestRef, input.lane, input.owner, input.phase, input.nextAction, at, at);
    this.event(input.taskId, "created", "synapse-pm-dispatcher", { lane: input.lane, phase: input.phase }, at);
    return this.require(input.taskId);
  }

  progress(taskId: string, phase: string, nextAction: string): TaskRecord {
    assertLabel(taskId, "taskId"); assertLabel(phase, "phase"); assertLabel(nextAction, "nextAction");
    this.assertActive(taskId);
    const at = iso(this.now);
    this.db.prepare(`UPDATE autonomy_tasks SET phase=?, next_action=?, last_progress_at=?, escalation_level=0, updated_at=? WHERE task_id=? AND status='active'`)
      .run(phase, nextAction, at, at, taskId);
    this.event(taskId, "progress", "synapse-pm-dispatcher", { phase }, at);
    return this.require(taskId);
  }

  heartbeat(taskId: string): TaskRecord {
    this.assertActive(taskId);
    const at = iso(this.now);
    this.db.prepare(`UPDATE autonomy_tasks SET last_heartbeat_at=?, updated_at=? WHERE task_id=? AND status='active'`).run(at, at, taskId);
    this.event(taskId, "heartbeat", "synapse-pm-autonomy", {}, at);
    return this.require(taskId);
  }

  nudge(taskId: string): TaskRecord { return this.raise(taskId, 1, "nudge"); }
  escalate(taskId: string): TaskRecord { return this.raise(taskId, 2, "escalated"); }

  active(): TaskRecord[] {
    return this.db.prepare(`SELECT task_id, manifest_sha256, manifest_ref, lane, owner, status, phase, next_action, last_progress_at, last_heartbeat_at, escalation_level, gate_artifact_ref FROM autonomy_tasks WHERE status='active' ORDER BY task_id`).all() as TaskRecord[];
  }

  recordGatePass(taskId: string, artifactRef: string): TaskRecord {
    assertLabel(taskId, "taskId"); assertLabel(artifactRef, "artifactRef"); this.assertActive(taskId);
    const at = iso(this.now);
    this.db.prepare(`UPDATE autonomy_tasks SET status='verified_done', phase='verified_done', next_action='none', gate_artifact_ref=?, updated_at=? WHERE task_id=? AND status='active'`)
      .run(artifactRef, at, taskId);
    this.event(taskId, "gate_pass", "synapse-pm-autonomy", { artifact_ref: artifactRef }, at);
    return this.require(taskId);
  }

  recordGateFail(taskId: string, code: "gate_failed" | "artifact_invalid"): TaskRecord {
    assertLabel(taskId, "taskId"); this.assertActive(taskId);
    const at = iso(this.now);
    this.db.prepare(`UPDATE autonomy_tasks SET status='failed', updated_at=? WHERE task_id=? AND status='active'`).run(at, taskId);
    this.event(taskId, "gate_fail", "synapse-pm-autonomy", { code }, at);
    return this.require(taskId);
  }

  complete(taskId: string): TaskRecord {
    assertLabel(taskId, "taskId");
    const task = this.require(taskId);
    if (task.status !== "verified_done" || !task.gate_artifact_ref) throw new Error("COMPLETION_REJECTED");
    // Completion may be retried by the PM flow, but it must not manufacture
    // multiple completion facts for the same verified artifact.
    const recorded = this.db.prepare(`SELECT 1 FROM autonomy_events WHERE task_id=? AND kind='completion_accepted' LIMIT 1`).get(taskId);
    if (!recorded) this.event(taskId, "completion_accepted", "synapse-pm-dispatcher", { artifact_ref: task.gate_artifact_ref }, iso(this.now));
    return task;
  }

  get(taskId: string): TaskRecord | null {
    assertLabel(taskId, "taskId");
    return this.db.prepare(`SELECT task_id, manifest_sha256, manifest_ref, lane, owner, status, phase, next_action, last_progress_at, last_heartbeat_at, escalation_level, gate_artifact_ref FROM autonomy_tasks WHERE task_id=?`).get(taskId) as TaskRecord | null;
  }

  private assertActive(taskId: string): void {
    const task = this.require(taskId);
    if (task.status !== "active") throw new Error(`task is not active: ${task.status}`);
  }

  private require(taskId: string): TaskRecord {
    const task = this.get(taskId);
    if (!task) throw new Error("task not found");
    return task;
  }

  private raise(taskId: string, level: 1 | 2, kind: "nudge" | "escalated"): TaskRecord {
    const task = this.require(taskId);
    if (task.status !== "active") throw new Error(`task is not active: ${task.status}`);
    if (task.escalation_level >= level) return task;
    const at = iso(this.now);
    this.db.prepare(`UPDATE autonomy_tasks SET escalation_level=?, updated_at=? WHERE task_id=? AND status='active' AND escalation_level < ?`).run(level, at, taskId, level);
    this.event(taskId, kind, "synapse-pm-autonomy", { level: String(level) }, at);
    return this.require(taskId);
  }

  private event(taskId: string, kind: EventKind, actor: string, evidence: Record<string, string>, at: string): void {
    this.db.prepare(`INSERT INTO autonomy_events (task_id, kind, actor, occurred_at, evidence_json) VALUES (?, ?, ?, ?, ?)`)
      .run(taskId, kind, actor, at, JSON.stringify(evidence));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS autonomy_tasks (
        task_id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, manifest_ref TEXT NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('A','B','C')), owner TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','blocked','failed','verified_done')),
        phase TEXT NOT NULL, next_action TEXT NOT NULL, last_progress_at TEXT NOT NULL,
        last_heartbeat_at TEXT, escalation_level INTEGER NOT NULL DEFAULT 0,
        gate_artifact_ref TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES autonomy_tasks(task_id),
        kind TEXT NOT NULL CHECK(kind IN ('created','progress','heartbeat','nudge','escalated','gate_pass','gate_fail','completion_accepted')),
        actor TEXT NOT NULL, occurred_at TEXT NOT NULL, evidence_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_active_progress ON autonomy_tasks(status, last_progress_at);
      CREATE INDEX IF NOT EXISTS idx_autonomy_event_task_time ON autonomy_events(task_id, occurred_at DESC);
    `);
  }
}

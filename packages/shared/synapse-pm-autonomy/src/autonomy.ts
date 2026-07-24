import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { BoundaryError, assertAutonomyDatabasePath, assertSafeFileUnderRoot } from "./policy";

export const AUTONOMY_IDENTITY = "synapse-pm-autonomy";
export const PM_TARGET = "synapse-pm";
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type TaskStatus = "active" | "completed";
export interface TaskRecord {
  task_id: string;
  manifest_sha256: string;
  manifest_ref: string;
  status: TaskStatus;
  phase: string;
  next_action: string;
  last_progress_at: string;
  last_heartbeat_at: string | null;
  verified_artifact_sha256: string | null;
  updated_at: string;
}

export interface VerifiedArtifact {
  schema: "synapse-pm-autonomy/gate-artifact/v1";
  task_id: string;
  manifest_sha256: string;
  status: "verified";
  profile: "kms-gate";
}

export interface OutboundNotifier {
  send(message: { from: typeof AUTONOMY_IDENTITY; to: typeof PM_TARGET; content: string }): Promise<void>;
}

function nowIso(now: () => Date): string { return now().toISOString(); }
function assertSafeId(value: string, field: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new BoundaryError("CONTROL_REJECTED", `${field} is invalid`);
}
function assertSha(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) throw new BoundaryError("CONTROL_REJECTED", `${field} must be a lowercase SHA-256`);
}
function artifactHash(artifact: VerifiedArtifact): string {
  return createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}

export function parseVerifiedArtifact(raw: string): VerifiedArtifact {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new BoundaryError("ARTIFACT_REJECTED", "artifact is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundaryError("ARTIFACT_REJECTED", "artifact must be an object");
  const record = value as Record<string, unknown>;
  const allowed = ["schema", "task_id", "manifest_sha256", "status", "profile"];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || Object.keys(record).length !== allowed.length) {
    throw new BoundaryError("ARTIFACT_REJECTED", "artifact schema has unknown or missing keys");
  }
  if (record.schema !== "synapse-pm-autonomy/gate-artifact/v1" || record.status !== "verified" || record.profile !== "kms-gate") {
    throw new BoundaryError("ARTIFACT_REJECTED", "artifact is not a verified fixed-profile gate result");
  }
  assertSafeId(record.task_id as string, "artifact task_id");
  assertSha(record.manifest_sha256 as string, "artifact manifest_sha256");
  return record as unknown as VerifiedArtifact;
}

/** A closed task-flow store; it has no dependency on self-reminder or its database. */
export class AutonomyStore {
  constructor(private readonly db: Database, private readonly clock: () => Date = () => new Date()) { this.migrate(); }

  create(input: { taskId: string; manifestRef: string; manifestSha256: string; phase: string; nextAction: string }): TaskRecord {
    assertSafeId(input.taskId, "task_id"); assertSafeId(input.phase, "phase"); assertSafeId(input.nextAction, "next_action"); assertSha(input.manifestSha256, "manifest_sha256");
    const ts = nowIso(this.clock);
    this.db.prepare("INSERT INTO autonomy_tasks (task_id, manifest_sha256, manifest_ref, status, phase, next_action, last_progress_at, last_heartbeat_at, verified_artifact_sha256, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, NULL, ?)")
      .run(input.taskId, input.manifestSha256, input.manifestRef, input.phase, input.nextAction, ts, ts);
    this.event(input.taskId, "created", { manifest_ref: input.manifestRef });
    return this.require(input.taskId);
  }

  progress(input: { taskId: string; phase: string; nextAction: string }): TaskRecord {
    assertSafeId(input.taskId, "task_id"); assertSafeId(input.phase, "phase"); assertSafeId(input.nextAction, "next_action");
    this.requireActive(input.taskId);
    const ts = nowIso(this.clock);
    this.db.prepare("UPDATE autonomy_tasks SET phase = ?, next_action = ?, last_progress_at = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(input.phase, input.nextAction, ts, ts, input.taskId);
    this.event(input.taskId, "progress", { phase: input.phase });
    return this.require(input.taskId);
  }

  recordVerifiedGate(taskId: string, artifact: VerifiedArtifact): TaskRecord {
    const task = this.requireActive(taskId);
    if (artifact.task_id !== task.task_id || artifact.manifest_sha256 !== task.manifest_sha256) {
      throw new BoundaryError("ARTIFACT_REJECTED", "artifact is not bound to this task and manifest");
    }
    const ts = nowIso(this.clock);
    this.db.prepare("UPDATE autonomy_tasks SET verified_artifact_sha256 = ?, updated_at = ? WHERE task_id = ? AND status = 'active'").run(artifactHash(artifact), ts, taskId);
    this.event(taskId, "gate_verified", { artifact_sha256: artifactHash(artifact) });
    return this.require(taskId);
  }

  complete(taskId: string): "COMPLETION_REJECTED" | TaskRecord {
    const task = this.require(taskId);
    if (task.status !== "active" || !task.verified_artifact_sha256) return "COMPLETION_REJECTED";
    const ts = nowIso(this.clock);
    this.db.prepare("UPDATE autonomy_tasks SET status = 'completed', updated_at = ? WHERE task_id = ? AND status = 'active' AND verified_artifact_sha256 IS NOT NULL").run(ts, taskId);
    this.event(taskId, "completed", { verified_artifact_sha256: task.verified_artifact_sha256 });
    return this.require(taskId);
  }

  async watchdog(notifier: OutboundNotifier): Promise<{ heartbeat: number; nudge: number; escalate: number }> {
    const current = this.clock().getTime();
    const result = { heartbeat: 0, nudge: 0, escalate: 0 };
    for (const task of this.db.prepare("SELECT * FROM autonomy_tasks WHERE status = 'active' ORDER BY task_id").all() as TaskRecord[]) {
      const age = current - new Date(task.last_progress_at).getTime();
      const heartbeatAge = task.last_heartbeat_at ? current - new Date(task.last_heartbeat_at).getTime() : Number.POSITIVE_INFINITY;
      let kind: "heartbeat" | "nudge" | "escalate" | null = null;
      if (age >= 45 * 60_000) kind = "escalate";
      else if (age >= 30 * 60_000) kind = "nudge";
      else if (age >= 15 * 60_000 && heartbeatAge >= 15 * 60_000) kind = "heartbeat";
      if (!kind || this.hasEvent(task.task_id, kind)) continue;
      if (kind === "heartbeat") {
        const ts = nowIso(this.clock);
        this.db.prepare("UPDATE autonomy_tasks SET last_heartbeat_at = ?, updated_at = ? WHERE task_id = ?").run(ts, ts, task.task_id);
      }
      this.event(task.task_id, kind, { progress_age_ms: age });
      await notifier.send({ from: AUTONOMY_IDENTITY, to: PM_TARGET, content: `AUTONOMY ${kind.toUpperCase()} task=${task.task_id}` });
      result[kind]++;
    }
    return result;
  }

  get(taskId: string): TaskRecord | null { assertSafeId(taskId, "task_id"); return this.db.prepare("SELECT * FROM autonomy_tasks WHERE task_id = ?").get(taskId) as TaskRecord | null; }

  private require(taskId: string): TaskRecord { const task = this.get(taskId); if (!task) throw new BoundaryError("CONTROL_REJECTED", "task does not exist"); return task; }
  private requireActive(taskId: string): TaskRecord { const task = this.require(taskId); if (task.status !== "active") throw new BoundaryError("CONTROL_REJECTED", "task is not active"); return task; }
  private event(taskId: string, kind: string, detail: Record<string, string | number>): void { this.db.prepare("INSERT INTO autonomy_events (task_id, kind, occurred_at, detail_json) VALUES (?, ?, ?, ?)").run(taskId, kind, nowIso(this.clock), JSON.stringify(detail)); }
  private hasEvent(taskId: string, kind: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM autonomy_events WHERE task_id = ? AND kind = ? LIMIT 1").get(taskId, kind)); }
  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS autonomy_tasks (task_id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, manifest_ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','completed')), phase TEXT NOT NULL, next_action TEXT NOT NULL, last_progress_at TEXT NOT NULL, last_heartbeat_at TEXT, verified_artifact_sha256 TEXT, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS autonomy_events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, detail_json TEXT NOT NULL);");
  }
}

/** Open only the dedicated PM state database; self-reminder paths cannot reach this factory. */
export function openAutonomyStore(stateRoot: string, clock: () => Date = () => new Date()): AutonomyStore {
  const root = path.basename(path.resolve(stateRoot)) === "synapse-pm-autonomy" ? path.resolve(stateRoot) : path.join(path.resolve(stateRoot), "synapse-pm-autonomy");
  const dbPath = assertAutonomyDatabasePath(stateRoot, path.join(root, "autonomy.db"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return new AutonomyStore(new Database(dbPath, { create: true }), clock);
}

/** Fixed argv gate runner. Control requests cannot supply a profile, shell, artifact, or executable. */
export class FixedArgvGateRunner {
  constructor(private readonly manifestsRoot: string, private readonly artifactsRoot: string, private readonly fixedArgv: readonly string[], private readonly execute: (argv: readonly string[]) => Promise<void>) {
    if (!fixedArgv.length || fixedArgv.some((arg) => !arg || arg.includes("\0"))) throw new BoundaryError("GATE_REJECTED", "gate argv must be fixed non-empty arguments");
  }
  async run(task: TaskRecord): Promise<VerifiedArtifact> {
    const manifest = assertSafeFileUnderRoot(this.manifestsRoot, task.manifest_ref);
    await this.execute([...this.fixedArgv, "--manifest", manifest]);
    const artifact = assertSafeFileUnderRoot(this.artifactsRoot, `${task.task_id}.json`);
    const parsed = parseVerifiedArtifact(readFileSync(artifact, "utf8"));
    if (parsed.task_id !== task.task_id || parsed.manifest_sha256 !== task.manifest_sha256) {
      throw new BoundaryError("ARTIFACT_REJECTED", "gate artifact binding does not match the task");
    }
    return parsed;
  }
}

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AUTONOMY_IDENTITY, AutonomyStore, FixedArgvGateRunner, PM_TARGET, parseVerifiedArtifact } from "./autonomy";
import { ControlLineDecoder, MAX_CONTROL_BYTES, parseControlRequest } from "./daemon";
import { BoundaryError, SOCKET_PARENT, assertAutonomyDatabasePath, assertPeerUid, assertSafeFileUnderRoot, assertSocketPath } from "./policy";

const cleanup: string[] = [];
afterEach(() => { for (const entry of cleanup.splice(0)) rmSync(entry, { recursive: true, force: true }); });

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pm-autonomy-")); cleanup.push(root); return root;
}
function store(now = () => new Date("2026-07-24T00:00:00.000Z")): AutonomyStore { return new AutonomyStore(new Database(":memory:"), now); }
function create(storeInstance: AutonomyStore, taskId = "task-one", manifest = "a".repeat(64)): void {
  storeInstance.create({ taskId, manifestRef: "manifests/task.json", manifestSha256: manifest, phase: "build", nextAction: "test" });
}
function expectBoundary(run: () => unknown, code: string): void {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(BoundaryError);
    expect((error as BoundaryError).code).toBe(code);
    return;
  }
  throw new Error(`expected boundary rejection: ${code}`);
}
async function expectAsyncBoundary(run: () => Promise<unknown>, code: string): Promise<void> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(BoundaryError);
    expect((error as BoundaryError).code).toBe(code);
    return;
  }
  throw new Error(`expected async boundary rejection: ${code}`);
}

describe("PM autonomy fail-closed boundaries", () => {
  test("socket path accepts only the flat exact runtime parent", () => {
    expect(assertSocketPath(`${SOCKET_PARENT}/control.sock`)).toBe(`${SOCKET_PARENT}/control.sock`);
    for (const bad of [`${SOCKET_PARENT}/../other.sock`, "/run/synapse-pm-autonomy-evil/control.sock", `${SOCKET_PARENT}/nested/control.sock`]) {
      expectBoundary(() => assertSocketPath(bad), "SOCKET_PATH_REJECTED");
    }
  });

  test("different uid peer cannot control the daemon", () => {
    expectBoundary(() => assertPeerUid(1001, 1000), "PEER_REJECTED");
    expectBoundary(() => assertPeerUid(null, 1000), "PEER_REJECTED");
  });

  test("control schema rejects unknown and nested bypass fields", () => {
    const good = JSON.stringify({ op: "create", input: { task_id: "task-one", manifest_ref: "manifests/task.json", phase: "build", next_action: "test" } });
    expect(parseControlRequest(good).op).toBe("create");
    for (const key of ["pass", "force", "profile", "shell"]) {
      const value = JSON.stringify({ op: "create", input: { task_id: "task-one", manifest_ref: "manifests/task.json", phase: "build", next_action: "test", [key]: { [key]: true } } });
      expectBoundary(() => parseControlRequest(value), "CONTROL_REJECTED");
    }
  });

  test("oversize newline-free control input is rejected before buffering grows", () => {
    const decoder = new ControlLineDecoder();
    expectBoundary(() => decoder.push("x".repeat(MAX_CONTROL_BYTES + 1)), "CONTROL_INPUT_TOO_LARGE");
  });

  test("manifest and artifact symlink escapes are rejected before read", async () => {
    const root = fixtureRoot(); const manifests = path.join(root, "manifests"); const artifacts = path.join(root, "artifacts"); const outside = path.join(root, "outside");
    mkdirSync(manifests); mkdirSync(artifacts); mkdirSync(outside);
    writeFileSync(path.join(outside, "payload"), "outside");
    symlinkSync(path.join(outside, "payload"), path.join(manifests, "task.json"));
    symlinkSync(path.join(outside, "payload"), path.join(artifacts, "task-one.json"));
    expectBoundary(() => assertSafeFileUnderRoot(root, "manifests/task.json"), "SYMLINK_REJECTED");
    const taskStore = store(); create(taskStore);
    const runner = new FixedArgvGateRunner(root, artifacts, ["/usr/bin/kms-gate"], async () => { throw new Error("must not execute"); });
    await expectAsyncBoundary(() => runner.run(taskStore.get("task-one")!), "SYMLINK_REJECTED");
  });

  test("database path is dedicated and rejects self-reminder shape or symlinks without tables", () => {
    const root = fixtureRoot(); const stateRoot = path.join(root, "state"); const dedicated = path.join(stateRoot, "synapse-pm-autonomy"); mkdirSync(dedicated, { recursive: true });
    expect(assertAutonomyDatabasePath(stateRoot, path.join(dedicated, "autonomy.db"))).toBe(path.join(dedicated, "autonomy.db"));
    const reminder = path.join(stateRoot, "self-reminder.db");
    expectBoundary(() => assertAutonomyDatabasePath(stateRoot, reminder), "DATABASE_PATH_REJECTED");
    expect(existsSync(reminder)).toBeFalse();
    const real = path.join(root, "real"); const symlinkState = path.join(root, "linked-state"); mkdirSync(path.join(real, "synapse-pm-autonomy"), { recursive: true }); symlinkSync(real, symlinkState, "dir");
    expectBoundary(() => assertAutonomyDatabasePath(symlinkState, path.join(symlinkState, "synapse-pm-autonomy", "autonomy.db")), "SYMLINK_REJECTED");
  });

  test("completion is rejected without a task-bound verified artifact and leaves task active", () => {
    const taskStore = store(); create(taskStore);
    expect(taskStore.complete("task-one")).toBe("COMPLETION_REJECTED");
    expect(taskStore.get("task-one")?.status).toBe("active");
    const valid = parseVerifiedArtifact(JSON.stringify({ schema: "synapse-pm-autonomy/gate-artifact/v1", task_id: "other-task", manifest_sha256: "a".repeat(64), status: "verified", profile: "kms-gate" }));
    expectBoundary(() => taskStore.recordVerifiedGate("task-one", valid), "ARTIFACT_REJECTED");
    const wrongManifest = parseVerifiedArtifact(JSON.stringify({ schema: "synapse-pm-autonomy/gate-artifact/v1", task_id: "task-one", manifest_sha256: "b".repeat(64), status: "verified", profile: "kms-gate" }));
    expectBoundary(() => taskStore.recordVerifiedGate("task-one", wrongManifest), "ARTIFACT_REJECTED");
  });

  test("valid verified artifact enables completion and watchdog keeps progress time immutable", async () => {
    let current = new Date("2026-07-24T00:00:00.000Z"); const taskStore = store(() => current); create(taskStore);
    const initialProgress = taskStore.get("task-one")!.last_progress_at;
    current = new Date("2026-07-24T00:15:01.000Z");
    const messages: Array<{ from: string; to: string; content: string }> = [];
    await taskStore.watchdog({ send: async (message) => { messages.push(message); } });
    expect(taskStore.get("task-one")!.last_progress_at).toBe(initialProgress);
    expect(messages[0]).toMatchObject({ from: AUTONOMY_IDENTITY, to: PM_TARGET });
    current = new Date("2026-07-24T00:30:01.000Z");
    await taskStore.watchdog({ send: async (message) => { messages.push(message); } });
    await taskStore.watchdog({ send: async (message) => { messages.push(message); } });
    current = new Date("2026-07-24T00:45:01.000Z");
    await taskStore.watchdog({ send: async (message) => { messages.push(message); } });
    expect(messages.map((message) => message.content.split(" ")[1])).toEqual(["HEARTBEAT", "NUDGE", "ESCALATE"]);
    expect(messages.every((message) => message.from === AUTONOMY_IDENTITY && message.to === PM_TARGET)).toBeTrue();
    const artifact = parseVerifiedArtifact(JSON.stringify({ schema: "synapse-pm-autonomy/gate-artifact/v1", task_id: "task-one", manifest_sha256: "a".repeat(64), status: "verified", profile: "kms-gate" }));
    taskStore.recordVerifiedGate("task-one", artifact);
    expect(taskStore.complete("task-one")).toMatchObject({ status: "completed" });
  });
});

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { AUTONOMY_IDENTITY, AutonomyStore, FixedArgvGateRunner, PM_TARGET, parseVerifiedArtifact } from "./autonomy";
import { ControlLineDecoder, MAX_CONTROL_BYTES, parseControlRequest } from "./daemon";
import { composeAutonomyDaemon } from "./main";
import { BoundaryError, SOCKET_PARENT, assertAutonomyDatabasePath, assertPeerUid, assertSafeFileUnderRoot, assertSocketPath } from "./policy";
import { produceSourceVerifiedDoneForFixture } from "./source-gate";

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
function git(repository: string, args: string[]): void {
  const result = spawnSync("/usr/bin/git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
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

  test("raw byte transport accepts 16,384 bytes and rejects 16,385 before UTF-8 parsing", () => {
    const decoder = new ControlLineDecoder();
    const prefix = JSON.stringify({ op: "create", input: { task_id: "task-one", manifest_ref: "manifests/task.json", phase: "build", next_action: "" } });
    const padded = prefix.slice(0, -3) + "x".repeat(MAX_CONTROL_BYTES - Buffer.byteLength(prefix) - 1) + "\"}}\n";
    expect(Buffer.byteLength(padded)).toBe(MAX_CONTROL_BYTES);
    const lines = decoder.push(Buffer.from(padded));
    expect(parseControlRequest(lines[0]!)).toMatchObject({ op: "create" });
    expectBoundary(() => decoder.push(Buffer.alloc(MAX_CONTROL_BYTES + 1, 0x61)), "CONTROL_INPUT_TOO_LARGE");
    const unicode = new ControlLineDecoder();
    expectBoundary(() => unicode.push(Buffer.from("🙂".repeat(Math.ceil((MAX_CONTROL_BYTES + 1) / 4)))), "CONTROL_INPUT_TOO_LARGE");
  });

  test("manifest and artifact symlink escapes are rejected before read", async () => {
    const root = fixtureRoot(); const manifests = path.join(root, "manifests"); const artifacts = path.join(root, "artifacts"); const outside = path.join(root, "outside");
    mkdirSync(manifests); mkdirSync(artifacts); mkdirSync(outside);
    writeFileSync(path.join(outside, "payload"), "outside");
    symlinkSync(path.join(outside, "payload"), path.join(manifests, "task.json"));
    symlinkSync(path.join(outside, "payload"), path.join(artifacts, "task-one.json"));
    expectBoundary(() => assertSafeFileUnderRoot(root, "manifests/task.json"), "SYMLINK_REJECTED");
    const taskStore = store(); create(taskStore);
    const runner = new FixedArgvGateRunner(root, artifacts);
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
    const sentinel = path.join(root, "self-reminder-shaped-target"); writeFileSync(sentinel, "leave-this-unchanged");
    symlinkSync(sentinel, path.join(dedicated, "autonomy.db"));
    expectBoundary(() => assertAutonomyDatabasePath(stateRoot, path.join(dedicated, "autonomy.db")), "SYMLINK_REJECTED");
    expect(readFileSync(sentinel, "utf8")).toBe("leave-this-unchanged");
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

  test("daemon composition creates only dedicated local components from injected temporary paths", () => {
    const root = fixtureRoot(); const manifests = path.join(root, "manifests"); const artifacts = path.join(root, "artifacts"); mkdirSync(manifests); mkdirSync(artifacts);
    const daemon = composeAutonomyDaemon({ stateRoot: path.join(root, "state"), manifestsRoot: manifests, artifactsRoot: artifacts, socketPath: `${SOCKET_PARENT}/fixture.sock`, daemonUid: process.getuid?.() ?? 0 });
    expect(daemon.store.get("missing")).toBeNull();
    expect(daemon.gateRunner).toBeInstanceOf(FixedArgvGateRunner);
    expect(daemon.notifier.constructor.name).toBe("FixedPmNotifier");
    expect(typeof daemon.start).toBe("function");
  });

  test("closed source gate ignores a fake git injected through PATH and emits a mode-0600 artifact", () => {
    const root = fixtureRoot(); const repository = path.join(root, "repo"); mkdirSync(repository);
    const source = path.join(repository, "source.txt"); const manifest = path.join(repository, "source-manifest.json"); const artifacts = path.join(root, "state", "source-artifacts"); const fakeBin = path.join(root, "fake-bin");
    writeFileSync(source, "trusted source\n");
    writeFileSync(manifest, JSON.stringify({ schema: "synapse-pm-autonomy/source-manifest/v1", source_files: ["source.txt"] }) + "\n");
    git(repository, ["init"]); git(repository, ["config", "user.email", "fixture@example.invalid"]); git(repository, ["config", "user.name", "fixture"]); git(repository, ["add", "source.txt", "source-manifest.json"]); git(repository, ["commit", "-m", "fixture"]);
    const revision = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).stdout.trim();
    mkdirSync(fakeBin); writeFileSync(path.join(fakeBin, "git"), "#!/bin/sh\necho deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"); chmodSync(path.join(fakeBin, "git"), 0o755);
    const previousPath = process.env.PATH; process.env.PATH = fakeBin;
    try {
      const result = produceSourceVerifiedDoneForFixture({ repositoryRoot: repository, sourceManifestPath: manifest, artifactRoot: artifacts });
      expect(result.artifact.source_revision).toBe(revision);
      expect(existsSync(result.artifactPath)).toBeTrue();
      expect(statSync(result.artifactPath).mode & 0o777).toBe(0o600);
    } finally { process.env.PATH = previousPath; }
  });
});

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SynapsePmTaskController, type GateRunner } from "./controller";
import { LocalControlPlane } from "./control";
import { SynapsePmAutonomyStore } from "./store";

const SHA = "c".repeat(64);
const runner: GateRunner = { run: async () => ({
  artifact: { task_id: "control-task-001", manifest_sha256: `sha256:${SHA}`, schema: "synapse/verified-done/v1", status: "verified_done", profiles: [{ profile: "unit", status: "PASS" }] },
  rawArtifact: new Uint8Array([1]),
}) };

describe("LocalControlPlane", () => {
  test("never exposes a caller-supplied pass operation and rejects completion before gate", async () => {
    const control = new LocalControlPlane(new SynapsePmTaskController(new SynapsePmAutonomyStore(new Database(":memory:")), runner));
    const created = await control.handle({ id: "request-001", op: "create", input: {
      taskId: "control-task-001", manifestSha256: SHA, manifestRef: ".synapse/autonomy/control-task-001.json",
      lane: "A", owner: "synapse-pm", phase: "implementation", nextAction: "run_tests",
    } });
    expect(created.ok).toBe(true);
    expect((await control.handle({ id: "request-002", op: "complete", task_id: "control-task-001" })).error).toEqual({ code: "COMPLETION_REJECTED" });
    expect((await control.handle({ id: "request-003", op: "recordGatePass", task_id: "control-task-001" })).error).toEqual({ code: "CONTROL_REJECTED" });
    expect((await control.handle({ id: "request-004", op: "gate", task_id: "control-task-001" })).ok).toBe(true);
    expect((await control.handle({ id: "request-005", op: "complete", task_id: "control-task-001" })).ok).toBe(true);
  });
});

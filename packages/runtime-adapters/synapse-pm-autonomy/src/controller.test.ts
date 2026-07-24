import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SynapsePmTaskController, type GateArtifact, type GateRunner } from "./controller";
import { SynapsePmAutonomyStore } from "./store";

const SHA = "b".repeat(64);

function controller(runner: GateRunner) {
  return new SynapsePmTaskController(new SynapsePmAutonomyStore(new Database(":memory:")), runner);
}

function task(controller: SynapsePmTaskController) {
  return controller.create({
    taskId: "pm-autonomy-gate-001", manifestSha256: SHA,
    manifestRef: ".synapse/autonomy/pm-autonomy-gate-001.json", lane: "A",
    owner: "synapse-pm", phase: "verification", nextAction: "run_gate",
  });
}

function artifact(overrides: Partial<GateArtifact> = {}): GateArtifact {
  return {
    task_id: "pm-autonomy-gate-001",
    manifest_sha256: `sha256:${SHA}`,
    schema: "synapse/verified-done/v1",
    status: "verified_done",
    profiles: [{ profile: "unit", status: "PASS" }],
    ...overrides,
  };
}

describe("SynapsePmTaskController", () => {
  test("only a daemon-run verified artifact permits completion", async () => {
    const runner: GateRunner = { run: async () => ({ artifact: artifact(), rawArtifact: new TextEncoder().encode("verified") }) };
    const value = controller(runner);
    task(value);
    expect(() => value.complete("pm-autonomy-gate-001")).toThrow("COMPLETION_REJECTED");
    expect((await value.gate("pm-autonomy-gate-001")).status).toBe("verified_done");
    expect(value.complete("pm-autonomy-gate-001").status).toBe("verified_done");
  });

  test("forged or mismatched artifacts fail the task and never permit completion", async () => {
    const runner: GateRunner = { run: async () => ({ artifact: artifact({ task_id: "other-task" }), rawArtifact: new Uint8Array() }) };
    const value = controller(runner);
    task(value);
    expect((await value.gate("pm-autonomy-gate-001")).status).toBe("failed");
    expect(() => value.complete("pm-autonomy-gate-001")).toThrow("COMPLETION_REJECTED");
  });
});

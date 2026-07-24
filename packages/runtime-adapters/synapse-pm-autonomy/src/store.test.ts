import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SynapsePmAutonomyStore } from "./store";

const SHA = "a".repeat(64);

function store() {
  let now = new Date("2026-07-24T05:45:00.000Z");
  return {
    setNow(value: string) { now = new Date(value); },
    value: new SynapsePmAutonomyStore(new Database(":memory:"), () => now),
  };
}

function create(value: SynapsePmAutonomyStore, id = "pm-autonomy-fixture-001") {
  return value.create({
    taskId: id,
    manifestSha256: SHA,
    manifestRef: ".synapse/autonomy/pm-autonomy-fixture-001.json",
    lane: "A",
    owner: "synapse-pm",
    phase: "implementation",
    nextAction: "run_tests",
  });
}

describe("SynapsePmAutonomyStore", () => {
  test("owns a separate schema and accepts only bounded task registration", () => {
    const fixture = store();
    const task = create(fixture.value);
    expect(task.status).toBe("active");
    expect(() => fixture.value.create({
      taskId: "bad-task", manifestSha256: SHA, manifestRef: "../outside.json", lane: "A",
      owner: "synapse-pm", phase: "implementation", nextAction: "run_tests",
    })).toThrow("manifestRef");
  });

  test("progress resets the stall baseline without granting completion", () => {
    const fixture = store();
    create(fixture.value);
    fixture.setNow("2026-07-24T05:50:00.000Z");
    const progressed = fixture.value.progress("pm-autonomy-fixture-001", "verification", "run_gate");
    expect(progressed.last_progress_at).toBe("2026-07-24T05:50:00.000Z");
    expect(() => fixture.value.complete("pm-autonomy-fixture-001")).toThrow("COMPLETION_REJECTED");
  });

  test("rejects completion without an artifact and accepts only a verified gate result", () => {
    const fixture = store();
    create(fixture.value);
    expect(() => fixture.value.complete("pm-autonomy-fixture-001")).toThrow("COMPLETION_REJECTED");
    const done = fixture.value.recordGatePass("pm-autonomy-fixture-001", "verified-done-fixture-001");
    expect(done.status).toBe("verified_done");
    expect(fixture.value.complete("pm-autonomy-fixture-001").gate_artifact_ref).toBe("verified-done-fixture-001");
  });

  test("a failed gate is terminal and cannot be completed or converted to verified_done", () => {
    const fixture = store();
    create(fixture.value);
    fixture.value.recordGateFail("pm-autonomy-fixture-001", "artifact_invalid");
    expect(() => fixture.value.recordGatePass("pm-autonomy-fixture-001", "forged-artifact")).toThrow("not active");
    expect(() => fixture.value.complete("pm-autonomy-fixture-001")).toThrow("COMPLETION_REJECTED");
  });
});

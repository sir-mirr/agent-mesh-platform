import { describe, expect, test } from "bun:test";

import { PmAutonomousTaskFlow, type LocalAutonomyClient } from "./pm-task-flow";
import type { TaskRecord } from "./store";

const task = { task_id: "flow-task-001", manifest_sha256: "a".repeat(64), manifest_ref: ".synapse/autonomy/flow-task-001.json", lane: "A", owner: "synapse-pm", status: "active", phase: "implementation", next_action: "run_tests", last_progress_at: "2026-07-24T00:00:00.000Z", last_heartbeat_at: null, escalation_level: 0, gate_artifact_ref: null } satisfies TaskRecord;

describe("PmAutonomousTaskFlow", () => {
  test("uses the daemon's closed completion path and surfaces COMPLETION_REJECTED", async () => {
    const calls: string[] = [];
    const client: LocalAutonomyClient = {
      request: async (op) => {
        calls.push(op);
        if (op === "complete") throw new Error("COMPLETION_REJECTED");
        return task;
      },
    };
    const flow = new PmAutonomousTaskFlow(client);
    await expect(flow.complete("flow-task-001")).rejects.toThrow("COMPLETION_REJECTED");
    expect(calls).toEqual(["complete"]);
  });
});

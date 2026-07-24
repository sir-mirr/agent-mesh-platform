import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SynapsePmAutonomyStore } from "./store";
import { SynapsePmAutonomyWatchdog } from "./watchdog";

const SHA = "d".repeat(64);

describe("SynapsePmAutonomyWatchdog", () => {
  test("uses outbound-only PM notifications and does not treat heartbeat as progress", async () => {
    let now = new Date("2026-07-24T06:00:00.000Z");
    const store = new SynapsePmAutonomyStore(new Database(":memory:"), () => now);
    store.create({ taskId: "watchdog-task-001", manifestSha256: SHA, manifestRef: ".synapse/autonomy/watchdog-task-001.json", lane: "A", owner: "synapse-pm", phase: "implementation", nextAction: "run_tests" });
    const sent: string[] = [];
    const watchdog = new SynapsePmAutonomyWatchdog(store, { send: async (to, content) => { expect(to).toBe("synapse-pm"); sent.push(content); } }, { now: () => now, heartbeatAfterMs: 15, nudgeAfterMs: 30, escalateAfterMs: 45 });

    now = new Date("2026-07-24T06:00:00.016Z");
    await watchdog.tick();
    expect(sent[0]).toContain("HEARTBEAT");
    expect(store.get("watchdog-task-001")?.last_progress_at).toBe("2026-07-24T06:00:00.000Z");
    now = new Date("2026-07-24T06:00:00.031Z");
    await watchdog.tick(); await watchdog.tick();
    expect(sent.filter((item) => item.includes("NUDGE"))).toHaveLength(1);
    now = new Date("2026-07-24T06:00:00.046Z");
    await watchdog.tick(); await watchdog.tick();
    expect(sent.filter((item) => item.includes("ESCALATION"))).toHaveLength(1);
  });
});

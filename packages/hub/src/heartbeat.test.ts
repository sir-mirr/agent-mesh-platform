import { describe, expect, test } from "bun:test";

import { Heartbeat, type HeartbeatSocket } from "./heartbeat";

interface FakeSocket extends HeartbeatSocket {
  pings: number;
  closed: Array<{ code: number | undefined; reason: string | undefined }>;
}

function socket(overrides: Partial<FakeSocket> = {}): FakeSocket {
  const s: FakeSocket = {
    pings: 0,
    closed: [],
    ping() {
      s.pings++;
      // Bun's return value, which is the same for a live and a dead socket.
      return 0;
    },
    close(code, reason) {
      s.closed.push({ code, reason });
    },
    ...overrides,
  };
  return s;
}

function harness() {
  const online = new Map<string, FakeSocket>();
  const touched: string[] = [];
  const dropped: Array<{ identity: string; socket: FakeSocket }> = [];
  const heartbeat = new Heartbeat<FakeSocket>({
    online,
    touchLastSeen: (identity) => touched.push(identity),
    drop: (s, identity) => {
      dropped.push({ identity, socket: s });
      if (online.get(identity) === s) online.delete(identity);
    },
    log: () => {},
  });
  return { online, touched, dropped, heartbeat };
}

describe("Heartbeat", () => {
  test("a socket gets a full interval of grace before it can be judged", () => {
    const { online, heartbeat, dropped } = harness();
    const a = socket();
    online.set("agent-a", a);

    // First sweep may only ping. Dropping here would kill every connection
    // that arrived between two sweeps, which is most of them on a busy hub.
    expect(heartbeat.sweep()).toEqual({ pinged: ["agent-a"], dropped: [] });
    expect(a.pings).toBe(1);
    expect(dropped).toEqual([]);
  });

  test("a socket that answers is pinged again, never dropped", () => {
    const { online, heartbeat } = harness();
    const a = socket();
    online.set("agent-a", a);

    for (let i = 0; i < 5; i++) {
      heartbeat.sweep();
      heartbeat.alive(a);
    }
    expect(a.pings).toBe(5);
    expect(a.closed).toEqual([]);
    expect(online.get("agent-a")).toBe(a);
  });

  test("a socket that stays silent through a ping is dropped and closed", () => {
    const { online, heartbeat, touched, dropped } = harness();
    const a = socket();
    online.set("agent-a", a);

    heartbeat.sweep();
    const second = heartbeat.sweep();

    expect(second).toEqual({ pinged: [], dropped: ["agent-a"] });
    expect(dropped).toEqual([{ identity: "agent-a", socket: a }]);
    expect(online.has("agent-a")).toBe(false);
    // Actually closed, not merely forgotten. A socket left open still holds a
    // file descriptor and can still be written to by anything holding it.
    expect(a.closed).toEqual([{ code: 1001, reason: "heartbeat timeout" }]);
  });

  test("last_seen is touched before the socket is dropped (SPEC 3.1)", () => {
    const order: string[] = [];
    const online = new Map<string, FakeSocket>();
    const heartbeat = new Heartbeat<FakeSocket>({
      online,
      touchLastSeen: () => order.push("touch"),
      drop: (_s, identity) => {
        order.push("drop");
        online.delete(identity);
      },
      log: () => {},
    });
    online.set("agent-a", socket());

    heartbeat.sweep();
    heartbeat.sweep();

    expect(order).toEqual(["touch", "drop"]);
  });

  test("any inbound frame counts as proof of life, not only a pong", () => {
    const { online, heartbeat } = harness();
    const a = socket();
    online.set("agent-a", a);

    heartbeat.sweep();
    // Stands in for `message` — a busy socket whose pong is queued behind a
    // large request is alive, and dropping it would be the worse failure.
    heartbeat.alive(a);
    expect(heartbeat.sweep().dropped).toEqual([]);
  });

  test("eviction goes through drop, so proxies are withdrawn too", () => {
    // The bug this replaces deleted from `onlineAgents` by hand and left the
    // proxy routes wired, so a dead socket kept receiving other identities'
    // mail. Asserting the injected `drop` is called is what pins that shut.
    const { online, heartbeat, dropped } = harness();
    const a = socket();
    online.set("agent-a", a);
    heartbeat.sweep();
    heartbeat.sweep();
    expect(dropped[0]?.socket).toBe(a);
  });

  test("one silent socket does not stop the sweep reaching the rest", () => {
    const { online, heartbeat } = harness();
    const dead = socket({
      close() {
        throw new Error("socket already gone");
      },
    });
    const live = socket();
    online.set("dead", dead);
    online.set("live", live);

    heartbeat.sweep();
    heartbeat.alive(live);
    const second = heartbeat.sweep();

    expect(second.dropped).toEqual(["dead"]);
    expect(second.pinged).toEqual(["live"]);
    expect(online.has("live")).toBe(true);
  });

  test("a ping that throws leaves the socket to be removed by the next sweep", () => {
    const { online, heartbeat, dropped } = harness();
    const a = socket({
      ping() {
        throw new Error("send failed");
      },
    });
    online.set("agent-a", a);

    // Not removed inline: eviction has one path, and it is the one that also
    // touches last_seen and withdraws proxies.
    expect(heartbeat.sweep().dropped).toEqual([]);
    expect(dropped).toEqual([]);
    expect(heartbeat.sweep().dropped).toEqual(["agent-a"]);
  });

  test("forget clears the flag so a reconnect starts with full grace", () => {
    const { online, heartbeat } = harness();
    const a = socket();
    online.set("agent-a", a);

    heartbeat.sweep();
    heartbeat.forget(a);
    expect(heartbeat.sweep().dropped).toEqual([]);
  });

  test("the sweep reads `online` live rather than a stale snapshot", () => {
    const { online, heartbeat } = harness();
    heartbeat.sweep();
    const late = socket();
    online.set("late", late);
    expect(heartbeat.sweep().pinged).toEqual(["late"]);
  });
});

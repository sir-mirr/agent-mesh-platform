import { describe, expect, test } from "bun:test";

import { HubLifecycle, type HubLifecycleOptions, type SocketLike } from "./lifecycle";

class FakeSocket implements SocketLike {
  readyState = 0;
  closed = false;
  readonly sent: any[] = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: "open" | "message" | "close" | "error", listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; this.readyState = 3; this.emit("close"); }
  emit(event: "open" | "message" | "close" | "error", ...args: any[]): void {
    if (event === "open") this.readyState = 1;
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  respondLast(result: unknown = { ok: true }): void {
    const request = this.sent.at(-1);
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
  rejectLast(category = "DUPLICATE_IDENTITY"): void {
    const request = this.sent.at(-1);
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "duplicate", data: { code: category } } }));
  }
}

describe("HubLifecycle", () => {
  test("recovers from a rejected same-identity registration without an open unready socket", async () => {
    const sockets: FakeSocket[] = [];
    let timers: Array<() => void> = [];
    const states: string[] = [];
    const lifecycle = new HubLifecycle({
      identity: "self-reminder",
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimer: (fn) => { timers.push(fn); return fn as any; },
      clearTimer: (timer) => { timers = timers.filter((candidate) => candidate !== (timer as unknown as () => void)); },
      onConnectivityState: (state) => states.push(state),
    });

    lifecycle.start();
    sockets[0]!.emit("open");
    sockets[0]!.rejectLast();
    await Promise.resolve();
    expect(sockets[0]!.closed).toBe(true);
    expect(lifecycle.isReady()).toBe(false);
    expect(states).toContain("unavailable");
    expect(timers).toHaveLength(1);

    timers.shift()!();
    sockets[1]!.emit("open");
    sockets[1]!.respondLast();
    await Promise.resolve();
    expect(lifecycle.isReady()).toBe(true);
  });

  test("stale close callbacks cannot disrupt a newer registered owner", async () => {
    const sockets: FakeSocket[] = [];
    let timers: Array<() => void> = [];
    const lifecycle = new HubLifecycle({
      identity: "self-reminder",
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      setTimer: (fn) => { timers.push(fn); return fn as any; },
      clearTimer: (timer) => { timers = timers.filter((candidate) => candidate !== (timer as unknown as () => void)); },
    });
    lifecycle.start();
    sockets[0]!.emit("open");
    sockets[0]!.rejectLast();
    await Promise.resolve();
    timers.shift()!();
    sockets[1]!.emit("open");
    sockets[1]!.respondLast();
    await Promise.resolve();

    sockets[0]!.emit("close");
    expect(lifecycle.isReady()).toBe(true);
    expect(timers).toHaveLength(0);
  });
});

class ClosePanicSocket extends FakeSocket {
  override close(): void { throw new Error("close after the peer vanished"); }
}

interface Harness {
  lifecycle: HubLifecycle;
  sockets: FakeSocket[];
  logs: Array<{ event: string; fields: Record<string, unknown> | undefined }>;
  timers: () => Array<{ fn: () => void; ms: number }>;
}

function harness(options: Partial<HubLifecycleOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  let timers: Array<{ fn: () => void; ms: number }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
  const lifecycle = new HubLifecycle({
    identity: "self-reminder",
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer as any; },
    clearTimer: (timer) => { timers = timers.filter((candidate) => candidate !== (timer as unknown as { fn: () => void })); },
    log: (event, fields) => logs.push({ event, fields }),
    ...options,
  });
  return { lifecycle, sockets, logs, timers: () => timers };
}

/** Drives a harness to the point where the hub has accepted the registration. */
async function registered(options: Partial<HubLifecycleOptions> = {}): Promise<Harness> {
  const h = harness(options);
  h.lifecycle.start();
  h.sockets[0]!.emit("open");
  h.sockets[0]!.respondLast();
  await Promise.resolve();
  expect(h.lifecycle.isReady()).toBe(true);
  return h;
}

async function categoryOf(promise: Promise<unknown>): Promise<string> {
  return await promise.then(() => "resolved", (error) => (error as { category?: string }).category ?? "no-category");
}

describe("HubLifecycle.stop", () => {
  test("rejects the in-flight request as stopped and closes the socket", async () => {
    const h = await registered();
    const inflight = h.lifecycle.request("reminders.due", {});
    h.lifecycle.stop();
    expect(await categoryOf(inflight)).toBe("stopped");
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.lifecycle.isReady()).toBe(false);
  });

  test("a close that throws does not keep the lifecycle registered", async () => {
    const sockets: ClosePanicSocket[] = [];
    const h = harness({ createSocket: () => { const socket = new ClosePanicSocket(); sockets.push(socket); return socket; } });
    h.lifecycle.start();
    sockets[0]!.emit("open");
    sockets[0]!.respondLast();
    await Promise.resolve();
    expect(h.lifecycle.isReady()).toBe(true);

    expect(() => h.lifecycle.stop()).not.toThrow();
    expect(h.lifecycle.isReady()).toBe(false);
    expect(await categoryOf(h.lifecycle.request("reminders.due", {}))).toBe("hub_unavailable");
  });

  test("disarms a reconnect that was already scheduled", async () => {
    const h = harness();
    h.lifecycle.start();
    h.sockets[0]!.emit("open");
    h.sockets[0]!.rejectLast();
    await Promise.resolve();
    expect(h.timers()).toHaveLength(1);

    h.lifecycle.stop();
    expect(h.timers()).toHaveLength(0);
  });

  test("stopping before a socket exists closes nothing and stays stopped", () => {
    const h = harness();
    expect(() => h.lifecycle.stop()).not.toThrow();
    expect(h.sockets).toHaveLength(0);
    expect(h.lifecycle.isReady()).toBe(false);
  });

  test("a stopped lifecycle does not reconnect when its socket closes", async () => {
    const h = await registered();
    h.lifecycle.stop();
    h.sockets[0]!.emit("close");
    expect(h.timers()).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("HubLifecycle.request", () => {
  test("is unavailable before the hub has accepted the registration", async () => {
    const h = harness();
    h.lifecycle.start();
    h.sockets[0]!.emit("open");
    expect(await categoryOf(h.lifecycle.request("reminders.due", {}))).toBe("hub_unavailable");
  });

  test("is unavailable after the socket closes", async () => {
    const h = await registered();
    h.sockets[0]!.emit("close");
    expect(await categoryOf(h.lifecycle.request("reminders.due", {}))).toBe("hub_unavailable");
  });

  test("is unavailable while the registered socket is closing", async () => {
    const h = await registered();
    h.sockets[0]!.readyState = 2;
    expect(await categoryOf(h.lifecycle.request("reminders.due", {}))).toBe("hub_unavailable");
    expect(h.sockets[0]!.sent).toHaveLength(1);
  });

  test("sends over the registered socket and resolves with the hub result", async () => {
    const h = await registered();
    const inflight = h.lifecycle.request("reminders.due", { limit: 5 });
    const sent = h.sockets[0]!.sent.at(-1);
    expect(sent.method).toBe("reminders.due");
    expect(sent.params).toEqual({ limit: 5 });
    h.sockets[0]!.respondLast({ due: 2 });
    expect(await inflight).toEqual({ due: 2 });
  });

  test("a send that throws rejects as rpc_send_failed and leaves no timer armed", async () => {
    const h = await registered();
    const before = h.timers().length;
    h.sockets[0]!.send = () => { throw new Error("socket buffer is gone"); };
    expect(await categoryOf(h.lifecycle.request("reminders.due", {}))).toBe("rpc_send_failed");
    expect(h.timers()).toHaveLength(before);
  });

  test("times out at the configured deadline", async () => {
    const h = await registered({ rpcTimeoutMs: 4_000 });
    const inflight = h.lifecycle.request("reminders.due", {});
    expect(h.timers()).toHaveLength(1);
    expect(h.timers()[0]!.ms).toBe(4_000);

    h.timers()[0]!.fn();
    expect(await categoryOf(inflight)).toBe("rpc_timeout");
  });

  test("a timeout that fires after the reply cannot reject the settled request", async () => {
    const h = await registered();
    const inflight = h.lifecycle.request("reminders.due", {});
    const timeout = h.timers()[0]!;
    h.sockets[0]!.respondLast({ due: 0 });
    expect(await inflight).toEqual({ due: 0 });

    expect(() => timeout.fn()).not.toThrow();
    expect(await inflight).toEqual({ due: 0 });
  });
});

describe("HubLifecycle socket errors", () => {
  test("an error on the owning socket is logged against its generation", async () => {
    const h = await registered();
    h.sockets[0]!.emit("error", new Error("ECONNRESET"));
    const logged = h.logs.filter((entry) => entry.event === "hub_socket_error");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.fields).toEqual({ generation: 1 });
    expect(h.lifecycle.isReady()).toBe(true);
  });

  test("an error from a superseded socket is not logged", async () => {
    const h = harness();
    h.lifecycle.start();
    h.sockets[0]!.emit("open");
    h.sockets[0]!.rejectLast();
    await Promise.resolve();
    h.timers()[0]!.fn();
    h.sockets[1]!.emit("open");
    h.sockets[1]!.respondLast();
    await Promise.resolve();

    h.sockets[0]!.emit("error", new Error("ECONNRESET"));
    expect(h.logs.filter((entry) => entry.event === "hub_socket_error")).toHaveLength(0);
  });
});

describe("HubLifecycle post-registration work", () => {
  test("a failure carries its category and message, and leaves the registration standing", async () => {
    const h = await registered({
      onRegistered: () => Promise.reject(new Error("state write failed")),
    });
    await Promise.resolve();
    await Promise.resolve();

    const logged = h.logs.filter((entry) => entry.event === "hub_post_registration_failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.fields).toEqual({ generation: 1, error_category: "hub_rpc_failed", error: "state write failed" });
    expect(h.lifecycle.isReady()).toBe(true);
  });

  test("a rejection that is not an Error is still reported", async () => {
    const h = await registered({ onRegistered: () => Promise.reject("no reason given") as Promise<void> });
    await Promise.resolve();
    await Promise.resolve();

    const logged = h.logs.filter((entry) => entry.event === "hub_post_registration_failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.fields?.error).toBe("no reason given");
  });

  test("work that succeeds reports nothing", async () => {
    let ran = 0;
    const h = await registered({ onRegistered: () => { ran += 1; } });
    await Promise.resolve();
    await Promise.resolve();

    expect(ran).toBe(1);
    expect(h.logs.filter((entry) => entry.event === "hub_post_registration_failed")).toHaveLength(0);
  });
});

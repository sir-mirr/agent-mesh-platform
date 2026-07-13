import { describe, expect, test } from "bun:test";

import { HubLifecycle, type SocketLike } from "./lifecycle";

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

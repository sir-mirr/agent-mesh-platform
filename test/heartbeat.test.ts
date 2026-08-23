/**
 * Half-open socket detection against a real hub (SPEC § 3.1).
 *
 * The case this covers cannot be produced with a normal WebSocket client:
 * every runtime answers ping frames for you, so a client that is "silent" in
 * the sense that matters has to be written at the frame level. That is why
 * this file carries its own handshake and framing rather than using
 * `connectRpc` from the harness — a client that pongs proves nothing about a
 * heartbeat whose whole job is noticing one that does not.
 *
 * The hub runs with a short interval here. The production value is fixed at 30
 * seconds by § 3.1 and a test that waited two of those is a test nobody runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Socket } from "bun";

import { provision, startMesh, type Mesh, type Service } from "./harness";

let mesh: Mesh | null = null;

afterEach(() => {
  mesh?.stop();
  mesh = null;
});

const SWEEP_MS = 150;

async function startHubWithFastHeartbeat(): Promise<Mesh> {
  mesh = await startMesh({
    withHttp: false,
    env: { AGENT_MESH_HEARTBEAT_MS: String(SWEEP_MS) },
  });
  return mesh;
}

async function onlineCount(hub: Service): Promise<number> {
  const res = await fetch(`${hub.url}/health`);
  return ((await res.json()) as { online_agents: number }).online_agents;
}

/**
 * A client that completes the WebSocket handshake and then answers nothing.
 *
 * Inbound bytes are read and discarded without being parsed, so ping frames
 * arrive and are never answered — which is exactly a peer that has gone away
 * without the TCP connection noticing.
 */
interface SilentClient {
  send(text: string): void;
  close(): void;
}

async function openSilentClient(hub: Service, path = "/ws"): Promise<SilentClient> {
  let socket: Socket<undefined>;
  let received = "";
  const upgraded = Promise.withResolvers<void>();

  socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: hub.port,
    socket: {
      data(_s, chunk) {
        // Only the handshake is parsed. Everything after it — including the
        // hub's ping frames — is deliberately dropped on the floor.
        if (received.length < 4096) {
          received += chunk.toString("latin1");
          if (received.includes("\r\n\r\n")) {
            if (received.startsWith("HTTP/1.1 101")) upgraded.resolve();
            else upgraded.reject(new Error(`upgrade refused: ${received.split("\r\n")[0]}`));
          }
        }
      },
      error(_s, err) {
        upgraded.reject(err);
      },
    },
  });

  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${hub.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await upgraded.promise;

  return {
    send(text: string) {
      // Client-to-server frames must be masked (RFC 6455 § 5.3); an unmasked
      // one is a protocol error and the hub would close on it, which would
      // pass this test for the wrong reason.
      const payload = Buffer.from(text, "utf8");
      const mask = randomBytes(4);
      const header =
        payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : (() => {
              const h = Buffer.alloc(4);
              h[0] = 0x81;
              h[1] = 0x80 | 126;
              h.writeUInt16BE(payload.length, 2);
              return h;
            })();
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
      socket.write(Buffer.concat([header, mask, masked]));
    },
    close() {
      socket.end();
    },
  };
}

/** Poll rather than sleep a fixed multiple: sweeps are timer-driven. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(25);
  }
  return false;
}

describe("heartbeat", () => {
  test("a peer that stops answering pings is dropped from the online map", async () => {
    const { hub } = await startHubWithFastHeartbeat();
    expect((await provision(hub, "silent-agent")).status).toBe(201);

    const client = await openSilentClient(hub);
    client.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.connect", params: { identity: "silent-agent" } }),
    );

    expect(await waitFor(async () => (await onlineCount(hub)) === 1)).toBe(true);

    // Two sweeps: one to ping, one to judge. Before this change the hub pinged
    // forever and never judged, because `ws.ping()` returns a status rather
    // than throwing and the failure branch was unreachable.
    expect(await waitFor(async () => (await onlineCount(hub)) === 0)).toBe(true);

    // **The count moves before the line arrives.** `online_agents` is read over
    // HTTP the instant the sweep judges; the hub's log reaches `output()`
    // through a pipe this process drains on its own schedule, and on a loaded
    // runner that is a few milliseconds later. Asserting straight after the
    // count read an empty log and called a working heartbeat a defect — CI run
    // 32633321171, and green on every machine that was not busy.
    expect(
      await waitFor(async () => hub.output().includes('"event":"heartbeat_drop"')),
      "the peer was dropped and the hub never said so — a drop nothing announces is a socket that vanishes from an operator's count with no line to explain it",
    ).toBe(true);

    // The fields, not the sentence. A sentence can be reworded without any
    // operator noticing; `event` and `actor` are what a counter and a
    // complaint are answered from, so those are what this holds to.
    const dropped = hub.output()
      .split("\n")
      .filter((line) => line.includes('"event":"heartbeat_drop"'))
      .map((line) => JSON.parse(line.slice(line.lastIndexOf(' {"ts":"') + 1)));
    expect(dropped.map((event) => ({ actor: event.actor, reason: event.reason, level: event.level })))
      .toEqual([{ actor: "silent-agent", reason: "no_pong", level: "warn" }]);

    client.close();
  }, 20_000);

  test("a peer that answers pings stays online across many sweeps", async () => {
    const { hub } = await startHubWithFastHeartbeat();
    expect((await provision(hub, "chatty-agent")).status).toBe(201);

    // Bun's WebSocket answers pings for us, which is the whole difference
    // between this client and the one above.
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed to open"));
    });
    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.connect", params: { identity: "chatty-agent" } }),
    );
    expect(await waitFor(async () => (await onlineCount(hub)) === 1)).toBe(true);

    // Three sweeps: grace, ping, judge. This test is here for the one thing
    // the unit tests cannot fake — that a real socket's automatic pong reaches
    // the hub and counts as proof of life — and one judge cycle shows it.
    //
    // **Not eight.** Sleeping for eight intervals asserted "survives many
    // sweeps" by holding the machine to a schedule: the pong comes from this
    // process, so a stalled event loop under load produces a drop that is
    // correct behaviour and a red test. `Heartbeat` proves the many-sweep
    // property directly, twenty sweeps with no clock in it.
    await Bun.sleep(SWEEP_MS * 3);
    expect(
      await onlineCount(hub),
      "the peer was dropped despite answering; if the machine was loaded, its pong may simply have been late — check `hub.output()` below and what else was running",
    ).toBe(1);
    expect(hub.output()).not.toContain("chatty-agent did not answer");

    ws.close();
  }, 20_000);

  test("last_seen records when the dropped identity was last reachable", async () => {
    const { hub } = await startHubWithFastHeartbeat();
    expect((await provision(hub, "stamped-agent")).status).toBe(201);

    const before = await fetch(`${hub.url}/api/v1/agents/stamped-agent/keys`);
    expect(before.status).toBe(200);

    const client = await openSilentClient(hub);
    client.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.connect", params: { identity: "stamped-agent" } }),
    );
    expect(await waitFor(async () => (await onlineCount(hub)) === 1)).toBe(true);
    expect(await waitFor(async () => (await onlineCount(hub)) === 0)).toBe(true);

    // The identity survives being dropped — only the socket went away. A
    // heartbeat that removed the row would delete an identity over a network
    // blip.
    const after = await fetch(`${hub.url}/api/v1/agents/stamped-agent/keys`);
    expect(after.status).toBe(200);

    client.close();
  }, 20_000);

  test("the dropped socket's identity can be claimed again immediately", async () => {
    // The point of dropping it. A half-open socket that keeps ownership locks
    // the identity out until the hub restarts: the agent reconnects, is told
    // someone else holds its name, and the someone else is its own corpse.
    const { hub } = await startHubWithFastHeartbeat();
    expect((await provision(hub, "reclaim-agent")).status).toBe(201);

    const zombie = await openSilentClient(hub);
    zombie.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.connect", params: { identity: "reclaim-agent" } }),
    );
    expect(await waitFor(async () => (await onlineCount(hub)) === 1)).toBe(true);
    expect(await waitFor(async () => (await onlineCount(hub)) === 0)).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed to open"));
    });
    const reply = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.connect", params: { identity: "reclaim-agent" } }),
      );
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ identity: "reclaim-agent" });

    ws.close();
    zombie.close();
  }, 20_000);
});

/**
 * Hub integration — the wire surface of SPEC § 8 and § 9.2 against a running
 * process.
 *
 * These assertions were smoke tests run by hand after the broker was split
 * into modules. Two of them caught real breakage, so they are code now.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { connectRpc, newPublicKey, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;

beforeAll(async () => {
  mesh = await startMesh({ withHttp: false });
  await provision(mesh.hub, "agent-a", "service", "first");
  await provision(mesh.hub, "agent-b", "service");
});

afterAll(() => mesh?.stop());

describe("REST control plane", () => {
  test("GET /health reports liveness and the online count", async () => {
    const body = await (await fetch(`${mesh.hub.url}/health`)).json();
    expect(body).toMatchObject({ service: "Agent Mesh Hub" });
    expect(typeof body.online_agents).toBe("number");
  });

  test("provisioning returns 201 for a new identity and 200 for one that exists", async () => {
    const first = await provision(mesh.hub, "agent-new", "service", "hello");
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ action: "inserted", description: "hello" });

    const again = await provision(mesh.hub, "agent-new", "service", "changed");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ action: "updated", description: "changed" });
  });

  test("created_at survives an update — it is immutable post-insert (SPEC § 10.1)", async () => {
    const created = await (await provision(mesh.hub, "agent-stamp", "service")).json();
    await Bun.sleep(1100); // a second must pass or the timestamps tie
    const updated = await (await provision(mesh.hub, "agent-stamp", "service", "later")).json();
    expect(updated.created_at).toBe(created.created_at);
  });

  test("created_at is strict ISO-8601 with T and Z (SPEC § 10.1)", async () => {
    const body = await (await provision(mesh.hub, "agent-iso", "service")).json();
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("rejects an unknown type and a non-kebab-case identity", async () => {
    expect((await provision(mesh.hub, "agent-x", "not-a-type")).status).toBe(400);
    expect((await provision(mesh.hub, "Agent_X", "service")).status).toBe(400);
  });

  test("the unversioned alias always answers 200 and omits created_at", async () => {
    const res = await fetch(`${mesh.hub.url}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: "agent-legacy", type: "ai-codex", public_key: newPublicKey(),
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ action: "inserted" });
    expect(body.created_at).toBeUndefined();
  });

  test("the alias applies the same key rule as the canonical route", async () => {
    // An alias that accepted what the canonical route refuses would be a way
    // around § 10.1 rather than a compatibility shim.
    const res = await fetch(`${mesh.hub.url}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "alias-unkeyed", type: "ai-codex" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("requires a signing key");
  });
});

describe("mesh.connect", () => {
  test("connects a pre-registered identity", async () => {
    const rpc = await connectRpc(mesh.hub);
    expect(await rpc.call("mesh.connect", { identity: "agent-a" }))
      .toMatchObject({ result: { ok: true, identity: "agent-a" } });
    rpc.close();
  });

  test("rejects one that was never provisioned with -32011", async () => {
    const rpc = await connectRpc(mesh.hub);
    const res = await rpc.call("mesh.connect", { identity: "never-provisioned" });
    expect(res.error).toMatchObject({
      code: -32011,
      data: { code: "IDENTITY_NOT_REGISTERED" },
    });
    rpc.close();
  });

  test("keeps the incumbent when a second socket claims the same identity", async () => {
    const first = await connectRpc(mesh.hub);
    await first.call("mesh.connect", { identity: "agent-b" });

    const contender = await connectRpc(mesh.hub);
    const res = await contender.call("mesh.connect", { identity: "agent-b" });

    // The established owner is never evicted — the contender is the one told no.
    expect(res.error).toMatchObject({
      code: -32010,
      data: { ownership: "incumbent_retained" },
    });

    // And the incumbent is still usable.
    expect(await first.call("mesh.list_agents", {})).toHaveProperty("result");
    first.close();
    contender.close();
  });

  test("requires identity", async () => {
    const rpc = await connectRpc(mesh.hub);
    expect((await rpc.call("mesh.connect", {})).error).toMatchObject({ code: -32602 });
    rpc.close();
  });
});

describe("messaging", () => {
  test("queues for an offline recipient and replays on connect", async () => {
    const sender = await connectRpc(mesh.hub);
    await sender.call("mesh.connect", { identity: "agent-a" });

    const sent = await sender.call("mesh.send", { to: "agent-b", content: "while you were out" });
    expect(sent.result.status).toBe("pending");

    const recipient = await connectRpc(mesh.hub);
    await recipient.call("mesh.connect", { identity: "agent-b" });
    await Bun.sleep(150);

    const delivered = recipient.notifications().filter((n) => n.method === "mesh.message");
    expect(delivered.map((n) => n.params.content)).toContain("while you were out");

    sender.close();
    recipient.close();
  });

  test("delivers immediately when the recipient is online, and tells the sender", async () => {
    const recipient = await connectRpc(mesh.hub);
    await recipient.call("mesh.connect", { identity: "agent-b" });
    const sender = await connectRpc(mesh.hub);
    await sender.call("mesh.connect", { identity: "agent-a" });

    const sent = await sender.call("mesh.send", { to: "agent-b", content: "live" });
    expect(sent.result.status).toBe("delivered");
    await Bun.sleep(150);

    expect(recipient.notifications().some((n) => n.params?.content === "live")).toBe(true);
    // SPEC § 8.8.2: the sender is told, but only for a delivered message.
    expect(sender.notifications().some((n) => n.method === "mesh.delivered")).toBe(true);

    sender.close();
    recipient.close();
  });

  test("fetch_messages returns both directions of one conversation", async () => {
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "agent-a" });
    await rpc.call("mesh.send", { to: "agent-b", content: "history please" });

    const res = await rpc.call("mesh.fetch_messages", { agent_id: "agent-b" });
    expect(res.result.messages.some((m: any) => m.content === "history please")).toBe(true);
    rpc.close();
  });

  test("refuses to send before connecting", async () => {
    const rpc = await connectRpc(mesh.hub);
    expect((await rpc.call("mesh.send", { to: "agent-b", content: "x" })).error)
      .toMatchObject({ code: -32600 });
    rpc.close();
  });
});

describe("mesh.list_agents", () => {
  test("keys each agent by `id`, not `identity` (SPEC § 8.3)", async () => {
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "agent-a" });

    const agents = (await rpc.call("mesh.list_agents", {})).result.agents;
    const a = agents.find((x: any) => x.id === "agent-a");
    expect(a).toBeDefined();
    expect(a.online).toBe(true);
    expect(a).not.toHaveProperty("identity");
    rpc.close();
  });
});

describe("dispatch", () => {
  test("answers an unknown method rather than dropping the connection", async () => {
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "agent-a" });

    expect((await rpc.call("mesh.nonexistent", {})).error).toMatchObject({ code: -32601 });
    // Still alive afterwards.
    expect(await rpc.call("mesh.list_agents", {})).toHaveProperty("result");
    rpc.close();
  });
});

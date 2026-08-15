/**
 * Step 6 — who may speak for whom (SPEC § 8.2).
 *
 * `mesh.send`'s `from` override is load-bearing: the http server uses it to
 * forward for a signed-in person, who has no socket of their own. It was
 * accepted unchecked, so any connected socket could originate an envelope as
 * any identity.
 *
 * The rule turned out small because the question turned out small. Every other
 * participant holds a key and signs for itself, and the client team confirmed
 * lanes never proxy. So the override exists for one case — a participant who by
 * design holds no key — and that is now a type rather than a special case.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { connectRpc, newPublicKey, provision, provisionProxy, startMesh, type Mesh } from "./harness";

let mesh: Mesh;

beforeAll(async () => {
  mesh = await startMesh({ withHttp: false });
  await provisionProxy(mesh.hub, "gateway");
  await provision(mesh.hub, "person", "human");
  await provision(mesh.hub, "other-person", "human");
  await provision(mesh.hub, "recipient", "service");
  await provision(mesh.hub, "scheduler", "service");
  await provision(mesh.hub, "runtime", "ai-codex", null, newPublicKey());
});

afterAll(() => mesh?.stop());

async function asSocket(identity: string, proxyFor?: string[]) {
  const rpc = await connectRpc(mesh.hub);
  const res = await rpc.call("mesh.connect", {
    identity,
    ...(proxyFor ? { proxy_for: proxyFor } : {}),
  });
  return { rpc, connect: res };
}

describe("the case the override exists for", () => {
  test("a gateway may speak for a person it declared", async () => {
    const { rpc } = await asSocket("gateway", ["person"]);
    const res = await rpc.call("mesh.send", {
      to: "recipient", from: "person", content: "on their behalf",
    });
    rpc.close();
    expect(res.result.status).toBeTruthy();
    expect(res.error).toBeUndefined();
  });

  test("sending as yourself needs no entitlement at all", async () => {
    const { rpc } = await asSocket("scheduler");
    const res = await rpc.call("mesh.send", { to: "recipient", content: "mine" });
    rpc.close();
    expect(res.error).toBeUndefined();
  });
});

describe("refusals", () => {
  test("an identity without the grant cannot speak for anyone", async () => {
    // The scheduler is a `service` exactly as the gateway is. Without a
    // per-identity grant, a type check alone would let it impersonate a person.
    const { rpc } = await asSocket("scheduler", ["person"]);
    const res = await rpc.call("mesh.send", {
      to: "recipient", from: "person", content: "not mine to send",
    });
    rpc.close();
    expect(res.error).toMatchObject({ code: -32013 });
    expect(res.error.message).toContain("not entitled");
  });

  test("a gateway cannot speak for an identity that holds its own key", async () => {
    // This is the substantive half. An identity that can sign has no need of a
    // proxy, so a claim over it is either redundant or a lie — and stating it
    // against the type registry makes it true rather than merely configured.
    const { rpc } = await asSocket("gateway", ["runtime"]);
    const res = await rpc.call("mesh.send", {
      to: "recipient", from: "runtime", content: "impersonating a runtime",
    });
    rpc.close();
    expect(res.error).toMatchObject({ code: -32013 });
    expect(res.error.message).toContain("signs for itself");
  });

  test("a gateway cannot speak for a person it did not declare", async () => {
    // Entitled in principle, undeclared on this socket. Both are required, so a
    // socket cannot reach beyond what it announced at connect.
    const { rpc } = await asSocket("gateway", ["person"]);
    const res = await rpc.call("mesh.send", {
      to: "recipient", from: "other-person", content: "undeclared",
    });
    rpc.close();
    expect(res.error).toMatchObject({ code: -32013 });
    expect(res.error.message).toContain("proxy_for");
  });

  test("nobody can speak for an identity that does not exist", async () => {
    const { rpc } = await asSocket("gateway", ["person"]);
    const res = await rpc.call("mesh.send", {
      to: "recipient", from: "invented-person", content: "who?",
    });
    rpc.close();
    expect(res.error).toMatchObject({ code: -32013 });
    expect(res.error.message).toContain("no such identity");
  });

  test("a torn-down identity cannot be spoken for", async () => {
    await provision(mesh.hub, "departed", "human");
    await fetch(`${mesh.hub.url}/api/agents/departed`, { method: "DELETE" });

    const { rpc } = await asSocket("gateway", ["departed"]);
    const res = await rpc.call("mesh.send", {
      to: "recipient", from: "departed", content: "still here?",
    });
    rpc.close();
    expect(res.error).toMatchObject({ code: -32013 });
  });
});

describe("proxy_for at connect", () => {
  test("unentitled claims are dropped, not fatal", async () => {
    // The gateway declares every approved person at once. Refusing the whole
    // connection over one bad entry would take the entire web surface down, so
    // the bad entry is dropped and refused per-message instead — which
    // attributes the failure to the one person affected rather than to everyone.
    const { rpc, connect } = await asSocket("gateway", ["person", "runtime"]);
    expect(connect.result.ok).toBe(true);

    const good = await rpc.call("mesh.send", { to: "recipient", from: "person", content: "fine" });
    expect(good.error).toBeUndefined();

    const bad = await rpc.call("mesh.send", { to: "recipient", from: "runtime", content: "no" });
    expect(bad.error).toMatchObject({ code: -32013 });
    rpc.close();
  });

  test("a dropped claim does not route the subject's live mail to that socket", async () => {
    // The claim is not honoured, so the hub must not have wired the identity
    // into this socket either — otherwise a refused proxy still intercepts.
    const { rpc } = await asSocket("gateway", ["runtime"]);
    const sender = await connectRpc(mesh.hub);
    await sender.call("mesh.connect", { identity: "scheduler" });
    await sender.call("mesh.send", { to: "runtime", content: "for the runtime only" });
    await Bun.sleep(100);

    expect(rpc.notifications().filter((n) => n.method === "mesh.message")).toHaveLength(0);
    sender.close();
    rpc.close();
  });

  test("a dropped claim does not receive the subject's QUEUED mail either", async () => {
    // The case the test above misses, and the one that mattered: it connects
    // the impostor *before* anything is queued, so it only ever exercised live
    // routing. The replay at connect is a second path into the same socket, and
    // it was looping over the declared claims rather than the granted ones.
    //
    // The consequence was not a leak alone. The replay marks rows delivered, so
    // the rightful recipient never received them — interception that also
    // destroys the evidence.
    await provision(mesh.hub, "queued-subject", "ai-codex", null, newPublicKey());

    const sender = await connectRpc(mesh.hub);
    await sender.call("mesh.connect", { identity: "scheduler" });
    await sender.call("mesh.send", { to: "queued-subject", content: "for its eyes only" });
    sender.close();

    // The impostor connects *after* the message is waiting.
    const { rpc: impostor } = await asSocket("gateway", ["queued-subject"]);
    await Bun.sleep(150);
    expect(impostor.notifications().filter((n) => n.method === "mesh.message")).toHaveLength(0);
    impostor.close();

    // And it is still queued for whoever is entitled to it. Read from the store
    // rather than by connecting as the subject: the leak destroyed evidence by
    // marking rows delivered, so the assertion has to be about the row.
    const hub = new Database(join(mesh.stateDir, "hub.db"), { readonly: true });
    const row = hub.prepare(
      `SELECT status FROM messages WHERE to_agent = ? AND content = ?`,
    ).get("queued-subject", "for its eyes only") as { status: string };
    hub.close();
    expect(row.status).toBe("pending");
  });
});

describe("checked live, not at connect", () => {
  test("withdrawing the grant takes effect on the next send", async () => {
    await provisionProxy(mesh.hub, "revocable");
    const { rpc } = await asSocket("revocable", ["person"]);
    expect((await rpc.call("mesh.send", { to: "recipient", from: "person", content: "1" })).error)
      .toBeUndefined();

    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "revocable", type: "service", can_proxy: false }),
    });

    // On the open socket, without waiting for a reconnect. An operator who
    // withdraws a grant means it from that moment — the same reasoning as
    // reading the signing key per request rather than caching it (§ 8.1).
    const after = await rpc.call("mesh.send", { to: "recipient", from: "person", content: "2" });
    rpc.close();
    expect(after.error).toMatchObject({ code: -32013 });
  });

  test("a grant is not stripped by an unrelated update", async () => {
    await provisionProxy(mesh.hub, "kept-grant");
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "kept-grant", type: "service", description: "renamed" }),
    });

    const { rpc } = await asSocket("kept-grant", ["person"]);
    const res = await rpc.call("mesh.send", { to: "recipient", from: "person", content: "still ok" });
    rpc.close();
    expect(res.error).toBeUndefined();
  });
});

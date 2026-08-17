/**
 * SPEC § 14 / § 10.2 / § 8.10.1 — what an operator does something about.
 *
 * **Every assertion here moves a number off zero first.** An empty mesh answers
 * this route with zeros for everything, and a route that returned hardcoded
 * zeros would pass any test written against that mesh. The front end this
 * replaces was a screen of constants — `139` sessions, `1024` MB, `99.99%` —
 * that no typecheck and no build ever objected to, because a constant is
 * perfectly well typed. The only check that separates them is whether the
 * number follows the mesh.
 *
 * The requirement asked for CPU, RSS, heap and event-loop lag. Those are not
 * here (decision D-1): there is one hub process by design and no autoscaler, so
 * an operator reading `RSS: 412MB` learns something true and acts on none of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { connectRpc, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
}, 60_000);
afterAll(() => mesh?.stop());

const telemetry = async (query = "") =>
  (await (await fetch(`${mesh.http.url}/api/v1/admin/telemetry${query}`, { headers: { cookie } })).json()) as any;

describe("the numbers follow the mesh", () => {
  test("a key waiting for a decision appears, having not been there before", async () => {
    const before = await telemetry();
    expect(before.keys_awaiting_decision.waiting).toBe(0);
    expect(before.keys_awaiting_decision.oldest).toBeNull();

    const key = newKeyPair();
    expect((await provision(mesh.hub, "telemetry-waiting", "ai-claude", null, key.publicKey)).status).toBe(201);

    const after = await telemetry();
    expect(after.keys_awaiting_decision.waiting, "provisioning a key did not move the count").toBe(1);
    // The oldest timestamp is what makes it actionable — a count says somebody
    // is waiting, this says how long.
    expect(after.keys_awaiting_decision.oldest).toBeTruthy();
  }, 30_000);

  test("a message nobody drains shows up as a lane, named", async () => {
    const before = await telemetry();
    expect(before.lanes_not_draining).toEqual([]);

    const sender = newKeyPair(), recipient = newKeyPair();
    await provision(mesh.hub, "telemetry-sender", "ai-claude", null, sender.publicKey);
    await provision(mesh.hub, "telemetry-recipient", "ai-claude", null, recipient.publicKey);
    for (const fp of [sender.fingerprint, recipient.fingerprint]) {
      await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ fingerprint: fp }),
      });
    }

    const rpc = await connectRpc(mesh.hub, { kid: sender.fingerprint, privateKey: sender.privateKey });
    await rpc.call("mesh.connect", { identity: "telemetry-sender" });
    await rpc.call("mesh.send", { to: "telemetry-recipient", content: "nobody is draining this" });
    rpc.close();

    const after = await telemetry();
    const lane = after.lanes_not_draining.find((l: any) => l.identity === "telemetry-recipient");
    expect(lane, "the undrained lane is not reported").toBeDefined();
    expect(lane.pending).toBeGreaterThan(0);
    // An operator chases a lane, not a total — so the identity has to be here.
    expect(lane.oldest).toBeTruthy();

    // And the mesh is carrying something, which is a different question from
    // whether anything is stuck.
    expect(after.messages_accepted, "an accepted message was not counted").toBeGreaterThan(0);
  }, 45_000);
});

describe("what it says when it cannot answer", () => {
  test("the limits come from the hub, with the configuration that produced them", async () => {
    const body = await telemetry();
    expect(body.rate_limits_error, `the hub did not answer: ${body.rate_limits_error}`).toBeNull();

    const names = (body.rate_limits as Array<{ name: string }>).map((l) => l.name).sort();
    expect(names).toEqual(["provision", "signed"]);

    // The configuration travels with the count. A refusal total means nothing
    // without knowing how tightly the bucket was set.
    for (const l of body.rate_limits as Array<any>) {
      expect(typeof l.refusals).toBe("number");
      expect(l.capacity, `${l.name} reports no capacity`).toBeGreaterThan(0);
    }
  }, 30_000);

  test("the two it cannot measure are named rather than reported as zero", async () => {
    // **A zero nobody can make non-zero says nothing about the thing it names.**
    // Signature and egress refusals are refused and logged to stdout; no write
    // path exists, so there is no store to query. Reporting `0` would tell an
    // operator the mesh is calm about a question nobody asked.
    const body = await telemetry();
    expect(body.not_measured.signature_refusals).toContain("no write path");
    expect(body.not_measured.egress_refusals).toContain("no write path");
    expect(body.signature_refusals, "reported a count it cannot have").toBeUndefined();
    expect(body.egress_refusals, "reported a count it cannot have").toBeUndefined();
  }, 30_000);
});

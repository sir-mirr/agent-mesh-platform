/**
 * The socketless transport (SPEC § 8.10).
 *
 * A participant driven by an application rather than a daemon is awake only
 * while it is answering. It cannot hold a socket and has nowhere to be pushed
 * to, so it sends when it is awake and drains its inbox when it next is.
 *
 * The queue is not a second store. The pending rows an adapter would be handed
 * on connect are the rows `mesh.receive` returns — the same identity reached
 * either way sees the same inbox, which is the whole point of not building a
 * separate mail service.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  callHttp, connectRpc, loginAsAdmin, newKeyPair, provision, startMesh,
  type KeyPair, type Mesh,
} from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
});

afterAll(() => mesh?.stop());

/** An identity with an approved key — what a mailbox agent registers as. */
async function agent(identity: string, type = "ai-codex"): Promise<KeyPair> {
  const kp = newKeyPair();
  await provision(mesh.hub, identity, type, null, kp.publicKey);
  await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fingerprint: kp.fingerprint }),
  });
  return kp;
}

const signer = (kp: KeyPair) => ({ kid: kp.fingerprint, privateKey: kp.privateKey });

describe("sending without a socket", () => {
  test("a mailbox agent sends, and the message reaches a socket agent", async () => {
    const mail = await agent("mail-sender");
    const live = await agent("mail-live");

    const socket = await connectRpc(mesh.hub, signer(live));
    await socket.call("mesh.connect", { identity: "mail-live" });

    const res = await callHttp(mesh.hub, signer(mail), "mesh.send", {
      to: "mail-live", content: "from an agent with no socket",
    });

    expect(res.status).toBe(200);
    // Delivered, not queued: the recipient is online, so the hub pushes it as
    // it would any other message. Nothing about the sender's transport reaches
    // the recipient.
    expect(res.body.result.status).toBe("delivered");

    await Bun.sleep(100);
    const pushed = socket.notifications().find((n) => n.method === "mesh.message");
    expect(pushed.params).toMatchObject({ from: "mail-sender", content: "from an agent with no socket" });
    socket.close();
  });

  test("the sender is the signing identity, not a claim", async () => {
    const mail = await agent("mail-honest");
    await provision(mesh.hub, "mail-target", "service");

    // `from` names someone else. Entitlement refuses it — the identity came
    // from the key, so there is nothing to overrule.
    const res = await callHttp(mesh.hub, signer(mail), "mesh.send", {
      to: "mail-target", from: "mail-live", content: "not mine to send",
    });
    expect(res.body.error).toMatchObject({ code: -32013 });
  });
});

describe("draining an inbox", () => {
  test("mesh.receive returns what was queued while the agent was away", async () => {
    const mail = await agent("mail-receiver");
    const sender = await agent("mail-poster");

    // The recipient is not connected, so these queue exactly as they would for
    // an adapter that is offline.
    for (const content of ["first", "second"]) {
      const res = await callHttp(mesh.hub, signer(sender), "mesh.send", {
        to: "mail-receiver", content,
      });
      expect(res.body.result.status).toBe("pending");
    }

    const drain = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    expect(drain.body.result.messages.map((m: any) => m.content)).toEqual(["first", "second"]);
    expect(drain.body.result.remaining).toBe(0);

    // Reading marks delivered in the same transaction, so a second call is
    // empty. One round trip has no window in which an arriving message is
    // cleared by an acknowledgement that predates it.
    const again = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    expect(again.body.result.messages).toHaveLength(0);
  });

  test("it carries sent_by, like every other delivery path", async () => {
    const mail = await agent("mail-attrib");
    const sender = await agent("mail-attrib-sender");
    await callHttp(mesh.hub, signer(sender), "mesh.send", { to: "mail-attrib", content: "x" });

    const drain = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    // Attribution that survives a socket but not a poll would not be
    // attribution.
    expect(drain.body.result.messages[0]).toMatchObject({
      from: "mail-attrib-sender", sent_by: "mail-attrib-sender",
    });
  });

  test("a backlog reports how much is left", async () => {
    const mail = await agent("mail-backlog");
    const sender = await agent("mail-backlog-sender");
    for (let i = 0; i < 5; i++) {
      await callHttp(mesh.hub, signer(sender), "mesh.send", { to: "mail-backlog", content: `m${i}` });
    }

    const first = await callHttp(mesh.hub, signer(mail), "mesh.receive", { limit: 2 });
    expect(first.body.result.messages).toHaveLength(2);
    // So a caller draining a backlog comes straight back rather than waiting
    // for its next scheduled check.
    expect(first.body.result.remaining).toBe(3);
  });

  test("the same inbox is seen over a socket", async () => {
    // Not a second store: what mesh.receive drains is what connect would replay.
    const mail = await agent("mail-either-way");
    const sender = await agent("mail-either-sender");
    await callHttp(mesh.hub, signer(sender), "mesh.send", { to: "mail-either-way", content: "queued" });

    const socket = await connectRpc(mesh.hub, signer(mail));
    await socket.call("mesh.connect", { identity: "mail-either-way" });
    await Bun.sleep(100);
    const replayed = socket.notifications().find((n) => n.method === "mesh.message");
    expect(replayed.params.content).toBe("queued");
    socket.close();

    const drain = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    expect(drain.body.result.messages).toHaveLength(0);
  });
});

describe("what the transport refuses", () => {
  test("an unsigned request, because nothing says who is asking", async () => {
    const res = await fetch(`${mesh.hub.url}/api/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.receive", params: {} }),
    });
    expect(res.status).toBe(401);
    // Not an extra rule so much as the absence of one: with no socket to have
    // connected on, an unsigned request carries no identity at all.
    expect((await res.json()).error.message).toContain("must be signed");
  });

  test("a key that is not approved, so a revoked one stops naming its holder", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "mail-unapproved", "ai-codex", null, kp.publicKey);
    const res = await callHttp(mesh.hub, signer(kp), "mesh.receive", {});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("no approved key");
  });

  test("a revoked key stops working immediately", async () => {
    const kp = await agent("mail-revoked");
    expect((await callHttp(mesh.hub, signer(kp), "mesh.receive", {})).status).toBe(200);

    await fetch(`${mesh.http.url}/api/v1/admin/keys/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fingerprint: kp.fingerprint, reason: "compromise" }),
    });

    const after = await callHttp(mesh.hub, signer(kp), "mesh.receive", {});
    expect(after.status).toBe(403);
  });

  test("mesh.connect, because there is no socket to mark online", async () => {
    const kp = await agent("mail-connector");
    const res = await callHttp(mesh.hub, signer(kp), "mesh.connect", { identity: "mail-connector" });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain("not available over HTTP");
  });

  test("a mailbox agent never appears online", async () => {
    // It has nowhere to be pushed to, so a sender must not be told its message
    // was delivered.
    const mail = await agent("mail-never-online");
    const sender = await agent("mail-online-checker");
    await callHttp(mesh.hub, signer(mail), "mesh.receive", {});

    const res = await callHttp(mesh.hub, signer(sender), "mesh.send", {
      to: "mail-never-online", content: "are you there",
    });
    expect(res.body.result.status).toBe("pending");
  });

  test("a replayed frame, by the same nonce rule as the socket", async () => {
    const kp = await agent("mail-replay");
    const { requestSignaturePreimage } = await import("@agent-mesh/contracts");
    const { randomUUID, sign } = await import("node:crypto");

    const rawParams = "{}";
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const value = Buffer.from(sign(null, Buffer.from(requestSignaturePreimage({
      method: "mesh.receive", kid: kp.fingerprint, nonce, iat,
      rawParams: new TextEncoder().encode(rawParams),
    })), kp.privateKey)).toString("base64url");
    const frame = `{"jsonrpc":"2.0","id":1,"method":"mesh.receive","params":${rawParams},"sig":${
      JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value })}}`;

    const post = () => fetch(`${mesh.hub.url}/api/v1/rpc`, {
      method: "POST", headers: { "content-type": "application/json" }, body: frame,
    });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(401);
  });
});

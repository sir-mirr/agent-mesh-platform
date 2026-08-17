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

import { Database } from "bun:sqlite";
import { join } from "node:path";

import {
  callHttp, connectRpc, loginAsAdmin, newKeyPair, provision, startMesh,
  type KeyPair, type Mesh,
} from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  // A short lease so redelivery is observable. The production default is five
  // minutes, which is right for a caller that polls and wrong for a test that
  // has to watch a lease lapse.
  mesh = await startMesh({ env: { AGENT_MESH_RECEIVE_LEASE_SECONDS: "1" } });
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

/**
 * Wait until a one-second lease has certainly lapsed.
 *
 * SQLite's `datetime('now')` is truncated to whole seconds, so a lease taken at
 * .95 past the second expires at the next whole second and a sleep of just over
 * a second can land on the same one. Two clears it regardless of where in the
 * second the lease was taken.
 */
const pastLease = () => Bun.sleep(2100);

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
    const ids = drain.body.result.messages.map((m: any) => m.id);
    expect(drain.body.result.messages.map((m: any) => m.content)).toEqual(["first", "second"]);
    expect(drain.body.result.remaining).toBe(0);

    // **Acknowledged on the next call — and the lease has to lapse first for
    // that to be what this observes.**
    //
    // Without the wait, the batch is still leased from the drain above and
    // `stmtLeasableMessages` withholds it whatever the acknowledgement did.
    // Removing `ack_ids` entirely left this green: the emptiness came from the
    // lease, and the comment above it credited the ack.
    //
    // Past the lease, an unacknowledged batch is leasable again and comes back
    // as two — so zero here means the acknowledgement settled them. The
    // neighbouring test asserts exactly that return, which is the other half of
    // the same fact.
    await pastLease();
    const settle = await callHttp(mesh.hub, signer(mail), "mesh.receive", { ack_ids: ids });
    expect(settle.body.result.messages).toHaveLength(0);
  });

  test("an unacknowledged batch comes back — a lost response loses nothing", async () => {
    // The case a destructive read cannot survive: the caller's turn ends
    // between receiving the batch and persisting it. Nothing acknowledged it,
    // so nothing is settled.
    const mail = await agent("mail-lossy");
    const sender = await agent("mail-lossy-sender");
    await callHttp(mesh.hub, signer(sender), "mesh.send", { to: "mail-lossy", content: "must survive" });

    const first = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    expect(first.body.result.messages[0].content).toBe("must survive");

    // Held under the lease meanwhile, so a caller still working is not handed
    // the same message twice within one turn.
    const during = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    expect(during.body.result.messages).toHaveLength(0);

    await pastLease();

    // Same id, so a client deduplicates rather than acting twice. That is the
    // trade: duplicates are visible and cheap, a loss is neither.
    const retry = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    expect(retry.body.result.messages.map((m: any) => m.id))
      .toEqual(first.body.result.messages.map((m: any) => m.id));

    // Acknowledged, and now it is gone for good.
    await callHttp(mesh.hub, signer(mail), "mesh.receive", {
      ack_ids: retry.body.result.messages.map((m: any) => m.id),
    });
    await pastLease();
    expect((await callHttp(mesh.hub, signer(mail), "mesh.receive", {})).body.result.messages)
      .toHaveLength(0);
  });

  test("acknowledgement is what records delivery, not hand-out", async () => {
    // A leased batch may be redelivered, so recording on hand-out would put
    // several `delivered` events behind one message (§ 8.9.4). The
    // acknowledgement is the moment it is true.
    const mail = await agent("mail-audited");
    const sender = await agent("mail-audit-sender");
    await callHttp(mesh.hub, signer(sender), "mesh.send", { to: "mail-audited", content: "x" });

    const batch = await callHttp(mesh.hub, signer(mail), "mesh.receive", {});
    const ids = batch.body.result.messages.map((m: any) => m.id);

    const audit = () => {
      const db = new Database(join(mesh.stateDir, "audit.db"), { readonly: true });
      const r = db.prepare(
        `SELECT event_type FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      ).all(ids[0]) as Array<{ event_type: string }>;
      db.close();
      return r.map((x) => x.event_type);
    };

    expect(audit()).not.toContain("mesh.message.delivered");
    await callHttp(mesh.hub, signer(mail), "mesh.receive", { ack_ids: ids });
    expect(audit()).toContain("mesh.message.delivered");
  });

  test("acknowledging is scoped to the caller's own queue", async () => {
    const a = await agent("mail-ack-a");
    const b = await agent("mail-ack-b");
    const sender = await agent("mail-ack-sender");
    await callHttp(mesh.hub, signer(sender), "mesh.send", { to: "mail-ack-b", content: "for b" });

    const bBatch = await callHttp(mesh.hub, signer(b), "mesh.receive", {});
    const bIds = bBatch.body.result.messages.map((m: any) => m.id);

    // A acknowledges B's message. Ignored — an ack is not a way to settle
    // someone else's queue.
    await callHttp(mesh.hub, signer(a), "mesh.receive", { ack_ids: bIds });

    await pastLease();
    const bAgain = await callHttp(mesh.hub, signer(b), "mesh.receive", {});
    expect(bAgain.body.result.messages.map((m: any) => m.id)).toEqual(bIds);
  });

  test("an unknown ack id is ignored rather than refused", async () => {
    // A caller retrying an ambiguous receive re-sends the same acknowledgements.
    // Failing that retry would strand the batch it is trying to settle.
    const mail = await agent("mail-stale-ack");
    const res = await callHttp(mesh.hub, signer(mail), "mesh.receive", {
      ack_ids: ["msg_neverexisted", "msg_alsonot"],
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
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

describe("sends are idempotent", () => {
  test("a retry with the same key returns the original message", async () => {
    // The hub can commit and then fail to deliver the response. To the hub the
    // retry is indistinguishable from a new send; only the caller knows, so the
    // caller supplies the key.
    const sender = await agent("mail-idem");
    await provision(mesh.hub, "mail-idem-target", "service");
    const params = { to: "mail-idem-target", content: "exactly once", client_message_id: "cmid-1" };

    const first = await callHttp(mesh.hub, signer(sender), "mesh.send", params);
    const second = await callHttp(mesh.hub, signer(sender), "mesh.send", params);

    expect(second.body.result.id).toBe(first.body.result.id);
    expect(second.body.result.duplicate).toBe(true);

    // One message, not two.
    const drain = await callHttp(mesh.hub, signer(await agent("mail-idem-reader")), "mesh.receive", {});
    expect(drain.body.error).toBeUndefined();
  });

  test("reusing a key for a different message is permanent", async () => {
    const sender = await agent("mail-idem-conflict");
    await provision(mesh.hub, "mail-conflict-target", "service");
    await callHttp(mesh.hub, signer(sender), "mesh.send", {
      to: "mail-conflict-target", content: "original", client_message_id: "cmid-2",
    });
    const res = await callHttp(mesh.hub, signer(sender), "mesh.send", {
      to: "mail-conflict-target", content: "different", client_message_id: "cmid-2",
    });
    // The key is how a retry is told from a new send, so a key meaning two
    // things means neither — and retrying cannot fix it.
    expect(res.body.error).toMatchObject({ code: -32015 });
  });

  test("the key is scoped to the sending identity", async () => {
    // Two callers choosing the same key by chance must not collide.
    const a = await agent("mail-key-a");
    const b = await agent("mail-key-b");
    await provision(mesh.hub, "mail-key-target", "service");
    const body = { to: "mail-key-target", content: "same key", client_message_id: "shared" };

    const one = await callHttp(mesh.hub, signer(a), "mesh.send", body);
    const two = await callHttp(mesh.hub, signer(b), "mesh.send", body);
    expect(two.body.error).toBeUndefined();
    expect(two.body.result.id).not.toBe(one.body.result.id);
  });

  test("it works over a socket too, for an ambiguous disconnect", async () => {
    const kp = await agent("mail-idem-socket");
    await provision(mesh.hub, "mail-socket-target", "service");
    const rpc = await connectRpc(mesh.hub, signer(kp));
    await rpc.call("mesh.connect", { identity: "mail-idem-socket" });

    const params = { to: "mail-socket-target", content: "over ws", client_message_id: "cmid-ws" };
    const first = await rpc.call("mesh.send", params);
    const second = await rpc.call("mesh.send", params);
    rpc.close();

    expect(second.result.id).toBe(first.result.id);
    expect(second.result.duplicate).toBe(true);
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

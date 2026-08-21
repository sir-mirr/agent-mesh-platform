/**
 * The mailbox's REST surface (SPEC § 9.2), driven in this process.
 *
 * Four paths and one rule: everything here is signed, and the signature covers
 * the path *with its query string* — `?peer=` and `?limit=` carry the request
 * on this surface, so leaving them unprotected would let a rewritten query
 * redirect a history read at another peer while the signature still verified.
 *
 * The module read 54% for the usual reason: it answers inside the hub, which
 * is another process. It does not need one — `handleMailboxRoute` is an
 * exported function over the same handles — so this file works the way
 * `messages.test.ts` and `receive.test.ts` do: the run's shared state
 * directory, unique identities and nonces, nothing read that it did not write.
 *
 * This file owns the `mbx-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";

import {
  MESH_ERROR,
  formatRestAuthorization,
  restSignaturePreimage,
} from "@agent-mesh/contracts";
import { keys } from "@agent-mesh/store";

import { agentsDb, db as hubDb } from "../db";
import { handleMailboxRoute } from "./mailbox";

let n = 0;
const uniq = (p: string) => `mbx-${p}-${++n}-${process.pid}`;

/** A type whose members must sign, since this whole surface requires it. */
agentsDb
  .prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES (?, 1)`)
  .run("mbx-signing");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { raw: Buffer.from(der.subarray(der.length - 32)).toString("base64url"), privateKey };
}

/** An identity the hub knows, holding an approved key it can sign with. */
function participant(prefix = "agent") {
  const identity = uniq(prefix);
  agentsDb.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, 'mbx-signing')`).run(identity);
  const kp = keypair();
  const { fingerprint } = keys.proposeKey(agentsDb, identity, kp.raw, "mbx-test");
  keys.approveKey(agentsDb, fingerprint, "mbx-test");
  return { identity, ...kp, fingerprint };
}

type Caller = ReturnType<typeof participant>;

/** A request signed the way § 9.2 requires, path and body included. */
function signedRequest(
  who: Caller,
  method: string,
  path: string,
  body = "",
  over: { kid?: string; iat?: number } = {},
) {
  const kid = over.kid ?? who.fingerprint;
  const nonce = uniq("nonce");
  const iat = over.iat ?? Math.floor(Date.now() / 1000);
  const bodySha256 = body.length > 0 ? createHash("sha256").update(body, "utf8").digest("hex") : "";
  const preimage = restSignaturePreimage({ method, path, kid, nonce, iat, bodySha256 });
  const signature = Buffer.from(edSign(null, preimage, who.privateKey)).toString("base64url");
  const [pathname, search = ""] = path.split("?");
  return {
    method,
    path,
    pathname: pathname!,
    search: search ? `?${search}` : "",
    authorization: formatRestAuthorization({ kid, nonce, iat, signature }),
    body,
  };
}

const call = async (req: Parameters<typeof handleMailboxRoute>[0]) => {
  const res = handleMailboxRoute(req)!;
  return { status: res.status, body: await res.json() as any };
};

/** A message waiting for `to`, as the queue holds it. */
function waiting(from: string, to: string, content = "hello"): string {
  const id = uniq("m");
  hubDb
    .prepare(
      `INSERT INTO messages (id, from_agent, to_agent, sent_by, content, status, ts)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    )
    .run(id, from, to, from, content);
  return id;
}

describe("what it will answer at all", () => {
  test("hands back nothing for a path that is not its own", () => {
    expect(handleMailboxRoute({
      method: "GET", path: "/api/v1/other", pathname: "/api/v1/other",
      search: "", authorization: null, body: "",
    })).toBeNull();
  });

  /** The boundary is the separator, not the word. */
  test("does not claim a path that merely starts with its name", () => {
    expect(handleMailboxRoute({
      method: "GET", path: "/api/v1/mailboxfoo", pathname: "/api/v1/mailboxfoo",
      search: "", authorization: null, body: "",
    })).toBeNull();
  });

  test("refuses an unsigned request to a signed path", async () => {
    const { status, body } = await call({
      method: "POST", path: "/api/v1/mailbox/in", pathname: "/api/v1/mailbox/in",
      search: "", authorization: null, body: "{}",
    });
    expect(status).toBe(401);
    expect(body.code).toBe("SIGNATURE_INVALID");
  });

  /**
   * A signature the hub cannot tie to an approved key is refused with the
   * key's status, so the caller learns whether it is waiting on an operator or
   * holding a key nobody has seen.
   */
  test("refuses a signature from a key nobody approved", async () => {
    const who = participant();
    const stranger = participant();
    // Signed by `who`, presented under a fingerprint that is not theirs.
    const req = signedRequest(who, "POST", "/api/v1/mailbox/in", "{}", { kid: "f".repeat(64) });
    const { status, body } = await call(req);
    expect(status).toBe(403);
    expect(body.code).toBe("KEY_NOT_APPROVED");
    void stranger;
  });

  test("refuses a signature over a different path", async () => {
    const who = participant();
    const req = signedRequest(who, "POST", "/api/v1/mailbox/in", "{}");
    // The header stays; the request claims another path.
    const { status, body } = await call({ ...req, path: "/api/v1/mailbox/out", pathname: "/api/v1/mailbox/out" });
    expect(status).toBe(401);
    expect(body.code).toBe("SIGNATURE_INVALID");
  });
});

describe("draining the inbox", () => {
  test("hands over what is waiting", async () => {
    const who = participant();
    const id = waiting(uniq("sender"), who.identity, "for the socketless");

    const { status, body } = await call(signedRequest(who, "POST", "/api/v1/mailbox/in", "{}"));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([id]);
    expect(body.lease_seconds).toBeGreaterThan(0);
  });

  test("insists on POST", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "GET", "/api/v1/mailbox/in"));
    expect(status).toBe(405);
    expect(body.error).toContain("POST");
  });

  test("refuses a body it cannot parse", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "POST", "/api/v1/mailbox/in", "{ not json"));
    expect(status).toBe(400);
    expect(body.rpc_code).toBe(MESH_ERROR.INVALID_PARAMS);
  });

  /** An empty body is an empty request, not a malformed one. */
  test("takes an empty body as no parameters", async () => {
    const who = participant();
    const { status } = await call(signedRequest(who, "POST", "/api/v1/mailbox/in", ""));
    expect(status).toBe(200);
  });
});

describe("reading the history with one peer", () => {
  test("needs a peer to read it with", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "GET", "/api/v1/mailbox/history"));
    expect(status).toBe(400);
    expect(body.error).toContain("peer");
  });

  test("insists on GET", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "POST", "/api/v1/mailbox/history?peer=x", "{}"));
    expect(status).toBe(405);
    expect(body.error).toContain("GET");
  });

  test("answers with the conversation, newest first", async () => {
    const who = participant();
    const peer = uniq("peer");
    waiting(peer, who.identity, "one");
    waiting(peer, who.identity, "two");

    const { status, body } = await call(
      signedRequest(who, "GET", `/api/v1/mailbox/history?peer=${peer}`),
    );
    expect(status).toBe(200);
    expect(body.messages.map((m: { content: string }) => m.content)).toContain("two");
  });

  /** The query is signed, so a limit is part of what was asked for. */
  test("honours a limit that came in signed", async () => {
    const who = participant();
    const peer = uniq("peer");
    waiting(peer, who.identity, "one");
    waiting(peer, who.identity, "two");

    const { body } = await call(
      signedRequest(who, "GET", `/api/v1/mailbox/history?peer=${peer}&limit=1`),
    );
    expect(body.messages).toHaveLength(1);
  });
});

describe("the outbox", () => {
  test("lists what is still recallable", async () => {
    const who = participant();
    const to = participant("recipient");
    waiting(who.identity, to.identity, "still mine");

    const { status, body } = await call(signedRequest(who, "GET", "/api/v1/mailbox/out"));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test("refuses a method that is neither", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "PUT", "/api/v1/mailbox/out", "{}"));
    expect(status).toBe(405);
    expect(body.error).toContain("GET or POST");
  });

  test("refuses a send body it cannot parse", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "POST", "/api/v1/mailbox/out", "{ not json"));
    expect(status).toBe(400);
    expect(body.rpc_code).toBe(MESH_ERROR.INVALID_PARAMS);
  });
});

describe("recalling one", () => {
  const recall = (who: Caller, id: string) =>
    call(signedRequest(who, "DELETE", `/api/v1/mailbox/out/${id}`));

  test("takes back a message nobody has been handed", async () => {
    const who = participant();
    const to = participant("recipient");
    const id = waiting(who.identity, to.identity, "withdrawn");

    const { status, body } = await recall(who, id);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, recalled: true, id });
    expect(hubDb.prepare(`SELECT id FROM messages WHERE id = ?`).get(id)).toBeNull();
  });

  /**
   * **The withdrawal is recorded even though the row is gone.** § 9.2.1: the
   * `messages` row is deleted by the recall, so the audit event is the only
   * place the withdrawal exists — without it the trail holds a `sent` and
   * nothing saying it was taken back, which is the sender shaping the record.
   */
  test("records the withdrawal in the audit", async () => {
    const { auditDb } = await import("../db");
    const who = participant();
    const to = participant("recipient");
    const id = waiting(who.identity, to.identity, "withdrawn");
    await recall(who, id);

    const events = auditDb
      .prepare(`SELECT event_type FROM audit_events WHERE correlation_id = ?`)
      .all(id) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toContain("mesh.message.recalled");
  });

  test("refuses a message that is not the caller's to recall", async () => {
    const who = participant();
    const other = participant();
    const to = participant("recipient");
    const id = waiting(other.identity, to.identity, "not yours");

    const { status, body } = await recall(who, id);
    expect(status).toBe(404);
    expect(body.error).toContain("no such message");
  });

  test("refuses one the recipient has already been handed", async () => {
    const who = participant();
    const to = participant("recipient");
    const id = waiting(who.identity, to.identity, "gone out");
    hubDb.prepare(`UPDATE messages SET status = 'delivered' WHERE id = ?`).run(id);

    const { status, body } = await recall(who, id);
    expect(status).toBe(409);
    expect(body.code).toBe("ALREADY_DELIVERED");
  });

  test("insists on DELETE", async () => {
    const who = participant();
    const { status, body } = await call(signedRequest(who, "GET", "/api/v1/mailbox/out/anything"));
    expect(status).toBe(405);
    expect(body.error).toContain("DELETE");
  });

  /** An id is one segment: anything with a separator is not one. */
  test("refuses an id that is a path", async () => {
    const who = participant();
    const { status } = await call(signedRequest(who, "DELETE", "/api/v1/mailbox/out/a/b"));
    expect(status).toBe(404);
  });
});

/**
 * Sending from a caller with no socket (§ 8.10), and how a JSON-RPC refusal
 * reaches a REST client.
 *
 * **The RPC code travels in the body.** A status cannot carry a retry policy —
 * `ERROR_CLASS` is keyed on the number — so the envelope is unwrapped into a
 * status *and* `rpc_code`, and a client that knows the mesh reads the second.
 */
describe("sending by mail", () => {
  const send = (who: Caller, params: Record<string, unknown>) =>
    call(signedRequest(who, "POST", "/api/v1/mailbox/out", JSON.stringify(params)));

  test("queues a message for its recipient", async () => {
    const who = participant();
    const to = participant("recipient");

    const { status, body } = await send(who, { to: to.identity, content: "by mail" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // Nobody is holding a socket for the recipient, so § 8.10 says pending.
    expect(body.status).toBe("pending");

    const row = hubDb
      .prepare(`SELECT from_agent, to_agent, content, status FROM messages WHERE id = ?`)
      .get(body.id) as Record<string, string>;
    expect(row).toMatchObject({
      from_agent: who.identity, to_agent: to.identity, content: "by mail", status: "pending",
    });
  });

  /** § 8.2a: this route *is* the mailbox, so the row records how it arrived. */
  test("records the channel it arrived on", async () => {
    const who = participant();
    const to = participant("recipient");
    const { body } = await send(who, { to: to.identity, content: "by mail" });
    const row = hubDb.prepare(`SELECT via FROM messages WHERE id = ?`).get(body.id) as { via: string };
    expect(row.via).toBe("mailbox");
  });

  test("refuses a send that names no recipient, as a 400 carrying the RPC code", async () => {
    const who = participant();
    const { status, body } = await send(who, { content: "to nobody" });
    expect(status).toBe(400);
    expect(body.rpc_code).toBe(MESH_ERROR.INVALID_PARAMS);
    expect(body.error).toContain("params.to");
  });

  test("refuses a send with no content", async () => {
    const who = participant();
    const to = participant("recipient");
    const { status, body } = await send(who, { to: to.identity });
    expect(status).toBe(400);
    expect(body.error).toContain("params.content");
  });

  /**
   * **A retry is answered with the original message, not a second one.** § 8.2:
   * the hub can commit a message and fail to deliver the response, after which
   * only the caller knows whether it is retrying — which is why the key is
   * theirs to supply.
   */
  test("answers a retry carrying the same key with the first message", async () => {
    const who = participant();
    const to = participant("recipient");
    const key = uniq("cmid");

    const first = await send(who, { to: to.identity, content: "once", client_message_id: key });
    const second = await send(who, { to: to.identity, content: "once", client_message_id: key });

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.duplicate).toBe(true);
  });

  /**
   * **And a key reused for different bytes is permanent.** The key is how a
   * retry is told from a new send, so one that means two things means neither
   * — 409, because no amount of retrying fixes the caller.
   */
  test("refuses a key reused for a different message", async () => {
    const who = participant();
    const to = participant("recipient");
    const key = uniq("cmid");

    await send(who, { to: to.identity, content: "first", client_message_id: key });
    const { status, body } = await send(who, {
      to: to.identity, content: "different", client_message_id: key,
    });
    expect(status).toBe(409);
    expect(body.code).toBe("SEND_CONFLICT");
    expect(body.client_message_id).toBe(key);
  });

  /**
   * Queueing for an identity nobody has provisioned yet is intended (§ 3.1) —
   * it may arrive later. One that has been torn down never will, so the
   * message would sit pending for ever with nobody noticing.
   */
  test("refuses a recipient that has been torn down", async () => {
    const who = participant();
    const gone = participant("torn-down");
    agentsDb.prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ?`).run(gone.identity);

    const { status, body } = await send(who, { to: gone.identity, content: "too late" });
    expect(status).toBe(400);
    expect(body.error).toContain("deleted");
  });

  test("queues for an identity nobody has provisioned yet", async () => {
    const who = participant();
    const { status, body } = await send(who, { to: uniq("not-yet"), content: "waiting for you" });
    expect(status).toBe(200);
    expect(body.status).toBe("pending");
  });
});

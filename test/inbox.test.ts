/**
 * § 9.2.1 — the signed inbox surface.
 *
 * A REST naming of methods that already existed. What is worth testing is not
 * that the routes answer, but the three rules that make them different from the
 * standalone mailer they replace:
 *
 *   - taking delivery is a `POST`, because it leases and settles and audits
 *   - a sender may withdraw only what nobody has been handed
 *   - the listing is a hint and the `DELETE` is the judgement
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID, sign as edSign } from "node:crypto";

import { formatRestAuthorization, restSignaturePreimage } from "@agent-mesh/contracts";

import { loginAsAdmin, newKeyPair, provision, startMesh, type KeyPair, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
});
afterAll(() => mesh?.stop());

async function approve(fingerprint: string): Promise<void> {
  const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fingerprint }),
  });
  expect(res.status).toBe(200);
}

/** A signed REST call, built the way a client must build one. */
async function call(
  kp: KeyPair,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const nonce = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const bodySha256 = payload ? createHash("sha256").update(payload, "utf8").digest("hex") : "";
  const signature = Buffer.from(
    edSign(null, Buffer.from(restSignaturePreimage({
      method, path, kid: kp.fingerprint, nonce, iat, bodySha256,
    })), kp.privateKey),
  ).toString("base64url");

  const res = await fetch(`${mesh.hub.url}${path}`, {
    method,
    headers: {
      authorization: formatRestAuthorization({ kid: kp.fingerprint, nonce, iat, signature }),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: payload } : {}),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
async function pair(): Promise<{ a: KeyPair; b: KeyPair; ida: string; idb: string }> {
  const n = seq++;
  const a = newKeyPair(), b = newKeyPair();
  const ida = `ibx-a-${n}`, idb = `ibx-b-${n}`;
  await provision(mesh.hub, ida, "ai-claude", null, a.publicKey);
  await provision(mesh.hub, idb, "ai-claude", null, b.publicKey);
  await approve(a.fingerprint);
  await approve(b.fingerprint);
  return { a, b, ida, idb };
}

describe("capabilities", () => {
  test("is unsigned, because it matters most before a key is approved", async () => {
    // A client being set up needs the lease and dedup windows to size its retry
    // loop, and its key is `pending` until an operator acts. Gating this would
    // withhold them exactly when they are needed.
    const res = await fetch(`${mesh.hub.url}/api/v1/capabilities`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mailbox.receive_lease_seconds).toBeGreaterThan(0);
    expect(body.mailbox.send_dedup_window_seconds).toBeGreaterThan(0);
  });

  test("reports audit too, which socketless callers cannot get from connect", async () => {
    // § 8.9.1 advertises those caps in the `mesh.connect` result, and this
    // population never connects. Importing them as constants instead is the
    // drift that already happened here.
    const { AUDIT_CAPABILITY_DEFAULTS } = await import("@agent-mesh/contracts");
    const body = await (await fetch(`${mesh.hub.url}/api/v1/capabilities`)).json();
    expect(body.audit).toMatchObject(AUDIT_CAPABILITY_DEFAULTS);
  });

  test("keeps the three versions apart (§ 13)", async () => {
    const body = await (await fetch(`${mesh.hub.url}/api/v1/capabilities`)).json();
    for (const key of ["mailbox", "audit", "surface"]) {
      expect(typeof body[key].version, key).toBe("number");
    }
  });
});

describe("authentication", () => {
  test("an unapproved key is told which state it is in, and not whose it is", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "ibx-pending", "ai-claude", null, kp.publicKey);

    const res = await call(kp, "GET", "/api/v1/outbox");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "KEY_NOT_APPROVED", key_status: "pending" });
    // Naming the holder would build the key-to-identity lookup the contract
    // deliberately lacks.
    expect(JSON.stringify(res.body)).not.toContain("ibx-pending");
  });

  test("an unsigned request is refused", async () => {
    expect((await fetch(`${mesh.hub.url}/api/v1/outbox`)).status).toBe(401);
  });

  test("a nonce is spent on receipt, so a signature cannot be replayed", async () => {
    const { a } = await pair();
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(null, Buffer.from(restSignaturePreimage({
        method: "GET", path: "/api/v1/outbox", kid: a.fingerprint, nonce, iat, bodySha256: "",
      })), a.privateKey),
    ).toString("base64url");
    const header = formatRestAuthorization({ kid: a.fingerprint, nonce, iat, signature });

    expect((await fetch(`${mesh.hub.url}/api/v1/outbox`, { headers: { authorization: header } })).status).toBe(200);
    expect((await fetch(`${mesh.hub.url}/api/v1/outbox`, { headers: { authorization: header } })).status).toBe(401);
  });

  test("a signature does not carry to another path", async () => {
    // The preimage covers the path and its query, so an attacker able to
    // rewrite `?peer=` cannot redirect a history read.
    const { a, idb } = await pair();
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(null, Buffer.from(restSignaturePreimage({
        method: "GET", path: "/api/v1/outbox", kid: a.fingerprint, nonce, iat, bodySha256: "",
      })), a.privateKey),
    ).toString("base64url");

    const res = await fetch(`${mesh.hub.url}/api/v1/inbox/history?peer=${idb}`, {
      headers: { authorization: formatRestAuthorization({ kid: a.fingerprint, nonce: randomUUID(), iat, signature }) },
    });
    expect(res.status).toBe(401);
  });

  test("a tampered body is refused", async () => {
    const { a, idb } = await pair();
    const honest = JSON.stringify({ to: idb, content: "as signed" });
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(null, Buffer.from(restSignaturePreimage({
        method: "POST", path: "/api/v1/outbox", kid: a.fingerprint, nonce, iat,
        bodySha256: createHash("sha256").update(honest, "utf8").digest("hex"),
      })), a.privateKey),
    ).toString("base64url");

    const res = await fetch(`${mesh.hub.url}/api/v1/outbox`, {
      method: "POST",
      headers: {
        authorization: formatRestAuthorization({ kid: a.fingerprint, nonce, iat, signature }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: idb, content: "swapped after signing" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("delivery", () => {
  test("taking delivery leases, and a second call gets nothing until acked", async () => {
    const { a, b, idb } = await pair();
    await call(a, "POST", "/api/v1/outbox", { to: idb, content: "one" });

    const first = await call(b, "POST", "/api/v1/inbox", {});
    expect(first.body.messages).toHaveLength(1);
    expect(first.body.lease_seconds).toBeGreaterThan(0);

    const second = await call(b, "POST", "/api/v1/inbox", {});
    expect(second.body.messages).toHaveLength(0);

    const acked = await call(b, "POST", "/api/v1/inbox", {
      ack_ids: [first.body.messages[0].id], limit: 0,
    });
    expect(acked.body.remaining).toBe(0);
  });

  test("a GET cannot take delivery", async () => {
    // The whole reason this is a POST: a proxy, a retry or an operator with
    // `curl` must not be able to consume a lease by looking.
    const { b } = await pair();
    const res = await call(b, "GET", "/api/v1/inbox");
    expect(res.status).toBe(405);
  });

  test("history needs a peer", async () => {
    const { b } = await pair();
    expect((await call(b, "GET", "/api/v1/inbox/history")).status).toBe(400);
  });
});

describe("recall", () => {
  test("a message nobody has been handed can be withdrawn", async () => {
    const { a, idb } = await pair();
    const sent = await call(a, "POST", "/api/v1/outbox", { to: idb, content: "withdrawn" });
    expect(sent.status).toBe(200);

    const listed = await call(a, "GET", "/api/v1/outbox");
    expect(listed.body.messages.map((m: any) => m.id)).toContain(sent.body.id);
    // Size, not content: handing the body back would make this a second read
    // surface for something the caller already sent.
    expect(listed.body.messages[0]).not.toHaveProperty("content");

    const recalled = await call(a, "DELETE", `/api/v1/outbox/${sent.body.id}`);
    expect(recalled.body).toMatchObject({ recalled: true });

    const after = await call(a, "GET", "/api/v1/outbox");
    expect(after.body.messages.map((m: any) => m.id)).not.toContain(sent.body.id);
  });

  test("hand-over ends it, not acknowledgement", async () => {
    // A leased message was returned in a response — the recipient holds it
    // whether or not it survived to say so.
    const { a, b, idb } = await pair();
    const sent = await call(a, "POST", "/api/v1/outbox", { to: idb, content: "already handed over" });
    const received = await call(b, "POST", "/api/v1/inbox", {});
    expect(received.body.messages).toHaveLength(1);

    // Leased, deliberately not acked.
    const late = await call(a, "DELETE", `/api/v1/outbox/${sent.body.id}`);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("ALREADY_DELIVERED");

    const listed = await call(a, "GET", "/api/v1/outbox");
    expect(listed.body.messages.map((m: any) => m.id)).not.toContain(sent.body.id);
  });

  test("a sender cannot recall someone else's message", async () => {
    const first = await pair();
    const second = await pair();
    const sent = await call(first.a, "POST", "/api/v1/outbox", { to: first.idb, content: "not yours" });

    const res = await call(second.a, "DELETE", `/api/v1/outbox/${sent.body.id}`);
    // `404`, not `409`: telling a stranger the message exists would let this
    // enumerate the mesh.
    expect(res.status).toBe(404);

    const still = await call(first.a, "GET", "/api/v1/outbox");
    expect(still.body.messages.map((m: any) => m.id)).toContain(sent.body.id);
  });

  test("the withdrawal is audited, or the trail says only that it was sent", async () => {
    const { a, ida, idb } = await pair();
    const sent = await call(a, "POST", "/api/v1/outbox", { to: idb, content: "audited withdrawal" });
    await call(a, "DELETE", `/api/v1/outbox/${sent.body.id}`);

    const events = await (await fetch(
      `${mesh.http.url}/api/v1/audit/events?identity=${ida}`, { headers: { cookie } },
    )).json();
    const types = (events.events ?? []).map((e: any) => e.event_type);
    expect(types).toContain("mesh.message.sent");
    expect(types).toContain("mesh.message.recalled");
  });
});

describe("the operator surface", () => {
  test("needs an admin, and reads without bodies", async () => {
    const { a, idb } = await pair();
    await call(a, "POST", "/api/v1/outbox", { to: idb, content: "operator must not read this" });

    expect((await fetch(`${mesh.http.url}/api/v1/admin/inbox`)).status).toBe(401);

    const depth = await (await fetch(`${mesh.http.url}/api/v1/admin/inbox`, { headers: { cookie } })).json();
    expect(depth.inboxes.some((i: any) => i.identity === idb)).toBe(true);

    const one = await (await fetch(`${mesh.http.url}/api/v1/admin/inbox/${idb}`, { headers: { cookie } })).json();
    expect(one.messages.length).toBeGreaterThan(0);
    // Seeing that someone has mail is a different authorisation question from
    // reading it.
    expect(JSON.stringify(one)).not.toContain("operator must not read this");
  });

  test("reports whether a message is leased, so a stuck queue is legible", async () => {
    const { a, b, idb } = await pair();
    await call(a, "POST", "/api/v1/outbox", { to: idb, content: "held" });
    await call(b, "POST", "/api/v1/inbox", {});

    const one = await (await fetch(`${mesh.http.url}/api/v1/admin/inbox/${idb}`, { headers: { cookie } })).json();
    expect(one.messages[0].leased).toBe(true);
  });
});

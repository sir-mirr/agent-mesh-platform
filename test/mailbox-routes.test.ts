/**
 * § 9.2.1 — the signed mailbox surface.
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

async function approve(fingerprint: string, m: Mesh = mesh, c: string = cookie): Promise<void> {
  const res = await fetch(`${m.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: c },
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
  // Defaulted, so every existing call site is untouched. One test needs its own
  // mesh, because the lease has to be short enough to lapse.
  m: Mesh = mesh,
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

  const res = await fetch(`${m.hub.url}${path}`, {
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
async function pair(m: Mesh = mesh, c: string = cookie): Promise<{ a: KeyPair; b: KeyPair; ida: string; idb: string }> {
  const n = seq++;
  const a = newKeyPair(), b = newKeyPair();
  const ida = `ibx-a-${n}`, idb = `ibx-b-${n}`;
  await provision(m.hub, ida, "ai-claude", null, a.publicKey);
  await provision(m.hub, idb, "ai-claude", null, b.publicKey);
  await approve(a.fingerprint, m, c);
  await approve(b.fingerprint, m, c);
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

  test("surface.version moves when the route table does, so absence is never the signal", async () => {
    // § 9.2. `/keys` gained `type` at surface 2. A client gating on the field's
    // presence instead cannot separate "this hub is too old" from "this
    // identity has no type", because `mesh.register` never wrote one — and the
    // case it guesses wrong is the one where it silently stops checking.
    //
    // Read from contracts rather than restated: a literal here would be a
    // second declaration, and the two only have to disagree once.
    const { SURFACE_CAPABILITY_DEFAULTS } = await import("@agent-mesh/contracts");
    const body = await (await fetch(`${mesh.hub.url}/api/v1/capabilities`)).json();
    expect(body.surface.version).toBe(SURFACE_CAPABILITY_DEFAULTS.version);
    expect(body.surface.version).toBeGreaterThanOrEqual(2);
  });

  test("and the route it versions actually answers", async () => {
    // The pair that makes the version mean something. A hub reporting surface
    // 2 while `/keys` omits `type` would be worse than one reporting 1.
    await provision(mesh.hub, "ibx-surface-2", "ai-claude");
    const body = await (await fetch(`${mesh.hub.url}/api/v1/agents/ibx-surface-2/keys`)).json();
    expect(body.type).toBe("ai-claude");
  });
});

describe("authentication", () => {
  test("an unapproved key is told which state it is in, and not whose it is", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "ibx-pending", "ai-claude", null, kp.publicKey);

    const res = await call(kp, "GET", "/api/v1/mailbox/out");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "KEY_NOT_APPROVED", key_status: "pending" });
    // Naming the holder would build the key-to-identity lookup the contract
    // deliberately lacks.
    expect(JSON.stringify(res.body)).not.toContain("ibx-pending");
  });

  test("an unsigned request is refused", async () => {
    expect((await fetch(`${mesh.hub.url}/api/v1/mailbox/out`)).status).toBe(401);
  });

  test("a nonce is spent on receipt, so a signature cannot be replayed", async () => {
    const { a } = await pair();
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(null, Buffer.from(restSignaturePreimage({
        method: "GET", path: "/api/v1/mailbox/out", kid: a.fingerprint, nonce, iat, bodySha256: "",
      })), a.privateKey),
    ).toString("base64url");
    const header = formatRestAuthorization({ kid: a.fingerprint, nonce, iat, signature });

    expect((await fetch(`${mesh.hub.url}/api/v1/mailbox/out`, { headers: { authorization: header } })).status).toBe(200);
    expect((await fetch(`${mesh.hub.url}/api/v1/mailbox/out`, { headers: { authorization: header } })).status).toBe(401);
  });

  test("a signature does not carry to another path", async () => {
    // The preimage covers the path and its query, so an attacker able to
    // rewrite `?peer=` cannot redirect a history read.
    const { a, idb } = await pair();
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const signature = Buffer.from(
      edSign(null, Buffer.from(restSignaturePreimage({
        method: "GET", path: "/api/v1/mailbox/out", kid: a.fingerprint, nonce, iat, bodySha256: "",
      })), a.privateKey),
    ).toString("base64url");

    const res = await fetch(`${mesh.hub.url}/api/v1/mailbox/history?peer=${idb}`, {
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
        method: "POST", path: "/api/v1/mailbox/out", kid: a.fingerprint, nonce, iat,
        bodySha256: createHash("sha256").update(honest, "utf8").digest("hex"),
      })), a.privateKey),
    ).toString("base64url");

    const res = await fetch(`${mesh.hub.url}/api/v1/mailbox/out`, {
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
    await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: "one" });

    const first = await call(b, "POST", "/api/v1/mailbox/in", {});
    expect(first.body.messages).toHaveLength(1);
    expect(first.body.lease_seconds).toBeGreaterThan(0);

    const second = await call(b, "POST", "/api/v1/mailbox/in", {});
    expect(second.body.messages).toHaveLength(0);

    // **`remaining` cannot see the acknowledgement, and was read as if it
    // could.** It counts leasable rows only, and this mesh leases for the
    // 300-second default — so the message is uncounted whether the ack settled
    // it, ignored it, or the ack path were deleted. Removing `ack_ids` from the
    // call below left this test green; the assertion below it is what the call
    // actually establishes.
    //
    // The lease half above is real and stays: a second call gets nothing while
    // the first caller still holds the batch.
    const acked = await call(b, "POST", "/api/v1/mailbox/in", {
      ack_ids: [first.body.messages[0].id], limit: 0,
    });
    expect(acked.status, "the acknowledgement was refused").toBe(200);
  });

  test("and once acked it does not come back after the lease lapses", async () => {
    // The half the test above cannot observe, on its own mesh because the lease
    // has to be short enough to lapse. Without the ack the batch returns — that
    // is the whole point of a lease — so an empty read here is the
    // acknowledgement having settled it, over this REST route rather than the
    // signed RPC one that `test/mailbox.test.ts` covers.
    const short = await startMesh({ env: { AGENT_MESH_RECEIVE_LEASE_SECONDS: "1" } });
    try {
      const shortCookie = await loginAsAdmin(short.http);
      const p = await pair(short, shortCookie);
      await call(p.a, "POST", "/api/v1/mailbox/out", { to: p.idb, content: "settle me" }, short);

      const took = await call(p.b, "POST", "/api/v1/mailbox/in", {}, short);
      expect(took.body.messages).toHaveLength(1);

      await call(p.b, "POST", "/api/v1/mailbox/in", {
        ack_ids: [took.body.messages[0].id], limit: 0,
      }, short);

      await Bun.sleep(2100);
      const after = await call(p.b, "POST", "/api/v1/mailbox/in", {}, short);
      expect(after.body.messages, "an acknowledged message came back after the lease").toHaveLength(0);
    } finally {
      short.stop();
    }
  }, 60_000);

  test("a GET cannot take delivery", async () => {
    // The whole reason this is a POST: a proxy, a retry or an operator with
    // `curl` must not be able to consume a lease by looking.
    const { b } = await pair();
    const res = await call(b, "GET", "/api/v1/mailbox/in");
    expect(res.status).toBe(405);
  });

  test("history needs a peer", async () => {
    const { b } = await pair();
    expect((await call(b, "GET", "/api/v1/mailbox/history")).status).toBe(400);
  });
});

describe("recall", () => {
  test("a message nobody has been handed can be withdrawn", async () => {
    const { a, idb } = await pair();
    const sent = await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: "withdrawn" });
    expect(sent.status).toBe(200);

    const listed = await call(a, "GET", "/api/v1/mailbox/out");
    expect(listed.body.messages.map((m: any) => m.id)).toContain(sent.body.id);
    // Size, not content: handing the body back would make this a second read
    // surface for something the caller already sent.
    expect(listed.body.messages[0]).not.toHaveProperty("content");

    const recalled = await call(a, "DELETE", `/api/v1/mailbox/out/${sent.body.id}`);
    expect(recalled.body).toMatchObject({ recalled: true });

    const after = await call(a, "GET", "/api/v1/mailbox/out");
    expect(after.body.messages.map((m: any) => m.id)).not.toContain(sent.body.id);
  });

  test("hand-over ends it, not acknowledgement", async () => {
    // A leased message was returned in a response — the recipient holds it
    // whether or not it survived to say so.
    const { a, b, idb } = await pair();
    const sent = await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: "already handed over" });
    const received = await call(b, "POST", "/api/v1/mailbox/in", {});
    expect(received.body.messages).toHaveLength(1);

    // Leased, deliberately not acked.
    const late = await call(a, "DELETE", `/api/v1/mailbox/out/${sent.body.id}`);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("ALREADY_DELIVERED");

    const listed = await call(a, "GET", "/api/v1/mailbox/out");
    expect(listed.body.messages.map((m: any) => m.id)).not.toContain(sent.body.id);
  });

  test("a sender cannot recall someone else's message", async () => {
    const first = await pair();
    const second = await pair();
    const sent = await call(first.a, "POST", "/api/v1/mailbox/out", { to: first.idb, content: "not yours" });

    const res = await call(second.a, "DELETE", `/api/v1/mailbox/out/${sent.body.id}`);
    // `404`, not `409`: telling a stranger the message exists would let this
    // enumerate the mesh.
    expect(res.status).toBe(404);

    const still = await call(first.a, "GET", "/api/v1/mailbox/out");
    expect(still.body.messages.map((m: any) => m.id)).toContain(sent.body.id);
  });

  test("the withdrawal is audited, or the trail says only that it was sent", async () => {
    const { a, ida, idb } = await pair();
    const sent = await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: "audited withdrawal" });
    await call(a, "DELETE", `/api/v1/mailbox/out/${sent.body.id}`);

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
    await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: "operator must not read this" });

    expect((await fetch(`${mesh.http.url}/api/v1/admin/mailbox`)).status).toBe(401);

    const depth = await (await fetch(`${mesh.http.url}/api/v1/admin/mailbox`, { headers: { cookie } })).json();
    expect(depth.mailboxes.some((i: any) => i.identity === idb)).toBe(true);

    const one = await (await fetch(`${mesh.http.url}/api/v1/admin/mailbox/${idb}`, { headers: { cookie } })).json();
    expect(one.messages.length).toBeGreaterThan(0);
    // Seeing that someone has mail is a different authorisation question from
    // reading it.
    expect(JSON.stringify(one)).not.toContain("operator must not read this");
  });

  test("counts the queue itself, and names its columns", async () => {
    // The console read `m.depth` and summed it. No route has ever emitted
    // `depth`, so the sum was `0` for an idle mesh and `0` for a backed-up one,
    // and a dashboard tile showed the same calm number either way.
    const { a, idb } = await pair();
    for (const n of [1, 2, 3]) {
      await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: `queued ${n}` });
    }

    const body = await (await fetch(`${mesh.http.url}/api/v1/admin/mailbox`, { headers: { cookie } })).json();
    const row = body.mailboxes.find((i: any) => i.identity === idb);

    expect(row, "the identity with three queued messages is missing from the listing").toBeDefined();
    expect(row.pending).toBe(3);
    expect(body.total_queued, "the route counts the queue so the caller does not have to").toBeGreaterThanOrEqual(3);

    // The columns by name. A reader that guesses one gets `undefined`, which
    // arithmetic turns into a number rather than an error.
    expect(Object.keys(row).sort()).toEqual(["identity", "leased", "oldest", "pending"]);
  });

  test("reports whether a message is leased, so a stuck queue is legible", async () => {
    const { a, b, idb } = await pair();
    await call(a, "POST", "/api/v1/mailbox/out", { to: idb, content: "held" });
    await call(b, "POST", "/api/v1/mailbox/in", {});

    const one = await (await fetch(`${mesh.http.url}/api/v1/admin/mailbox/${idb}`, { headers: { cookie } })).json();
    expect(one.messages[0].leased).toBe(true);
  });
});

/**
 * Step 7 — audit ingestion (SPEC § 8.9).
 *
 * Two things carry the weight. An event and its attachment references commit
 * together or not at all — a half-written record is worse than a missing one,
 * because it looks complete. And four members are the hub's to construct, not
 * the client's to assert: a field the client supplies cannot attest to the
 * client.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, sign as edSign } from "node:crypto";
import { join } from "node:path";

import {
  AUDIT_CAPABILITY_DEFAULTS, AUDIT_SCHEMA_VERSION,
  formatUploadAuthorization, uploadSignaturePreimage,
} from "@agent-mesh/contracts";

import { connectRpc, loginAsAdmin, newKeyPair, openTestDb, provision, SEED_ADMIN, startMesh, type KeyPair, type Mesh, type RpcClient } from "./harness";

let mesh: Mesh;
let kp: KeyPair;
let rpc: RpcClient;
let adminCookie: string;
const IDENTITY = "audit-agent";

beforeAll(async () => {
  mesh = await startMesh();
  const cookie = await loginAsAdmin(mesh.http);
  adminCookie = cookie;
  kp = newKeyPair();
  await provision(mesh.hub, IDENTITY, "ai-codex", null, kp.publicKey);
  await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fingerprint: kp.fingerprint }),
  });
  await provision(mesh.hub, "audit-peer", "service");
  rpc = await connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey });
  await rpc.call("mesh.connect", { identity: IDENTITY });
});

afterAll(() => {
  rpc?.close();
  mesh?.stop();
});

const auditDb = () => openTestDb(join(mesh.stateDir, "audit.db"), { readonly: true });

const event = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  // Time-ordered, as § 8.9.3 requires of every producer. A random id makes the
  // cursor's tie-break random too — `stored_at` is millisecond precision, so
  // events collide on it under any load — and the test would then be checking
  // pagination against a client that breaks the contract pagination rests on.
  event_id: `evt_${Bun.randomUUIDv7()}`,
  event_type: "channel.message.received",
  occurred_at: new Date().toISOString(),
  ...over,
});

const rows = (sql: string, ...args: unknown[]) => {
  const db = auditDb();
  const r = db.prepare(sql).all(...(args as any[]));
  db.close();
  return r as any[];
};

describe("capabilities", () => {
  test("connect advertises what the audit surface accepts", async () => {
    // Its own identity: an incumbent socket is never evicted by a contender
    // (§ 8.1), so reconnecting as IDENTITY here would get -32010 instead.
    const other = newKeyPair();
    await provision(mesh.hub, "audit-capabilities", "ai-codex", null, other.publicKey);
    const cookie = await loginAsAdmin(mesh.http);
    await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fingerprint: other.fingerprint }),
    });

    const fresh = await connectRpc(mesh.hub, { kid: other.fingerprint, privateKey: other.privateKey });
    const res = await fresh.call("mesh.connect", { identity: "audit-capabilities" });
    fresh.close();
    const audit = res.result.capabilities.audit;

    // Every field § 8.9.1 requires, with the contract's values. The hub
    // previously advertised its own shape and its own numbers: `version` was
    // missing entirely, and since a client MUST NOT guess an unrecognised
    // version, the advertisement it received made audit refuse to start. The
    // whole surface was gated on a field nobody had noticed was absent.
    expect(audit).toMatchObject(AUDIT_CAPABILITY_DEFAULTS);

    // Additive, and distinct from `version`. That one is the protocol —
    // methods, params, errors; this is the highest event schema. They move for
    // different reasons, and a client keying off the wrong one would gate the
    // audit surface on an unrelated change.
    expect(audit.schema_version_max).toBe(AUDIT_SCHEMA_VERSION);
    // Absent on a 0.1 hub, which is how a client detects one rather than
    // discovering it by having an append refused.
    expect(audit.version).toBe(1);
  });
});

describe("append", () => {
  test("commits an event and reports what the hub derived", async () => {
    const e = event();
    const res = await rpc.call("mesh.audit.append", e);
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      ok: true, committed: true, duplicate: false, event_id: e.event_id,
      identity: IDENTITY, attachments_verified: 0,
    });

    const [row] = rows(`SELECT * FROM audit_events WHERE event_id = ?`, e.event_id);
    expect(row.identity).toBe(IDENTITY);
    expect(row.recorded_by_kind).toBe("adapter");
    // The attestation is the request signature that authenticated the append.
    expect(JSON.parse(row.attestation).sig.alg).toBe("ed25519");
  });

  test("the trust metadata is the hub's, whatever the client sends", async () => {
    // § 8.9.3: identity, recorded_by, attestation and payload_digest are not
    // request members. A client that sends them has them ignored — honouring
    // them would let the record attest to whatever the client preferred.
    const e = event({
      identity: "somebody-else",
      recorded_by: { kind: "hub" },
      payload_digest: "0".repeat(64),
      attestation: { forged: true },
    });
    const res = await rpc.call("mesh.audit.append", e);
    expect(res.result.identity).toBe(IDENTITY);

    const [row] = rows(`SELECT * FROM audit_events WHERE event_id = ?`, e.event_id);
    expect(row.identity).toBe(IDENTITY);
    expect(row.recorded_by_kind).toBe("adapter");
    expect(row.payload_digest).not.toBe("0".repeat(64));
    expect(JSON.parse(row.attestation).forged).toBeUndefined();
  });

  test("the digest is over the received bytes", async () => {
    const e = event();
    await rpc.call("mesh.audit.append", e);
    const [row] = rows(`SELECT payload, payload_digest FROM audit_events WHERE event_id = ?`, e.event_id);
    expect(createHash("sha256").update(row.payload, "utf8").digest("hex")).toBe(row.payload_digest);
  });

  test("a repeat with identical bytes is success, not a second row", async () => {
    const e = event();
    const first = await rpc.call("mesh.audit.append", e);
    const second = await rpc.call("mesh.audit.append", e);
    // The client did not hear the ACK and retried. Its outbox is doing the
    // right thing and must not be punished for it.
    expect(second.result).toMatchObject({ duplicate: true, event_id: e.event_id });
    expect(second.result.stored_at).toBe(first.result.stored_at);
    expect(rows(`SELECT event_id FROM audit_events WHERE event_id = ?`, e.event_id)).toHaveLength(1);
  });

  test("a repeat with different bytes is permanent, not transient", async () => {
    const e = event();
    await rpc.call("mesh.audit.append", e);
    const res = await rpc.call("mesh.audit.append", { ...e, event_type: "channel.message.sent" });
    // -32041 is permanent: retrying cannot fix a client that reused an id, and
    // a client that retried it would do so forever.
    expect(res.error).toMatchObject({ code: -32041 });
  });

  test("a schema_version the hub cannot validate is refused", async () => {
    const res = await rpc.call("mesh.audit.append", event({ schema_version: 99 }));
    expect(res.error).toMatchObject({ code: -32602 });
    // Nothing is lost: the outbox retries and drains after the hub is upgraded.
    // Storing it would record "validated" as a falsehood.
    expect(res.error.message).toContain("newer than this hub understands");
  });

  test("missing required members are refused before anything is stored", async () => {
    for (const bad of [{ event_id: undefined }, { event_type: undefined }, { occurred_at: undefined }]) {
      const res = await rpc.call("mesh.audit.append", { ...event(), ...bad });
      expect(res.error).toMatchObject({ code: -32602 });
    }
  });
});

describe("attachments", () => {
  const sha = (b: Uint8Array) => createHash("sha256").update(Buffer.from(b)).digest("hex");

  async function upload(bytes: Uint8Array, name: string) {
    const prep = await rpc.call("mesh.audit.prepare_blobs", {
      event_id: "prep", blobs: [{ sha256: sha(bytes), size: bytes.length, name }],
    });
    const b = prep.result.blobs[0];
    if (b.status === "present") return b;
    const signature = Buffer.from(
      edSign(null, Buffer.from(uploadSignaturePreimage({
        nonce: b.upload.nonce, blobKey: b.blob_key, sha256: sha(bytes), size: bytes.length,
      })), kp.privateKey),
    ).toString("base64url");
    await fetch(`${mesh.http.url}/api/v1/audit/blobs/${b.blob_key}`, {
      method: "PUT",
      body: bytes.slice().buffer as ArrayBuffer,
      headers: {
        authorization: formatUploadAuthorization({ kid: kp.fingerprint, nonce: b.upload.nonce, signature }),
      },
    });
    return b;
  }

  test("an event referencing an uploaded blob commits both together", async () => {
    const bytes = new TextEncoder().encode("attachment bytes");
    await upload(bytes, "att.txt");

    const e = event({ attachments: [{ sha256: sha(bytes), size: bytes.length, name: "att.txt" }] });
    const res = await rpc.call("mesh.audit.append", e);
    expect(res.result.attachments_verified).toBe(1);

    const refs = rows(`SELECT * FROM audit_event_blobs WHERE event_id = ?`, e.event_id);
    expect(refs).toHaveLength(1);
    expect(refs[0].sha256).toBe(sha(bytes));
  });

  test("a missing blob is transient and commits nothing", async () => {
    const absent = "f".repeat(64);
    const e = event({ attachments: [{ sha256: absent, size: 10, name: "ghost.bin" }] });
    const res = await rpc.call("mesh.audit.append", e);

    expect(res.error).toMatchObject({ code: -32040 });
    expect(res.error.data.missing_sha256).toContain(absent);
    // Nothing partial: the client uploads and retries, and the retry is a fresh
    // attempt rather than a repair of half a record.
    expect(rows(`SELECT event_id FROM audit_events WHERE event_id = ?`, e.event_id)).toHaveLength(0);
    expect(rows(`SELECT event_id FROM audit_event_blobs WHERE event_id = ?`, e.event_id)).toHaveLength(0);
  });

  test("a blob of the wrong size is treated as missing", async () => {
    // What an interrupted upload leaves. Accepting it would let the event
    // reference truncated bytes as verified.
    const bytes = new TextEncoder().encode("right name wrong size");
    await upload(bytes, "size.bin");
    const e = event({ attachments: [{ sha256: sha(bytes), size: bytes.length + 1, name: "size.bin" }] });
    const res = await rpc.call("mesh.audit.append", e);
    expect(res.error).toMatchObject({ code: -32040 });
  });
});

describe("hub-produced events (§ 8.9.4)", () => {
  test("routing a message records the hub's own observation", async () => {
    const sent = await rpc.call("mesh.send", { to: "audit-peer", content: "audited" });
    expect(sent.error).toBeUndefined();

    // Two hub events per send now: that it was accepted, and where it went.
    const [row] = rows(
      `SELECT * FROM audit_events
        WHERE correlation_id = ? AND recorded_by_kind = 'hub' AND event_type = 'mesh.message.pending'`,
      sent.result.id,
    );
    expect(row).toBeTruthy();
    expect(row.identity).toBe(IDENTITY);

    // The point of § 8.9.4: the hub's observation carries the *sender's* own
    // signature, which is what makes a mesh event stronger evidence than an
    // adapter's report of its own activity.
    const attestation = JSON.parse(row.attestation);
    expect(attestation.covers).toBe("mesh.send.params");
    expect(attestation.sig.alg).toBe("ed25519");
    // The params bytes are kept verbatim so the signature stays verifiable.
    expect(JSON.parse(attestation.params).to).toBe("audit-peer");
  });

  test("the event carries the body rather than pointing at messages", async () => {
    // So that rotating the message table does not hollow out the record of what
    // was sent — audit retention and operational retention stay independent.
    const sent = await rpc.call("mesh.send", { to: "audit-peer", content: "body carried" });
    const [row] = rows(
      `SELECT payload FROM audit_events
        WHERE correlation_id = ? AND recorded_by_kind = 'hub' AND event_type = 'mesh.message.sent'`,
      sent.result.id,
    );
    expect(JSON.parse(row.payload).message.content).toBe("body carried");
  });

  test("a send always records that it was accepted, whatever happens next", async () => {
    // `sent` was in § 8.9.4's list and never emitted. It is the only record that
    // survives when delivery never occurs — recording just the outcome left no
    // evidence a send had been accepted at all.
    const sent = await rpc.call("mesh.send", { to: "audit-peer", content: "accepted" });
    const types = rows(
      `SELECT event_type FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    ).map((r: any) => r.event_type);
    expect(types).toContain("mesh.message.sent");
  });

  test("a queued message records delivery when it finally lands", async () => {
    // The trail said `pending` and would have said so for ever, however long
    // ago the message arrived. An audit of delivery that cannot say whether
    // something was delivered is not one.
    await provision(mesh.hub, "late-peer", "service");
    const sent = await rpc.call("mesh.send", { to: "late-peer", content: "queued then landed" });
    expect(sent.result.status).toBe("pending");

    const before = rows(
      `SELECT event_type FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    ).map((r: any) => r.event_type);
    expect(before).toContain("mesh.message.pending");
    expect(before).not.toContain("mesh.message.delivered");

    const late = await connectRpc(mesh.hub);
    await late.call("mesh.connect", { identity: "late-peer" });
    await Bun.sleep(200);
    late.close();

    const after = rows(
      `SELECT event_type FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    ).map((r: any) => r.event_type);
    expect(after).toContain("mesh.message.delivered");
  });

  test("delivered and pending are distinguished", async () => {
    const listener = await connectRpc(mesh.hub);
    await listener.call("mesh.connect", { identity: "audit-peer" });
    const sent = await rpc.call("mesh.send", { to: "audit-peer", content: "live" });
    listener.close();

    const types = rows(
      `SELECT event_type FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    ).map((r: any) => r.event_type);
    // The outcome event states what happened, not what was attempted — and
    // sits alongside the `sent` record rather than replacing it.
    expect(types).toContain("mesh.message.delivered");
    expect(types).not.toContain("mesh.message.pending");
    expect(types).toContain("mesh.message.sent");
  });
});

describe("storage", () => {
  test("events and their references share one file", () => {
    // SQLite does not guarantee atomic commit across attached databases in WAL
    // mode, so splitting these would leave a window where an event exists
    // without its references, or the reverse.
    const db = auditDb();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[])
      .map((t) => t.name);
    db.close();
    expect(names).toContain("audit_events");
    expect(names).toContain("audit_event_blobs");
  });
});

/**
 * Step 8 — the audit query API (SPEC § 9.1).
 *
 * The assertion that matters is stability: a cursor must not skip or repeat a
 * row because something was appended mid-page. That is the failure an offset
 * would produce, and it is silent — the reader gets a plausible page and never
 * learns what it missed.
 */
describe("query API", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await loginAsAdmin(mesh.http);
  });

  const query = (path: string, withCookie = true) =>
    fetch(`${mesh.http.url}/api/v1/audit/events${path}`, {
      headers: withCookie ? { cookie } : {},
    });

  test("requires an admin session", async () => {
    // A lane's signing key authorises writing its own events and says nothing
    // about reading anyone else's, so this gate is a different one.
    expect((await query("", false)).status).toBe(401);
  });

  test("returns one event by id, with its attestation", async () => {
    const e = event({ event_type: "channel.message.sent" });
    await rpc.call("mesh.audit.append", e);

    const res = await query(`/${e.event_id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event.event_id).toBe(e.event_id);
    expect(body.event.identity).toBe(IDENTITY);
    // Returned so a reader can check the signature themselves — a record
    // nobody can verify is a log.
    expect(body.event.attestation.sig.alg).toBe("ed25519");
    expect((await query("/evt_nonexistent")).status).toBe(404);
  });

  test("pages in a stable order, and appending mid-page changes nothing seen", async () => {
    const marker = `corr-${Math.random().toString(36).slice(2)}`;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = event({ correlation_id: marker });
      await rpc.call("mesh.audit.append", e);
      ids.push(e.event_id);
    }

    const first = await (await query(`?correlation_id=${marker}&limit=3`)).json();
    expect(first.events).toHaveLength(3);
    expect(first.next_cursor).toBeTruthy();

    // Two more land between the pages. Ascending order puts them after the
    // cursor, where the reader reaches them in turn — a descending-from-now
    // cursor would have shifted every offset instead.
    const late: string[] = [];
    for (let i = 0; i < 2; i++) {
      const e = event({ correlation_id: marker });
      await rpc.call("mesh.audit.append", e);
      late.push(e.event_id);
    }

    const second = await (await query(
      `?correlation_id=${marker}&limit=3&cursor=${encodeURIComponent(first.next_cursor)}`,
    )).json();

    const seen = [...first.events, ...second.events].map((e: any) => e.event_id);
    expect(new Set(seen).size).toBe(seen.length);          // nothing repeated
    for (const id of ids.slice(0, 6)) expect(seen).toContain(id); // nothing skipped
  });

  test("filters by identity and correlation id", async () => {
    const marker = `filter-${Math.random().toString(36).slice(2)}`;
    const e = event({ correlation_id: marker });
    await rpc.call("mesh.audit.append", e);

    const byCorr = await (await query(`?correlation_id=${marker}`)).json();
    expect(byCorr.events.map((x: any) => x.event_id)).toEqual([e.event_id]);

    const byOther = await (await query(`?identity=nobody`)).json();
    expect(byOther.events).toHaveLength(0);
  });

  test("never returns secrets, however they were stored", async () => {
    // The payload is stored verbatim so its digest stays checkable, which means
    // the store holds whatever a client put there. Redaction is therefore on
    // the way out — redacting on the way in would break the digest and with it
    // the attestation.
    const e = event({
      authorization: "Bearer real-token",
      nested: { api_key: "sk-live-secret", reasoning: "internal chain of thought" },
      keep: "ordinary field",
    });
    await rpc.call("mesh.audit.append", e);

    const body = await (await query(`/${e.event_id}`)).json();
    expect(body.event.payload.authorization).toBe("[redacted]");
    expect(body.event.payload.nested.api_key).toBe("[redacted]");
    expect(body.event.payload.nested.reasoning).toBe("[redacted]");
    expect(body.event.payload.keep).toBe("ordinary field");
    // Redaction must not have touched what the digest was taken over.
    expect(body.event.payload_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a malformed cursor is refused rather than ignored", async () => {
    // Ignoring it would silently return page one to a reader who believes they
    // are on page four.
    expect((await query("?cursor=garbage")).status).toBe(400);
  });
});

/**
 * SPEC § 11. The platform operator reads the trail and not the messages in it.
 *
 * This is **redaction on the way out**, not a separate store: the process
 * still reads the bytes and chooses what to hand back. The structural version
 * — bodies in their own table, so the query never touches them — is in
 * `docs/proposals/operator-roles.md` and is not what these tests cover. The
 * distinction is worth keeping straight, because the weaker mechanism is easy
 * to describe as the stronger one.
 */
describe("§ 11 — content is a separate grant from metadata", () => {
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    try { return fn(db); } finally { db.close(); }
  };
  const setContentGrant = (on: boolean) =>
    withDb((db) => on
      ? db.prepare(`INSERT INTO role_grants (tenant,subject,capability,scope,granted_by)
                    VALUES ('default','platform-admin','audit.read.content','*','test')
                    ON CONFLICT DO NOTHING`).run()
      : db.prepare(`DELETE FROM role_grants WHERE subject='platform-admin' AND capability='audit.read.content'`).run());

  const events = async () =>
    (await (await fetch(`${mesh.http.url}/api/v1/audit/events?limit=50`, {
      headers: { cookie: adminCookie },
    })).json()).events as Array<{ payload: any }>;

  test("with the grant, bodies are there", async () => {
    setContentGrant(true);
    const withBody = (await events()).filter((e) => typeof e.payload?.message?.content === "string");
    expect(withBody.length).toBeGreaterThan(0);
    expect(withBody[0]!.payload.message.content).not.toContain("withheld");
  });

  test("without it, the metadata survives and the body does not", async () => {
    setContentGrant(false);
    const rows = await events();
    expect(rows.length).toBeGreaterThan(0);

    for (const e of rows) {
      const msg = e.payload?.message;
      if (!msg || typeof msg.content !== "string") continue;
      expect(msg.content).toContain("requires audit.read.content");
      // What an operator actually needs to run a mesh is still there. This is
      // the same line `admin/mailbox` draws: seeing that someone has mail is a
      // different question from reading it.
      expect(typeof msg.from).toBe("string");
      expect(typeof msg.to).toBe("string");
      expect(typeof msg.id).toBe("string");
      // Length is metadata, not content, and it is what diagnosing a stuck
      // queue needs.
      expect(typeof msg.content_length).toBe("number");
    }
    setContentGrant(true);
  });

  test("a single event is gated the same way as the list", async () => {
    // Two routes, one boundary. A gate applied to the list and forgotten on
    // the by-id route is the shape this kind of bug takes.
    setContentGrant(false);
    const rows = await events();
    const target = rows.find((e: any) => typeof e.payload?.message?.content === "string") as any;
    expect(target).toBeTruthy();
    const one = await (await fetch(`${mesh.http.url}/api/v1/audit/events/${target.event_id}`, {
      headers: { cookie: adminCookie },
    })).json();
    expect(one.event.payload.message.content).toContain("requires audit.read.content");
    setContentGrant(true);
  });
});

/**
 * SPEC § 11.0.1. A content read is recorded, and fails closed.
 *
 * The recording is what makes a tenant admin sitting *inside* the tenant a
 * boundary rather than the absence of one — "the company admin can read your
 * messages" is defensible; "someone can read them and nobody knows" is not.
 */
describe("§ 11.0.1 — reading content leaves a trace", () => {
  const auditRW = () => openTestDb(join(mesh.stateDir, "audit.db"));
  const readEvents = () => {
    const db = auditRW();
    try {
      return db.prepare(
        `SELECT payload FROM audit_events WHERE event_type = 'mesh.identity.audit_read' ORDER BY stored_at`,
      ).all() as Array<{ payload: string }>;
    } finally { db.close(); }
  };

  test("a content read writes an access event naming who and what", async () => {
    const before = readEvents().length;
    await fetch(`${mesh.http.url}/api/v1/audit/events?limit=5`, { headers: { cookie: adminCookie } });
    const after = readEvents();
    expect(after.length).toBe(before + 1);

    const p = JSON.parse(after.at(-1)!.payload);
    expect(p.event_type).toBe("mesh.identity.audit_read");
    expect(p.actor).toBe(SEED_ADMIN);
    expect(p.change.read).toBe("list");
    // What was asked for, never what came back. A log that quoted the content
    // would be a second copy of the thing being protected.
    expect(JSON.stringify(p)).not.toContain("hello");
    expect(p.change.query.limit).toBe("5");
  });

  test("a metadata-only read writes nothing", async () => {
    // Nothing to protect, so nothing to record — and gating it would take the
    // mesh's diagnostics down with its audit store.
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    db.prepare(`DELETE FROM role_grants WHERE subject='platform-admin' AND capability='audit.read.content'`).run();
    db.close();

    const before = readEvents().length;
    const res = await fetch(`${mesh.http.url}/api/v1/audit/events?limit=3`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(readEvents().length).toBe(before);

    const db2 = openTestDb(join(mesh.stateDir, "agents.db"));
    db2.prepare(`INSERT INTO role_grants (tenant,subject,capability,scope,granted_by)
                 VALUES ('default','platform-admin','audit.read.content','*','test') ON CONFLICT DO NOTHING`).run();
    db2.close();
  });

  test("the by-id route is recorded too, with the id it reached", async () => {
    // One boundary, two routes. Recording the listing and forgetting the
    // single-event route is the shape this bug takes.
    const list = await (await fetch(`${mesh.http.url}/api/v1/audit/events?limit=1`, {
      headers: { cookie: adminCookie },
    })).json();
    const id = list.events[0]!.event_id;

    const before = readEvents().length;
    await fetch(`${mesh.http.url}/api/v1/audit/events/${id}`, { headers: { cookie: adminCookie } });
    const after = readEvents();
    expect(after.length).toBe(before + 1);
    expect(JSON.parse(after.at(-1)!.payload).change.read).toBe(id);
  });
});

/**
 * The half of § 11.0.1 nobody exercises by accident.
 *
 * A rule nobody has watched fail is a rule nobody knows is running, and this
 * one only runs when the audit store is unwritable — which never happens in a
 * passing suite. So it is made to happen.
 */
describe("§ 11.0.1 — a read that cannot be recorded does not happen", () => {
  const setContent = (on: boolean) => {
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    try {
      if (on) {
        db.prepare(`INSERT INTO role_grants (tenant,subject,capability,scope,granted_by)
                    VALUES ('default','platform-admin','audit.read.content','*','test')
                    ON CONFLICT DO NOTHING`).run();
      } else {
        db.prepare(`DELETE FROM role_grants WHERE subject='platform-admin' AND capability='audit.read.content'`).run();
      }
    } finally { db.close(); }
  };

  /**
   * Hold the audit store's write lock so the access-log INSERT fails the way a
   * full disk would.
   *
   * The writer waits out `busy_timeout = 5000` before giving up, so anything
   * using this needs a test timeout above that — which is also a real
   * operational property worth knowing: **a content read under a stuck audit
   * store costs five seconds before it is refused.**
   */
  const withLockedAudit = async <T>(fn: () => Promise<T>): Promise<T> => {
    const blocker = openTestDb(join(mesh.stateDir, "audit.db"));
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("BEGIN EXCLUSIVE");
    try { return await fn(); } finally { blocker.exec("ROLLBACK"); blocker.close(); }
  };

  test("content is refused, and the refusal carries none of it", async () => {
    setContent(true);
    const res = await withLockedAudit(() =>
      fetch(`${mesh.http.url}/api/v1/audit/events?limit=5`, { headers: { cookie: adminCookie } }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("AUDIT_READ_UNRECORDABLE");
    // A refusal that shipped the events would be the fail-open this prevents,
    // arriving through the error path.
    expect(body.events).toBeUndefined();
  }, 20_000);

  test("metadata still answers while the store is unwritable", async () => {
    // Refusing metadata too would take the mesh's diagnostics down with its
    // audit store — the outage would hide itself.
    setContent(false);
    try {
      const res = await withLockedAudit(() =>
        fetch(`${mesh.http.url}/api/v1/audit/events?limit=3`, { headers: { cookie: adminCookie } }));
      expect(res.status).toBe(200);
    } finally {
      setContent(true);
    }
  }, 20_000);
});

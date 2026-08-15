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

import { formatUploadAuthorization, uploadSignaturePreimage } from "@agent-mesh/contracts";

import {
  connectRpc, loginAsAdmin, newKeyPair, provision, startMesh,
  type KeyPair, type Mesh, type RpcClient,
} from "./harness";

let mesh: Mesh;
let kp: KeyPair;
let rpc: RpcClient;
const IDENTITY = "audit-agent";

beforeAll(async () => {
  mesh = await startMesh();
  const cookie = await loginAsAdmin(mesh.http);
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

const auditDb = () => new Database(join(mesh.stateDir, "audit.db"), { readonly: true });

const event = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  event_id: `evt_${Math.random().toString(36).slice(2)}`,
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
    // Absent on a 0.1 hub, which is how a client detects one rather than
    // discovering it by having an append refused.
    expect(res.result.capabilities.audit.schema_version_max).toBe(1);
    expect(res.result.capabilities.audit.max_blob_bytes).toBeGreaterThan(0);
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

    const [row] = rows(
      `SELECT * FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    );
    expect(row).toBeTruthy();
    expect(row.event_type).toBe("mesh.message.pending");
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
      `SELECT payload FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    );
    expect(JSON.parse(row.payload).message.content).toBe("body carried");
  });

  test("delivered and pending are distinguished", async () => {
    const listener = await connectRpc(mesh.hub);
    await listener.call("mesh.connect", { identity: "audit-peer" });
    const sent = await rpc.call("mesh.send", { to: "audit-peer", content: "live" });
    listener.close();

    const [row] = rows(
      `SELECT event_type FROM audit_events WHERE correlation_id = ? AND recorded_by_kind = 'hub'`,
      sent.result.id,
    );
    // The event states what happened, not what was attempted.
    expect(row.event_type).toBe("mesh.message.delivered");
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

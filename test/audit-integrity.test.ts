/**
 * An audit row whose bytes changed says so (SPEC § 8.9).
 *
 * **The digest was written at ingest and read back beside the row it
 * describes**, which proves nothing on its own: nobody compared them. A row
 * edited afterwards carries either a digest edited with it or a mismatch that
 * no reader ever evaluates, and an audit store whose rows can be changed
 * without detection is a log.
 *
 * Recomputing needs no key, which is why it is this and not a signature
 * re-check. A superseded key's row is deleted (`keys.ts`, `DELETE FROM
 * agent_keys`), so an event signed by a rotated key can never be verified
 * again — and a column answering `unverifiable` for rotation and for tampering
 * alike distinguishes nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { capabilityViewer, connectRpc, loginAsAdmin, newKeyPair, openTestDb, provision, provisionProxy, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);

  // One real event, produced the way events are produced.
  const sender = newKeyPair(), recipient = newKeyPair();
  await provision(mesh.hub, "integrity-sender", "ai-claude", null, sender.publicKey);
  await provision(mesh.hub, "integrity-recipient", "ai-claude", null, recipient.publicKey);
  for (const fp of [sender.fingerprint, recipient.fingerprint]) {
    await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fingerprint: fp }),
    });
  }
  const rpc = await connectRpc(mesh.hub, { kid: sender.fingerprint, privateKey: sender.privateKey });
  await rpc.call("mesh.connect", { identity: "integrity-sender" });
  await rpc.call("mesh.send", { to: "integrity-recipient", content: "a row to tamper with" });
  rpc.close();
  await Bun.sleep(300);
}, 60_000);

afterAll(() => mesh?.stop());

const events = async () =>
  ((await (await fetch(`${mesh.http.url}/api/v1/audit/events`, { headers: { cookie } })).json()) as any).events as any[];

describe("payload integrity", () => {
  test("an untouched row reports a matching digest", async () => {
    const rows = await events();
    expect(rows.length, "no audit events were produced — nothing here is being checked").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.integrity, `${r.event_id} has no integrity field`).toBeDefined();
      expect(r.integrity.digest_matches, `${r.event_id} reports tampering on a fresh mesh`).toBe(true);
    }
  }, 30_000);

  test("editing the payload behind the API is reported", async () => {
    // **The half that makes the field mean anything.** Always-true is what it
    // was before: the digest was returned and never compared. This edits the
    // stored bytes the way an intruder or a bad migration would, leaving the
    // digest column alone, and expects the route to notice.
    const before = await events();
    const target = before[0]!;
    expect(target.integrity.digest_matches).toBe(true);

    const db = openTestDb(join(mesh.stateDir, "audit.db"), { readwrite: true });
    const original = (db.prepare(`SELECT payload FROM audit_events WHERE event_id = ?`)
      .get(target.event_id) as { payload: string }).payload;
    db.prepare(`UPDATE audit_events SET payload = ? WHERE event_id = ?`)
      .run(original.replace("a row to tamper with", "a row that was tampered with"), target.event_id);
    db.close();

    const after = await events();
    const tampered = after.find((r) => r.event_id === target.event_id)!;
    expect(tampered.integrity.digest_matches, "the payload changed and the route still said it matched").toBe(false);

    // Every other row is untouched, so a check that answers `false` for
    // everything once anything changes would fail here.
    for (const r of after.filter((x) => x.event_id !== target.event_id)) {
      expect(r.integrity.digest_matches, `${r.event_id} was not edited and is reported as tampered`).toBe(true);
    }
  }, 30_000);
});

describe("what the attestation does and does not claim", () => {
  test("a signed event carries its attestation, and nothing calls it verified", async () => {
    // `attestation !== null` means the event arrived signed — measured, at
    // ingest. It does not mean this route re-checked it, and the response must
    // not carry a field that says it did. A screen reading one as the other is
    // how `signature_verified ?? true` came to render a tick for every row.
    const rows = await events();
    const signed = rows.filter((r) => r.attestation !== null);
    expect(signed.length, "no signed event to check").toBeGreaterThan(0);

    for (const r of signed) {
      expect(r.attestation.sig?.alg).toBe("ed25519");
      expect(typeof r.attestation.sig?.kid).toBe("string");
      expect(r.signature_verified, "the route claims a verification it did not perform").toBeUndefined();
      expect(r.verified, "the route claims a verification it did not perform").toBeUndefined();
    }
  }, 30_000);
});

describe("the row agrees with the payload it stores", () => {
  test("every field carried in both layers holds the same value", async () => {
    // **Five names appear twice**: `event_id`, `schema_version`, `event_type`,
    // `occurred_at`, `correlation_id` sit both on the row and inside `payload`.
    //
    // That is not accidental duplication. `payload` is the bytes the producer
    // signed and the digest covers, so it cannot be rewritten; the columns are
    // the hub's projection of it, indexed so the trail can be queried. Both are
    // needed and both must say the same thing.
    //
    // Nothing checked that they do. A divergence means the ingestion projected
    // wrongly, or a migration touched one layer, or a row was edited in a way
    // the digest happened to survive — and until now every one of those looked
    // exactly like a healthy row from outside.
    //
    // The reverse of this week's other duplications, and worth saying plainly:
    // those were problems because copies drifted, and this is a problem
    // because nothing would notice if it did.
    const rows = await events();
    expect(rows.length, "no audit events to compare").toBeGreaterThan(0);

    const PROJECTED = ["event_id", "schema_version", "event_type", "occurred_at", "correlation_id"];
    for (const r of rows) {
      const payload = r.payload as Record<string, unknown>;
      // The projection must exist in both layers, or the check silently covers
      // fewer fields than it names — which is the shape this file is about.
      const shared = PROJECTED.filter((k) => k in payload && k in r);
      expect(shared, `${r.event_id}: the two layers no longer share these names`).toEqual(PROJECTED);

      for (const k of PROJECTED) {
        expect(payload[k], `${r.event_id}: row.${k} and payload.${k} disagree`).toEqual(r[k as keyof typeof r]);
      }
    }
  }, 30_000);
});

describe("§ 11.0's three states, all of them reachable", () => {
  test("no session, metadata only, and content — each answers differently", async () => {
    // **The middle one had no caller who could stand on it.** `admin` holds
    // every capability so it sees content, a stranger gets 401, and the state
    // the audit screen advertises in its own subtitle — redacted for a holder
    // of `audit.read.metadata` and not `audit.read.content` — could be produced
    // by no account that existed. The code was all there; the caller was not,
    // and a screen-level test cannot notice because the screen renders either
    // way.
    //
    // Found by agent-mesh-local-pm trying to walk the redaction path and
    // finding nobody to walk it as (mail #569).
    const viewer = await capabilityViewer(mesh, "audit.read.metadata");

    // 1. Nobody.
    expect((await fetch(`${mesh.http.url}/api/v1/audit/events?limit=1`)).status).toBe(401);

    // 2. Metadata only — the content is withheld and its length survives,
    //    which is § 11.0's line: how much was said is metadata, what was said
    //    is not.
    const redacted = (await (await fetch(`${mesh.http.url}/api/v1/audit/events?limit=1`, {
      headers: { cookie: viewer },
    })).json()) as any;
    const withheld = redacted.events[0].payload.message;
    expect(withheld.content, "content reached a metadata-only reader").toContain("content withheld");
    expect(withheld.content_length, "the length was redacted with the content").toBeGreaterThan(0);

    // 3. Content — the real body, and the length the redaction reported.
    const full = (await (await fetch(`${mesh.http.url}/api/v1/audit/events?limit=1`, {
      headers: { cookie },
    })).json()) as any;
    const shown = full.events[0].payload.message;
    expect(shown.content).not.toContain("content withheld");
    // The two views must describe the same message. A length that does not
    // match the body it stands in for is a number nobody can act on.
    expect(withheld.content_length, "content_length does not match the body it replaced")
      .toBe(shown.content.length);
  }, 45_000);
});

describe("§ 8.2 — the sender and the carrier stay different facts", () => {
  test("a proxied send records both, and the query keeps them apart", async () => {
    // **`sent_by` falls back to `from_agent` when nothing carried the message**
    // (`audit.ts`: `sentBy: row.sent_by ?? row.from_agent`), so on a mesh where
    // nothing is ever proxied the two columns are equal in every row — and a
    // query that dropped `sent_by` entirely, or overwrote `from` with the
    // carrier, would look identical.
    //
    // Every audit row this suite produced before this test had sent_by === from.
    // The distinction § 8.2 exists for was unobservable, which is the same
    // shape as § 11.0's middle state: the code was right and nothing could tell.
    const gwKey = newKeyPair(), recipientKey = newKeyPair();
    await provisionProxy(mesh.hub, "audit-gateway", "service", mesh.http);
    // **Keyless on purpose.** § 8.2 refuses a proxy for an identity that holds
    // its own key — `cannot act for 'x': that identity holds its own key and
    // signs for itself` — because such an identity can speak, so nobody needs
    // to speak for it. A person authenticated by web session is the real case,
    // and `human` is the type that carries no key.
    await provision(mesh.hub, "audit-subject", "human");
    await provision(mesh.hub, "audit-recipient", "ai-claude", null, recipientKey.publicKey);

    // The gateway signs with its own key and speaks for someone else.
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "audit-gateway", type: "service", public_key: gwKey.publicKey }),
    });
    for (const fp of [gwKey.fingerprint, recipientKey.fingerprint]) {
      await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ fingerprint: fp }),
      });
    }

    const rpc = await connectRpc(mesh.hub, { kid: gwKey.fingerprint, privateKey: gwKey.privateKey });
    await rpc.call("mesh.connect", { identity: "audit-gateway", proxy_for: ["audit-subject"] });
    const sent = await rpc.call("mesh.send", {
      from: "audit-subject",
      to: "audit-recipient",
      content: "carried, not sent",
    });
    rpc.close();
    expect(sent.error, `the proxied send was refused: ${JSON.stringify(sent.error)}`).toBeUndefined();
    await Bun.sleep(300);

    const rows = await events();
    const carried = rows
      .map((r) => (r.payload as any)?.message)
      .filter((m) => m && m.content === "carried, not sent");
    expect(carried.length, "the proxied send produced no audit row").toBeGreaterThan(0);

    for (const m of carried) {
      // The subject is who the message is *from*; the gateway only carried it.
      expect(m.from, "the carrier overwrote the sender").toBe("audit-subject");
      expect(m.sent_by, "the carrier was not recorded").toBe("audit-gateway");
      // The assertion that could not be made before: they differ. On every
      // other row in this suite they are equal, and equal is what a dropped
      // column also produces.
      expect(m.sent_by).not.toBe(m.from);
    }
  }, 60_000);
});

describe("§ 11 — a session is told what it may do", () => {
  test("/auth/me reports the grants this subject holds, and different subjects differ", async () => {
    // **Without this a client has `role` and builds its own table**, which is a
    // second copy of a list this server owns and which nothing can compare. The
    // admin front end had one, and three of its six names disagreed — nothing
    // failed, because the two lists never met (mail #613).
    const adminMe = (await (await fetch(`${mesh.http.url}/auth/me`, { headers: { cookie } })).json()) as any;
    expect(Array.isArray(adminMe.capabilities), "/auth/me does not report capabilities").toBe(true);
    expect(adminMe.capabilities, "admin holds no capability").not.toEqual([]);

    // The half that makes the first meaningful. `admin` holds everything, so
    // asserting on it alone passes against a hardcoded list of all names — the
    // shape this field exists to remove.
    const viewer = await capabilityViewer(mesh, "audit.read.metadata");
    const viewerMe = (await (await fetch(`${mesh.http.url}/auth/me`, { headers: { cookie: viewer } })).json()) as any;
    expect(viewerMe.capabilities).toEqual(["audit.read.metadata"]);
    expect(viewerMe.capabilities).not.toEqual(adminMe.capabilities);

    // And what it reports is what the routes enforce, not a role expansion: a
    // name it omits is a name that gets 403.
    expect(viewerMe.capabilities).not.toContain("key.approve");
    const refused = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, { headers: { cookie: viewer } });
    expect(refused.status, "a capability it does not report was allowed anyway").toBe(403);
  }, 45_000);
});

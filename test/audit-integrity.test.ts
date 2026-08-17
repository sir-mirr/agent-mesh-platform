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

import { connectRpc, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh } from "./harness";

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

    const db = new Database(join(mesh.stateDir, "audit.db"), { readwrite: true });
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

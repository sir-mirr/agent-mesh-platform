/**
 * Step 2 — key registration and approval (SPEC § 10.1, § 10.2).
 *
 * The straight path is three calls. Everything else here is a client that
 * restarted at an awkward moment, which is where a naive implementation of this
 * state machine takes an identity offline: re-sending a key on boot must not
 * knock the identity's own approved key back to pending.
 *
 * Nothing verifies signatures yet. That is deliberate — increment 2 is inert, so
 * increment 3 is a switch thrown on a mechanism already in place rather than a
 * mechanism and its enforcement arriving together.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

import { keyFingerprint } from "@agent-mesh/contracts";

import { callHttp, connectRpc, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh , teardown} from "./harness";

let mesh: Mesh;
let adminCookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  adminCookie = await loginAsAdmin(mesh.http);
});

afterAll(() => mesh?.stop());

/** A real Ed25519 key — the fingerprint has to be over genuine key bytes. */
function newKey(): { publicKey: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // SPKI wraps the raw 32 bytes behind a 12-byte header.
  const raw = new Uint8Array(der.subarray(der.length - 32));
  const b64 = Buffer.from(raw).toString("base64url");
  return { publicKey: b64, fingerprint: keyFingerprint(b64) };
}

const register = (identity: string, type: string, publicKey?: string) =>
  fetch(`${mesh.hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type, ...(publicKey ? { public_key: publicKey } : {}) }),
  });

const keysOf = (identity: string) =>
  fetch(`${mesh.hub.url}/api/v1/agents/${identity}/keys`).then((r) => r.json());

const decide = (decision: string, fingerprint: string, reason?: string) =>
  fetch(`${mesh.http.url}/api/v1/admin/keys/${decision}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ fingerprint, ...(reason ? { reason } : {}) }),
  });

const statusOf = async (identity: string, fingerprint: string) => {
  const body = await keysOf(identity);
  return body.keys.find((k: any) => k.fingerprint === fingerprint)?.status ?? null;
};

describe("registration", () => {
  test("a key arrives pending and grants nothing", async () => {
    const k = newKey();
    const res = await register("keyed-one", "ai-codex", k.publicKey);
    expect(res.status).toBe(201);
    expect((await res.json()).key).toEqual({ fingerprint: k.fingerprint, status: "pending" });

    const body = await keysOf("keyed-one");
    expect(body.key_status).toBe("pending");
  });

  test("the hub derives the same fingerprint the client does", async () => {
    // If these ever disagree, the operator comparing them reads a correct key
    // as the wrong one, and the comparison § 10.2 requires stops meaning
    // anything.
    const k = newKey();
    await register("fingerprint-agree", "ai-codex", k.publicKey);
    expect(await statusOf("fingerprint-agree", k.fingerprint)).toBe("pending");
  });

  test("a requires_key type registered without a key is refused", async () => {
    const res = await register("unkeyed-runtime", "ai-claude");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("requires a signing key");
  });

  test("a type that does not require one registers without", async () => {
    expect((await register("plain-service", "service")).status).toBe(201);
    expect((await keysOf("plain-service")).key_status).toBe("missing");
  });

  test("a malformed key is refused before anything is stored", async () => {
    const res = await register("bad-key", "ai-codex", "not-a-real-key");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("base64url");
  });
});

describe("the sequences that break naive implementations", () => {
  test("propose → approve → propose the same key again changes nothing", async () => {
    const k = newKey();
    await register("restarter", "ai-codex", k.publicKey);
    expect((await decide("approve", k.fingerprint)).status).toBe(200);
    expect(await statusOf("restarter", k.fingerprint)).toBe("approved");

    // The failure this guards: an adapter re-sends its key on every boot. If
    // that knocked its own approved key back to pending, a restart would take
    // the identity offline until someone noticed and re-approved it.
    const again = await register("restarter", "ai-codex", k.publicKey);
    expect((await again.json()).key).toEqual({ fingerprint: k.fingerprint, status: "approved" });
    expect(await statusOf("restarter", k.fingerprint)).toBe("approved");
  });

  test("a proposal never touches an approved key", async () => {
    const first = newKey();
    const second = newKey();
    await register("rotator", "ai-codex", first.publicKey);
    await decide("approve", first.fingerprint);

    await register("rotator", "ai-codex", second.publicKey);
    // The incumbent stays usable while the replacement waits, so proposing a
    // rotation does not open a window where the identity cannot sign.
    expect(await statusOf("rotator", first.fingerprint)).toBe("approved");
    expect(await statusOf("rotator", second.fingerprint)).toBe("pending");
    expect((await keysOf("rotator")).key_status).toBeNull();

    await decide("approve", second.fingerprint);
    expect(await statusOf("rotator", second.fingerprint)).toBe("approved");
    expect(await statusOf("rotator", first.fingerprint)).toBe("revoked");
  });

  test("a different key while one is pending replaces it", async () => {
    const a = newKey();
    const b = newKey();
    await register("flapper", "ai-codex", a.publicKey);
    await register("flapper", "ai-codex", b.publicKey);

    // A restart loop with a fresh key each time would otherwise flood the
    // queue, and only the newest proposal can be the one the holder is logging.
    expect(await statusOf("flapper", a.fingerprint)).toBeNull();
    expect(await statusOf("flapper", b.fingerprint)).toBe("pending");

    const events = (await keysOf("flapper")).events;
    expect(events.find((e: any) => e.fingerprint === a.fingerprint && e.action === "superseded"))
      .toBeTruthy();
  });

  test("a superseded key can be proposed again", async () => {
    // Supersession is not a ruling. Parking the displaced row in a terminal
    // state would leave a client that flaps between two keys unable to return
    // to the first.
    const a = newKey();
    const b = newKey();
    await register("returner", "ai-codex", a.publicKey);
    await register("returner", "ai-codex", b.publicKey);
    await register("returner", "ai-codex", a.publicKey);
    expect(await statusOf("returner", a.fingerprint)).toBe("pending");
    expect(await statusOf("returner", b.fingerprint)).toBeNull();
  });

  test("revocation without a replacement leaves the identity unable to sign", async () => {
    const k = newKey();
    await register("revoked-agent", "ai-codex", k.publicKey);
    await decide("approve", k.fingerprint);
    expect((await decide("revoke", k.fingerprint, "compromise")).status).toBe(200);

    const body = await keysOf("revoked-agent");
    expect(body.key_status).toBe("revoked");
    // Never deleted: past signatures stay verifiable, and the event timeline is
    // what lets a verifier judge them by date.
    expect(body.keys.find((x: any) => x.fingerprint === k.fingerprint).status).toBe("revoked");
    expect(body.events.find((e: any) => e.action === "revoked").reason).toBe("compromise");
  });

  test("re-proposing a denied key returns the ruling rather than reopening it", async () => {
    const k = newKey();
    await register("denied-agent", "ai-codex", k.publicKey);
    await decide("deny", k.fingerprint, "unknown fingerprint");
    expect(await statusOf("denied-agent", k.fingerprint)).toBe("denied");

    const again = await register("denied-agent", "ai-codex", k.publicKey);
    expect((await again.json()).key.status).toBe("denied");
  });
});

describe("approval is gated, and the hub cannot do it", () => {
  test("the hub serves no approval route", async () => {
    const k = newKey();
    await register("hub-approve", "ai-codex", k.publicKey);
    for (const path of ["/api/v1/admin/keys/approve", "/api/v1/keys/approve"]) {
      const res = await fetch(`${mesh.hub.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprint: k.fingerprint }),
      });
      expect(res.status).toBe(404);
    }
    // The whole procedure rests on this: the hub cannot authenticate a caller,
    // so an approval endpoint there would let anyone approve their own key.
    expect(await statusOf("hub-approve", k.fingerprint)).toBe("pending");
  });

  test("approval without an admin session is refused", async () => {
    const k = newKey();
    await register("no-session", "ai-codex", k.publicKey);
    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: k.fingerprint }),
    });
    expect(res.status).toBe(401);
    expect(await statusOf("no-session", k.fingerprint)).toBe("pending");
  });

  test("the decision records who made it", async () => {
    const k = newKey();
    await register("attributed", "ai-codex", k.publicKey);
    const body = await (await decide("approve", k.fingerprint)).json();
    // An approval nobody is named for is one nobody can be asked about.
    expect(body.decided_by).toBe("admin");
    expect(body.decided_at).not.toBeNull();
  });

  test("a stale listing gets a useful error, not a silent no-op", async () => {
    const k = newKey();
    await register("stale", "ai-codex", k.publicKey);
    await decide("approve", k.fingerprint);

    // 409, not 404: the operator has the right string and someone got there
    // first, which is a different problem from a typo.
    expect((await decide("approve", k.fingerprint)).status).toBe(409);
    expect((await decide("approve", "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status)
      .toBe(404);
  });

  test("revocation demands a reason", async () => {
    const k = newKey();
    await register("no-reason", "ai-codex", k.publicKey);
    await decide("approve", k.fingerprint);
    const res = await decide("revoke", k.fingerprint);
    expect(res.status).toBe(400);
    // rotation says nothing about earlier signatures; compromise casts doubt on
    // the window before it. Without the reason neither can be told later.
    expect((await res.json()).error).toContain("reason");
  });

  test("the pending queue lists what is waiting, with fingerprints", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, {
      headers: { cookie: adminCookie },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    // § 10.2: the surface must display the fingerprint being approved, or the
    // comparison the operator is meant to perform is impossible.
    for (const p of body.pending) {
      expect(p.fingerprint).toMatch(/^sha256:/);
      expect(p.identity).toBeTruthy();
    }
  });
});

describe("approval is what makes a key usable", () => {
  test("a pending key gets you nowhere, by either route", async () => {
    // Increment 2 shipped inert on purpose, so increment 3 was a switch thrown
    // on a mechanism already in place. This asserts the switch is thrown — and
    // that the two ways of arriving unauthenticated are told apart.
    const kp = newKeyPair();
    await register("inert-agent", "ai-codex", kp.publicKey);

    // No signature at all: the type requires one, and that is the complaint.
    const unsigned = await connectRpc(mesh.hub);
    const a = await unsigned.call("mesh.connect", { identity: "inert-agent" });
    unsigned.close();
    expect(a.error).toMatchObject({ code: -32012 });
    expect(a.error.message).toContain("requires a signature");

    // A correct signature from the proposed key: the complaint is now that
    // nobody has approved it. A client acts on that differently — it waits.
    const signed = await connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey });
    const b = await signed.call("mesh.connect", { identity: "inert-agent" });
    signed.close();
    expect(b.error).toMatchObject({ code: -32014 });
    expect(b.error.data.key_status).toBe("pending");
  });
});

describe("storage", () => {
  test("keys and their history live in agents.db", () => {
    const db = new Database(join(mesh.stateDir, "agents.db"), { readonly: true });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM agent_key_events`).get() as { n: number };
    expect(n.n).toBeGreaterThan(0);
    db.close();
  });
});

/**
 * § 10.1 `create_only` — onboarding must never take over an existing identity.
 *
 * The route upserts by default, so a check followed by a provision has a window
 * in which a second lane adopts the first one's identity and supersedes its
 * pending key. The taker sees a 200; the holder sees their key vanish and finds
 * out when approval fails.
 */
describe("create_only", () => {
  const registerOnce = (identity: string, publicKey?: string, description?: string) =>
    fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity, type: "ai-codex", create_only: true,
        ...(publicKey ? { public_key: publicKey } : {}),
        ...(description ? { description } : {}),
      }),
    });

  test("creates when the name is free", async () => {
    const k = newKey();
    const res = await registerOnce("lane-fresh", k.publicKey);
    expect(res.status).toBe(201);
    expect((await res.json()).key.status).toBe("pending");
  });

  test("refuses when taken, with a code a caller can branch on", async () => {
    const a = newKey();
    await registerOnce("lane-taken", a.publicKey);

    const b = newKey();
    const res = await registerOnce("lane-taken", b.publicKey, "second lane");
    expect(res.status).toBe(409);
    const body = await res.json();
    // A code, not prose: "taken" and "torn down" need different responses from
    // a person, and neither is fixed by retrying.
    expect(body.code).toBe("IDENTITY_EXISTS");
    expect(body.identity).toBe("lane-taken");
  });

  test("a refused registration changes nothing at all", async () => {
    // The assertion that matters. A refusal that still superseded the key would
    // be worse than the upsert it replaced — the caller is told no and the
    // damage is done anyway.
    const original = newKey();
    await registerOnce("lane-intact", original.publicKey, "the original");

    const intruder = newKey();
    expect((await registerOnce("lane-intact", intruder.publicKey, "the intruder")).status).toBe(409);

    const body = await keysOf("lane-intact");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].fingerprint).toBe(original.fingerprint);
    expect(body.keys[0].status).toBe("pending");

    const db = new Database(join(mesh.stateDir, "agents.db"), { readonly: true });
    const row = db.prepare(`SELECT description FROM agents WHERE identity = ?`)
      .get("lane-intact") as { description: string };
    db.close();
    expect(row.description).toBe("the original");
  });

  test("a torn-down identity is refused with its own code", async () => {
    await registerOnce("lane-gone", newKey().publicKey);
    await teardown(mesh.http, "lane-gone");

    const res = await registerOnce("lane-gone", newKey().publicKey);
    expect(res.status).toBe(409);
    // Distinct from IDENTITY_EXISTS: this name is never usable again, so a
    // caller should pick another rather than wait.
    expect((await res.json()).code).toBe("IDENTITY_DELETED");
  });

  test("without it, the old update semantics still apply", async () => {
    // Rotation and re-registration depend on them, so the default must not
    // change under anyone.
    const k = newKey();
    await register("lane-updatable", "ai-codex", k.publicKey);
    const again = await register("lane-updatable", "ai-codex", k.publicKey);
    expect(again.status).toBe(200);
  });

  test("concurrent registrations of one name produce exactly one winner", async () => {
    // The race the guard exists for. The insert is the check, so the loser
    // cannot slip between a read and a write.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => registerOnce("lane-race", newKey().publicKey)),
    );
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(7);
    expect((await keysOf("lane-race")).keys).toHaveLength(1);
  });
});

/**
 * SPEC § 9.2. Reported by `client-claude` (mail #122): a host re-adding a lane
 * writes the runtime the user named, and had no way to check that against what
 * the hub already holds.
 *
 * **The reason first given here was wrong**, and the correction is the point.
 * It said `mesh.list_agents` needs a connected lane, so a host whose first lane
 * is the reclaim cannot ask. § 8.10 serves that method over `POST /api/v1/rpc`
 * with no socket at all, so the missing thing was never a connection — it is an
 * **approved key**, which § 8.10 resolves the caller by and refuses `-32014`
 * without. That is the state a host occupies while an operator has not decided
 * yet, and after a revocation.
 *
 * The claim came in a mail and went into SPEC without being checked against
 * § 8.10 in this repository. The tests all passed either way: a reason is not
 * executable, so nothing here was ever going to fail because it was wrong. The
 * last test below is what makes this one executable.
 */
describe("the registered type is readable without an approved key", () => {
  test("GET /keys reports it", async () => {
    await register("typed-lane", "ai-antigravity", newKey().publicKey);
    expect((await keysOf("typed-lane")).type).toBe("ai-antigravity");
  });

  test("create_only leaves the stored type alone, so a mismatch survives to be seen", async () => {
    // The reclaim path. `create_only` is what § 10.1 requires for onboarding,
    // and it refuses rather than updates — so a caller that treats `409` as
    // "already mine, carry on" ends up with a local config the hub disagrees
    // with, and nothing anywhere says so.
    await register("reclaim-guarded", "ai-antigravity", newKey().publicKey);
    const res = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "reclaim-guarded", type: "ai-claude", create_only: true }),
    });
    expect(res.status).toBe(409);
    expect((await keysOf("reclaim-guarded")).type).toBe("ai-antigravity");
  });

  test("without create_only the hub takes the new type, and says nothing about the old one", async () => {
    // The other half, and the more dangerous one. § 10.1 step 5 mandates this
    // upsert, so it is the contract working as written — but the identity's
    // audit history was written while it was something else, and `type` is
    // read at display time. Nothing records that it moved.
    // Recorded in docs/deferred.md.
    const k = newKey();
    await register("reclaim-open", "ai-antigravity", k.publicKey);
    await register("reclaim-open", "ai-claude", k.publicKey);
    expect((await keysOf("reclaim-open")).type).toBe("ai-claude");
  });

  test("a name nobody registered still 404s", async () => {
    // The route must not become a probe for whether a name is taken by
    // answering `type: null` instead.
    const res = await fetch(`${mesh.hub.url}/api/v1/agents/never-existed/keys`);
    expect(res.status).toBe(404);
  });

  test("and the route that also carries type is closed while the key is pending", async () => {
    // The corrected reason, made checkable. `mesh.list_agents` over § 8.10
    // needs no socket — but it resolves its caller by fingerprint, so a key an
    // operator has not approved gets nothing. `/keys` is unauthenticated and
    // answers throughout, which is the whole gap this closes.
    const k = newKeyPair();
    await register("reclaim-pending", "ai-antigravity", k.publicKey);

    const rpc = await callHttp(mesh.hub, { kid: k.fingerprint, privateKey: k.privateKey },
      "mesh.list_agents", {});
    expect(rpc.status).toBe(403);
    expect(rpc.body.error.code).toBe(-32014);
    expect(rpc.body.error.data.key_status).toBe("pending");

    expect((await keysOf("reclaim-pending")).type).toBe("ai-antigravity");
  });

  test("once approved, § 8.10 answers too — and carries every agent's type", async () => {
    // Why the narrower route is still the better answer where both work.
    const k = newKeyPair();
    await register("reclaim-approved", "ai-antigravity", k.publicKey);
    expect((await decide("approve", k.fingerprint)).status).toBe(200);

    const rpc = await callHttp(mesh.hub, { kid: k.fingerprint, privateKey: k.privateKey },
      "mesh.list_agents", {});
    expect(rpc.status).toBe(200);
    const mine = rpc.body.result.agents.find((a: any) => a.id === "reclaim-approved");
    expect(mine.type).toBe("ai-antigravity");
    // Everyone else's, for a caller that asked about itself.
    expect(rpc.body.result.agents.length).toBeGreaterThan(1);
  });
});

/**
 * SPEC § 10.1. `agent_keys` is keyed on the fingerprint alone.
 *
 * Found by measurement, not by reading: `platform-fe-antigravity` reported
 * provisioning as verified (mail #146), and the identity they had created
 * existed with a `requires_key` type and no key row at all. The response they
 * quoted said `status: "approved"` — someone else's status, on a key that was
 * never theirs.
 *
 * The reason it read as working is that the two checks each pass. The
 * `requires_key` guard asks whether a `public_key` was *supplied*. `proposeKey`
 * finds the fingerprint on record and returns that ruling, which is right for
 * the same identity re-proposing and wrong for anyone else. Neither is looking
 * at the thing that matters: whether a key landed **for this identity**.
 */
describe("a key already held by another identity", () => {
  test("is refused, and the row is not created", async () => {
    const k = newKey();
    await register("kh-owner", "ai-claude", k.publicKey);

    const res = await register("kh-thief", "ai-claude", k.publicKey);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("KEY_HELD_BY_ANOTHER_IDENTITY");

    // Nothing at all: the identity must not survive a refused provisioning,
    // or a `requires_key` type is left holding no key.
    const after = await fetch(`${mesh.hub.url}/api/v1/agents/kh-thief/keys`);
    expect(after.status).toBe(404);
  });

  test("does not say whose it is", async () => {
    // § 10.2 keeps fingerprint-to-identity closed. A refusal that named the
    // holder would open it on the one route that needs no credential at all.
    const k = newKey();
    await register("kh-secret-owner", "ai-claude", k.publicKey);
    const body = await (await register("kh-prober", "ai-claude", k.publicKey)).json();
    expect(JSON.stringify(body)).not.toContain("kh-secret-owner");
  });

  test("the same identity re-proposing its own key is unaffected", async () => {
    // The behaviour the branch was written for, which the fix must not break.
    const k = newKey();
    await register("kh-restarter", "ai-claude", k.publicKey);
    const again = await register("kh-restarter", "ai-claude", k.publicKey);
    expect(again.status).toBe(200);
    expect((await again.json()).key.status).toBe("pending");
  });

  test("an approved key is still reported to its own holder", async () => {
    const k = newKey();
    await register("kh-approved", "ai-claude", k.publicKey);
    expect((await decide("approve", k.fingerprint)).status).toBe(200);
    const again = await register("kh-approved", "ai-claude", k.publicKey);
    expect((await again.json()).key.status).toBe("approved");
  });

  // The store-level backstop is exercised in packages/store/src/store.test.ts.
  // It belongs there: `test/` drives real processes over the wire and importing
  // the store's source into it breaks that boundary — and the build, since the
  // suite compiles with `rootDir: "."`.
});

/**
 * SPEC § 8.9.5. Recorded as a defect this morning and closed here.
 *
 * § 10.1 mandates the upsert, so a re-registration replacing `type` is the
 * contract working — but `agents.type` is read at display time, so the change
 * re-labels **every past audit event** for that identity as having come from a
 * different runtime. Key transitions each write an `agent_key_events` row with
 * an actor; this had no equivalent, and the trail said the identity always was
 * what it now is.
 */
describe("a type change leaves a record", () => {
  const auditOf = (identity: string) => {
    const db = new Database(join(mesh.stateDir, "audit.db"), { readonly: true });
    try {
      return db
        .prepare(`SELECT event_type, payload FROM audit_events WHERE identity = ? ORDER BY stored_at`)
        .all(identity) as Array<{ event_type: string; payload: string }>;
    } finally {
      db.close();
    }
  };

  test("the event carries both halves, because the row only holds one", async () => {
    const k = newKey();
    await register("tc-mover", "ai-antigravity", k.publicKey);
    await register("tc-mover", "ai-claude", k.publicKey);

    const events = auditOf("tc-mover").filter((e) => e.event_type === "mesh.identity.type_changed");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.change).toEqual({ from: "ai-antigravity", to: "ai-claude" });
    // `from` is the point. The row no longer holds it, so an event carrying
    // only `to` would say a change happened and not what it undid.
    expect(payload.identity).toBe("tc-mover");
  });

  test("no event when the type did not move", async () => {
    // A lane re-registering on every boot must not fill the trail.
    const k = newKey();
    await register("tc-steady", "ai-claude", k.publicKey);
    await register("tc-steady", "ai-claude", k.publicKey);
    await register("tc-steady", "ai-claude", k.publicKey);
    expect(auditOf("tc-steady").filter((e) => e.event_type === "mesh.identity.type_changed")).toHaveLength(0);
  });

  test("no event on first registration", async () => {
    // There is no `from`, so there is no change — an event here would report
    // `null -> ai-claude` for every identity ever created.
    await register("tc-fresh", "ai-claude", newKey().publicKey);
    expect(auditOf("tc-fresh")).toHaveLength(0);
  });

  test("the actor is null, and that is the finding rather than a gap", async () => {
    // `POST /api/v1/agents` cannot authenticate its caller (§ 9.2 †), so the
    // hub records that a type changed and cannot record who is answerable.
    // A fabricated actor would be worse; the null is information about the route.
    const k = newKey();
    await register("tc-anon", "ai-codex", k.publicKey);
    await register("tc-anon", "ai-claude", k.publicKey);
    const payload = JSON.parse(
      auditOf("tc-anon").find((e) => e.event_type === "mesh.identity.type_changed")!.payload,
    );
    expect(payload.actor).toBeNull();
  });
});

/**
 * SPEC § 8.11. The hub's own observation, recorded for every authenticated
 * request on every transport.
 *
 * Unit coverage for the extraction — including the `X-Forwarded-For` forgery
 * this is built against — is in `packages/hub/src/observed.test.ts`. What is
 * checked here is the wiring: three transports resolve the address in three
 * different places, and a transport that quietly records nothing looks
 * identical to one that works.
 */
describe("the observed source is recorded", () => {
  const sourcesOf = (identity: string) => {
    const db = new Database(join(mesh.stateDir, "agents.db"), { readonly: true });
    try {
      return db
        .prepare(`SELECT observed, requests FROM agent_sources WHERE identity = ?`)
        .all(identity) as Array<{ observed: string; requests: number }>;
    } finally {
      db.close();
    }
  };

  test("on connect, over a socket", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "src-ws", "ai-claude", null, kp.publicKey);
    await decide("approve", kp.fingerprint);
    const rpc = await connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey });
    await rpc.call("mesh.connect", { identity: "src-ws" });
    rpc.close();

    const rows = sourcesOf("src-ws");
    expect(rows).toHaveLength(1);
    // Normalised: the harness connects over v4 loopback and Bun reports
    // `::ffff:127.0.0.1`. Storing that spelling would make every later
    // comparison against `127.0.0.1` fail.
    expect(rows[0]!.observed).toBe("127.0.0.1");
  });

  test("on a socketless request, where there is no socket to hang it on", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "src-http", "ai-claude", null, kp.publicKey);
    await decide("approve", kp.fingerprint);
    const res = await callHttp(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey },
      "mesh.list_agents", {});
    expect(res.status).toBe(200);
    expect(sourcesOf("src-http")[0]?.observed).toBe("127.0.0.1");
  });

  test("repeats increment rather than adding rows", async () => {
    // One row per address is the shape the question has — "which addresses has
    // this key been used from" — and a row per request answers it while
    // growing without bound.
    const kp = newKeyPair();
    await provision(mesh.hub, "src-repeat", "ai-claude", null, kp.publicKey);
    await decide("approve", kp.fingerprint);
    const signer = { kid: kp.fingerprint, privateKey: kp.privateKey };
    await callHttp(mesh.hub, signer, "mesh.list_agents", {});
    await callHttp(mesh.hub, signer, "mesh.list_agents", {});
    await callHttp(mesh.hub, signer, "mesh.list_agents", {});

    const rows = sourcesOf("src-repeat");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requests).toBeGreaterThanOrEqual(3);
  });

  test("a request that fails to authenticate records nothing", async () => {
    // The row asserts that this identity was *seen* here. An unverified
    // request only claimed the name, so recording it would let anyone write
    // arbitrary history for an identity they do not hold.
    const kp = newKeyPair();
    const other = newKeyPair();
    await provision(mesh.hub, "src-unauth", "ai-claude", null, kp.publicKey);
    await decide("approve", kp.fingerprint);
    // Signs with a key that is not this identity's.
    const res = await callHttp(mesh.hub, { kid: kp.fingerprint, privateKey: other.privateKey },
      "mesh.list_agents", {});
    expect(res.status).toBe(401);
    expect(sourcesOf("src-unauth")).toHaveLength(0);
  });

  test("capabilities reports how the address was learned", async () => {
    // A control configured off is indistinguishable from one that is on until
    // somebody asks. This is the asking.
    const body = await (await fetch(`${mesh.hub.url}/api/v1/capabilities`)).json();
    expect(body.surface.observed_source).toBe("socket");
  });
});

/**
 * SPEC § 11. The grant is read per request, not carried in the token.
 *
 * The unit tests for scope arithmetic live in
 * `packages/store/src/grants.test.ts`. What is checked here is that the routes
 * actually consult it — a capability model nothing calls looks identical to
 * one that works, and every existing test would still pass because `admin`
 * holds everything.
 */
describe("capabilities gate the routes", () => {
  // Raw SQL rather than importing `@agent-mesh/store`. This suite drives real
  // processes over the wire, and pulling the store's source into it breaks
  // that boundary — and the build, since `test/` compiles with `rootDir: "."`.
  // Made that mistake twice today; the second time is why this comment exists.
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = new Database(join(mesh.stateDir, "agents.db"));
    try { return fn(db); } finally { db.close(); }
  };
  const held = (subject: string) =>
    withDb((db) => (db.prepare(`SELECT capability FROM role_grants WHERE subject = ?`)
      .all(subject) as Array<{ capability: string }>).map((r) => r.capability));
  const revoke = (subject: string, capability: string) =>
    withDb((db) => db.prepare(`DELETE FROM role_grants WHERE subject = ? AND capability = ?`)
      .run(subject, capability));
  const grant = (subject: string, capability: string) =>
    withDb((db) => db.prepare(
      `INSERT INTO role_grants (tenant, subject, capability, scope, granted_by)
       VALUES ('default', ?, ?, '*', 'test') ON CONFLICT DO NOTHING`).run(subject, capability));
  const asAdmin = (path: string) =>
    fetch(`${mesh.http.url}${path}`, { headers: { cookie: adminCookie } });

  test("the legacy admin role was seeded as grants, not left as a string", () => {
    const caps = held("admin");
    expect(caps).toContain("key.approve");
    expect(caps).toContain("agent.teardown");
    expect(caps).toContain("audit.read.metadata");
    // Deliberately the full set: narrowing it during the migration would be a
    // silent permission change dressed as a refactor.
    expect(caps).toContain("audit.read.content");
  });

  test("revoking a grant takes effect on the next request, not at token expiry", async () => {
    // The reason the answer is not in the JWT. This cookie is issued once and
    // never refreshed; if it carried the decision, this would keep working —
    // and the one moment revocation matters is an incident.
    expect((await asAdmin("/api/v1/admin/keys/pending")).status).toBe(200);

    revoke("admin", "key.approve");
    const after = await asAdmin("/api/v1/admin/keys/pending");
    expect(after.status).toBe(403);
    // Names the missing grant. An operator told which one can ask for that
    // one; an operator told "forbidden" asks for everything.
    expect((await after.json()).capability).toBe("key.approve");

    grant("admin", "key.approve");
    expect((await asAdmin("/api/v1/admin/keys/pending")).status).toBe(200);
  });

  test("capabilities are separate — losing one does not lose the others", async () => {
    // § 11's privacy boundary is exactly this: the platform operator holds
    // metadata and not content. If the routes shared one check, that split
    // could not exist.
    revoke("admin", "inbox.read.depth");
    expect((await asAdmin("/api/v1/admin/inbox")).status).toBe(403);
    expect((await asAdmin("/api/v1/admin/keys/pending")).status).toBe(200);
    grant("admin", "inbox.read.depth");
  });

  test("no session is still 401, not 403", async () => {
    // Unauthenticated and unauthorised are different answers: one says sign
    // in, the other says ask for a grant.
    expect((await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`)).status).toBe(401);
  });
});

/**
 * SPEC § 8.11 read side. Built to the shape `platform-fe-antigravity` needed
 * (mail #171) — screen design first, then the route to fit it, which is the
 * order that avoids an API nobody can draw.
 */
describe("the observed sources are readable by an operator", () => {
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = new Database(join(mesh.stateDir, "agents.db"));
    try { return fn(db); } finally { db.close(); }
  };
  const asAdmin = (path: string) =>
    fetch(`${mesh.http.url}${path}`, { headers: { cookie: adminCookie } });

  test("rows come back, and the deployment mode comes with them", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "asrc-one", "ai-claude", null, kp.publicKey);
    await decide("approve", kp.fingerprint);
    await callHttp(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey }, "mesh.list_agents", {});

    const body = await (await asAdmin("/api/v1/admin/agent-sources?identity=asrc-one")).json();
    expect(body.ok).toBe(true);
    expect(body.sources.map((s: any) => s.observed)).toContain("127.0.0.1");
    // The mode is read from the hub that is answering, not from a constant in
    // this process — the two are configured separately.
    expect(body.observed_source).toBe("socket");
    expect(body.evidence_note).toContain("kernel-observed");
  });

  test("the mode is not a per-row column, because it cannot vary per row", async () => {
    // A column would suggest a distinction that does not exist, and an
    // operator would read evidence into rows that have none.
    const body = await (await asAdmin("/api/v1/admin/agent-sources")).json();
    expect(Array.isArray(body.sources)).toBe(true);
    for (const row of body.sources) {
      expect(Object.keys(row).sort()).toEqual(
        ["first_seen", "identity", "last_seen", "observed", "requests"],
      );
    }
  });

  test("it has its own capability, not audit.read.metadata", async () => {
    // Where every agent runs is a network fact about someone's hosts. An
    // operator entitled to a trail is not automatically entitled to that.
    withDb((db) => db.prepare(`DELETE FROM role_grants WHERE subject='admin' AND capability='source.read'`).run());
    const refused = await asAdmin("/api/v1/admin/agent-sources");
    expect(refused.status).toBe(403);
    expect((await refused.json()).capability).toBe("source.read");
    // The audit trail is a different grant and must still answer.
    expect((await asAdmin("/api/v1/audit/events")).status).toBe(200);
    withDb((db) => db.prepare(
      `INSERT INTO role_grants (tenant,subject,capability,scope,granted_by)
       VALUES ('default','admin','source.read','*','test') ON CONFLICT DO NOTHING`).run());
  });

  test("a malformed identity is refused rather than matched", async () => {
    expect((await asAdmin("/api/v1/admin/agent-sources?identity=../etc")).status).toBe(400);
  });
});

/**
 * SPEC § 11.3. Ownership, and the queue that scopes to it.
 *
 * The store-level races are covered in `packages/store/src/ownership.test.ts`.
 * What is here is the part that only shows up over the wire: an operator with
 * no agents must see an **empty queue**, not a refusal, and the two are easy
 * to conflate in a route that filters after a permission check.
 */
describe("ownership scopes what an operator sees", () => {
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = new Database(join(mesh.stateDir, "agents.db"));
    try { return fn(db); } finally { db.close(); }
  };
  const grantTo = (subject: string, capability: string, scope = "*") =>
    withDb((db) => db.prepare(
      `INSERT INTO role_grants (tenant,subject,capability,scope,granted_by)
       VALUES ('default',?,?,?,'test') ON CONFLICT DO NOTHING`).run(subject, capability, scope));
  const login = async (u: string) => {
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `username=${u}&password=admin`, redirect: "manual",
    });
    return res.headers.get("set-cookie")?.split(";")[0] ?? null;
  };

  test("a pairing code is issued, redeemed once, and establishes ownership", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "own-lane", "ai-claude", null, kp.publicKey);

    const issued = await fetch(`${mesh.http.url}/api/v1/admin/pairing-codes`, {
      method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ identity: "own-lane" }),
    });
    expect(issued.status).toBe(201);
    const { code } = await issued.json();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    // Redemption is unauthenticated: the CLI runs on the agent's host and
    // holds no human session. The code is the credential.
    const redeemed = await fetch(`${mesh.http.url}/api/v1/pairing-codes/redeem`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, owner: "admin" }),
    });
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json()).identity).toBe("own-lane");

    const again = await fetch(`${mesh.http.url}/api/v1/pairing-codes/redeem`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, owner: "mallory" }),
    });
    expect(again.status).toBe(409);
    expect((await again.json()).reason).toBe("already-redeemed");

    const listed = await (await fetch(`${mesh.http.url}/api/v1/admin/agents/own-lane/owners`, {
      headers: { cookie: adminCookie },
    })).json();
    expect(listed.owners.map((o: any) => o.owner)).toEqual(["admin"]);
    // How the claim was made is part of the record.
    expect(listed.owners[0].granted_by).toContain("pairing:");
  });

  test("an unknown code is 404 and a bad body is 400", async () => {
    const post = (b: unknown) => fetch(`${mesh.http.url}/api/v1/pairing-codes/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
    });
    expect((await post({ code: "ZZZZ-ZZZZ-ZZZZ", owner: "x" })).status).toBe(404);
    expect((await post({ owner: "x" })).status).toBe(400);
  });

  test("a tenant-wide grant is not filtered — that is what being inside the tenant means", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "own-visible", "ai-claude", null, kp.publicKey);
    const body = await (await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, {
      headers: { cookie: adminCookie },
    })).json();
    expect(body.pending.map((k: any) => k.identity)).toContain("own-visible");
  });

  test("a scoped operator sees only what they own — and reaching the route at all is the point", async () => {
    // Two things at once, because they fail as one. A scoped grant must not be
    // refused (§ 11.3: the answer is an empty or filtered list, never `403`),
    // and what comes back must be their own agents rather than everyone's.
    const owned = newKeyPair();
    const notOwned = newKeyPair();
    await provision(mesh.hub, "own-mine", "ai-claude", null, owned.publicKey);
    await provision(mesh.hub, "own-theirs", "ai-claude", null, notOwned.publicKey);
    withDb((db) => db.prepare(
      `INSERT INTO agent_owners (tenant,identity,owner,granted_by)
       VALUES ('default','own-mine','admin','test') ON CONFLICT DO NOTHING`).run());

    // Narrow the grant: `admin` now holds key.approve on one identity only.
    withDb((db) => db.prepare(
      `DELETE FROM role_grants WHERE subject='admin' AND scope='*' AND capability='key.approve'`).run());
    grantTo("admin", "key.approve", "own-mine");

    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, { headers: { cookie: adminCookie } });
    // Not 403. Gating this at tenant scope would refuse every operator who
    // holds only their own agents, which is the failure this route is about.
    expect(res.status).toBe(200);
    const identities = (await res.json()).pending.map((k: any) => k.identity);
    expect(identities).toContain("own-mine");
    expect(identities).not.toContain("own-theirs");

    grantTo("admin", "key.approve", "*");
  });

  test("what I own answers about me, and a tenant-wide grant does not widen it", async () => {
    // "Everything in the tenant" is not an answer to "what is mine". The
    // screen asking is the approval queue's empty state, where owning nothing
    // and having nothing pending are different situations with different next
    // actions.
    withDb((db) => db.prepare(
      `INSERT INTO agent_owners (tenant,identity,owner,granted_by)
       VALUES ('default','owned-a','admin','test') ON CONFLICT DO NOTHING`).run());
    withDb((db) => db.prepare(
      `INSERT INTO agent_owners (tenant,identity,owner,granted_by)
       VALUES ('default','owned-b','someone-else','test') ON CONFLICT DO NOTHING`).run());

    const body = await (await fetch(`${mesh.http.url}/api/v1/admin/agents/owned`, {
      headers: { cookie: adminCookie },
    })).json();
    expect(body.owner).toBe("admin");
    expect(body.identities).toContain("owned-a");
    // `admin` holds key.approve at `*`, and still must not be told it owns
    // someone else's agent.
    expect(body.identities).not.toContain("owned-b");
  });

  test("holding the capability at no scope at all is still 403", async () => {
    // The other side of the line. Filtered-to-empty and not-permitted are
    // different answers and must not collapse into one.
    withDb((db) => db.prepare(`DELETE FROM role_grants WHERE subject='admin' AND capability='key.approve'`).run());
    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(403);
    expect((await res.json()).capability).toBe("key.approve");
    grantTo("admin", "key.approve", "*");
  });
});

/**
 * SPEC § 11.3. Teardown reaches what you own, and no further.
 *
 * § 9.3 is irreversible — the name is never usable again — so a teardown that
 * reaches one identity too far cannot be undone. Every test here is about the
 * boundary rather than the operation.
 */
describe("teardown is scoped", () => {
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = new Database(join(mesh.stateDir, "agents.db"));
    try { return fn(db); } finally { db.close(); }
  };
  const setGrant = (capability: string, scope: string | null) => withDb((db) => {
    db.prepare(`DELETE FROM role_grants WHERE subject='admin' AND capability=?`).run(capability);
    if (scope) {
      db.prepare(`INSERT INTO role_grants (tenant,subject,capability,scope,granted_by)
                  VALUES ('default','admin',?,?,'test')`).run(capability, scope);
    }
  });
  const own = (identity: string, owner = "admin") => withDb((db) =>
    db.prepare(`INSERT INTO agent_owners (tenant,identity,owner,granted_by)
                VALUES ('default',?,?,'test') ON CONFLICT DO NOTHING`).run(identity, owner));
  const del = (identity: string) =>
    fetch(`${mesh.http.url}/api/v1/admin/agents/${identity}`, {
      method: "DELETE", headers: { cookie: adminCookie },
    });

  test("an owner with a scoped grant may tear down their own", async () => {
    await provision(mesh.hub, "td-mine", "service");
    own("td-mine");
    setGrant("agent.teardown", "td-mine");
    expect((await del("td-mine")).status).toBe(200);
    setGrant("agent.teardown", "*");
  });

  test("a grant scoped to one identity reaches it without ownership", async () => {
    // Distinguishes the two paths. The capability scoped to this identity is
    // sufficient on its own; the ownership fallback is for a broader grant
    // plus "it is mine". Without this the two overlap and a tenant-scope gate
    // passes the suite while refusing every scoped operator.
    await provision(mesh.hub, "td-scoped", "service");
    setGrant("agent.teardown", "td-scoped");
    expect(withDb((db) => db.prepare(
      `SELECT count(*) c FROM agent_owners WHERE identity='td-scoped'`).get() as any).c).toBe(0);
    expect((await del("td-scoped")).status).toBe(200);
    setGrant("agent.teardown", "*");
  });

  test("and may not reach one they do not own", async () => {
    // The failure that cannot be undone. A grant scoped to one identity must
    // not answer for another.
    await provision(mesh.hub, "td-theirs", "service");
    own("td-theirs", "someone-else");
    setGrant("agent.teardown", "td-mine");
    const res = await del("td-theirs");
    expect(res.status).toBe(403);
    expect((await res.json()).capability).toBe("agent.teardown");
    // Still alive.
    expect((await (await fetch(`${mesh.hub.url}/api/v1/agents/td-theirs/keys`)).json()).deleted).toBe(false);
    setGrant("agent.teardown", "*");
  });

  test("ownership alone is not enough — the capability is still required", async () => {
    // Owning an agent says who is answerable for it, not that this person may
    // destroy it. A deployment can grant one without the other.
    await provision(mesh.hub, "td-owned-nocap", "service");
    own("td-owned-nocap");
    setGrant("agent.teardown", null);
    expect((await del("td-owned-nocap")).status).toBe(403);
    setGrant("agent.teardown", "*");
  });

  test("a tenant-wide grant still reaches everything", async () => {
    await provision(mesh.hub, "td-anywhere", "service");
    expect((await del("td-anywhere")).status).toBe(200);
  });

  test("a malformed name is 400 before anything is authorised", async () => {
    // Not a scope anything could have been granted over, so asking the grant
    // table about it would answer a question with no meaning.
    const res = await fetch(`${mesh.http.url}/api/v1/admin/agents/..%2Fetc`, {
      method: "DELETE", headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(400);
  });
});

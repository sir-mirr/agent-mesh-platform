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

import { connectRpc, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh } from "./harness";

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

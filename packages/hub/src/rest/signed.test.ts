/**
 * Authenticating a signed REST request (SPEC § 9.2.1), in this process.
 *
 * The order is the property, and three steps of it had never run where a
 * coverage report can see them: freshness is decided **before** the nonce is
 * recorded, or anyone can fill the replay window with nonces that were never
 * going to be accepted; the nonce is **spent** whether or not what follows
 * succeeds, or a captured request is replayable until it works; and § 14's
 * budget is taken **after** the signature verifies, because the work is
 * bounded by the caller's key rather than by their bandwidth.
 *
 * `test/ratelimit.test.ts` drives the last of those over a real socket, which
 * proves the wiring and instruments none of it — the hub is a separate
 * process there.
 *
 * This file owns the `sg-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";

import {
  SIGNATURE_FRESHNESS_WINDOW_SECONDS,
  formatRestAuthorization,
  restSignaturePreimage,
} from "@agent-mesh/contracts";
import { keys } from "@agent-mesh/store";

import { agentsDb } from "../db";
import { SIGNED_LIMIT } from "../ratelimit";
import { authenticate } from "./signed";

let n = 0;
const uniq = (p: string) => `sg-${p}-${++n}-${process.pid}`;

/** An identity whose type requires a key, holding one the hub has approved. */
function signer(approve = true) {
  const type = "sg-signing";
  agentsDb.prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES (?, 1)`).run(type);
  const identity = uniq("caller");
  agentsDb.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, ?)`).run(identity, type);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  const { fingerprint } = keys.proposeKey(agentsDb, identity, raw, "sg-test");
  if (approve) keys.approveKey(agentsDb, fingerprint, "sg-test");
  return { identity, fingerprint, privateKey };
}

const now = () => Math.floor(Date.now() / 1000);

/** The header a caller must build, with any part of it overridable. */
function header(
  who: ReturnType<typeof signer>,
  over: Partial<{ method: string; path: string; nonce: string; iat: number; body: string; signAs: Partial<{ method: string; path: string; nonce: string; iat: number }> }> = {},
): { value: string; method: string; path: string; body: string } {
  const method = over.method ?? "GET";
  const path = over.path ?? "/api/v1/agents";
  const nonce = over.nonce ?? randomUUID();
  const iat = over.iat ?? now();
  const body = over.body ?? "";
  const signature = edSign(
    null,
    Buffer.from(
      restSignaturePreimage({
        method: over.signAs?.method ?? method,
        path: over.signAs?.path ?? path,
        kid: who.fingerprint,
        nonce: over.signAs?.nonce ?? nonce,
        iat: over.signAs?.iat ?? iat,
        bodySha256: "",
      }),
    ),
    who.privateKey,
  ).toString("base64url");
  return { value: formatRestAuthorization({ kid: who.fingerprint, nonce, iat, signature }), method, path, body };
}

const run = (h: ReturnType<typeof header>, observed: string | null = null) =>
  authenticate(h.method, h.path, h.value, h.body, observed);

/** Spend this identity's whole § 14 budget, however wide the deployment set it. */
function drain(identity: string): number {
  let spent = 0;
  while (SIGNED_LIMIT.take(identity).ok) spent++;
  return spent;
}

describe("what a signed request is refused for", () => {
  test("no authorization at all", () => {
    const r = authenticate("GET", "/api/v1/agents", null, "");

    expect(r.ok).toBe(false);
    expect((r as any).refusal.status).toBe(401);
    expect((r as any).refusal.body.code).toBe("SIGNATURE_INVALID");
  });

  test("a header that is not the scheme", () => {
    const r = authenticate("GET", "/api/v1/agents", "Bearer a-session-token", "");

    expect((r as any).refusal.body.error).toContain("malformed");
  });

  /**
   * **Before the nonce is recorded.** Deciding freshness afterwards lets anyone
   * fill the replay window with nonces that were never going to be accepted.
   */
  test("an iat outside the freshness window, in either direction", () => {
    const who = signer();
    const stale = header(who, { iat: now() - SIGNATURE_FRESHNESS_WINDOW_SECONDS - 5 });
    const ahead = header(who, { iat: now() + SIGNATURE_FRESHNESS_WINDOW_SECONDS + 5 });

    for (const h of [stale, ahead]) {
      const r = run(h);
      expect((r as any).refusal.status).toBe(401);
      expect((r as any).refusal.body.error).toContain("freshness window");
    }
  });

  test("a stale nonce is not spent, so the same one still works when it is fresh", () => {
    const who = signer();
    const nonce = randomUUID();
    run(header(who, { nonce, iat: now() - SIGNATURE_FRESHNESS_WINDOW_SECONDS - 5 }));

    expect(run(header(who, { nonce })).ok).toBe(true);
  });

  test("a nonce already seen in this window", () => {
    const who = signer();
    const nonce = randomUUID();
    expect(run(header(who, { nonce })).ok).toBe(true);

    const r = run(header(who, { nonce }));

    expect((r as any).refusal.status).toBe(401);
    expect((r as any).refusal.body.error).toContain("nonce already seen");
  });

  /**
   * **Spent before the signature is checked**, so a captured request has one
   * attempt whatever else is wrong with it. Recording only on success would
   * leave it replayable without limit.
   */
  test("a nonce is spent even by a request whose signature does not verify", () => {
    const who = signer();
    const nonce = randomUUID();
    const forged = run(header(who, { nonce, signAs: { path: "/api/v1/somewhere-else" } }));
    expect((forged as any).refusal.body.error).toContain("does not verify");

    const r = run(header(who, { nonce }));

    expect((r as any).refusal.body.error).toContain("nonce already seen");
  });

  test("a fingerprint no approved key answers to", () => {
    const who = signer(false);

    const r = run(header(who));

    expect((r as any).refusal.status).toBe(403);
    expect((r as any).refusal.body.code).toBe("KEY_NOT_APPROVED");
    // The status, never the holder's name: reporting the identity would build
    // the key-to-identity lookup the contract deliberately lacks.
    expect((r as any).refusal.body.key_status).toBe("pending");
    expect(JSON.stringify((r as any).refusal.body)).not.toContain(who.identity);
  });

  test("a signature over a different method or path", () => {
    const who = signer();

    for (const over of [{ signAs: { method: "DELETE" } }, { signAs: { path: "/api/v1/agents?peer=elsewhere" } }]) {
      const r = run(header(who, over));
      expect((r as any).refusal.status).toBe(401);
      expect((r as any).refusal.body.error).toContain("does not verify");
    }
  });

  /**
   * § 14, keyed on the verified identity rather than on the address: the caller
   * has already produced a signature the hub checked, so the work is bounded by
   * their key. The budget is taken after that check, not before it.
   */
  test("a caller over its § 14 budget, with how long to wait", () => {
    const who = signer();
    drain(who.identity);

    const r = run(header(who));

    expect((r as any).refusal.status).toBe(429);
    expect((r as any).refusal.body.code).toBe("RATE_LIMITED");
    expect((r as any).refusal.body.retry_after).toBeGreaterThan(0);
  });

  test("the budget is not spent by a request that never verified", () => {
    const who = signer();
    run(header(who, { signAs: { path: "/api/v1/elsewhere" } }));

    // The same budget as an identity that was never refused anything. Off by
    // one at most: the bucket refills over the time the two loops take.
    const spent = drain(who.identity);
    const untouched = drain(uniq("never-called"));
    expect(Math.abs(spent - untouched)).toBeLessThanOrEqual(1);
  });
});

describe("what a verified caller gets", () => {
  test("its identity and the key that spoke for it", () => {
    const who = signer();

    const r = run(header(who));

    expect(r).toEqual({ ok: true, caller: { identity: who.identity, kid: who.fingerprint } });
  });

  test("the address it was seen on is recorded, § 8.11", () => {
    const who = signer();

    run(header(who), "198.51.100.22");

    const rows = agentsDb
      .prepare("SELECT observed FROM agent_sources WHERE identity = ?")
      .all(who.identity) as Array<{ observed: string }>;
    expect(rows.map((r) => r.observed)).toEqual(["198.51.100.22"]);
  });

  test("a refused request records no source for the identity it merely named", () => {
    const who = signer();

    run(header(who, { signAs: { path: "/api/v1/elsewhere" } }), "198.51.100.23");

    const rows = agentsDb
      .prepare("SELECT observed FROM agent_sources WHERE identity = ?")
      .all(who.identity) as Array<{ observed: string }>;
    expect(rows).toEqual([]);
  });

  test("a POST is verified over the body it carried", () => {
    const who = signer();
    const h = header(who, { method: "POST", path: "/api/v1/agents", body: "" });

    expect(run(h).ok).toBe(true);
    expect(authenticate("POST", h.path, h.value, '{"changed":true}').ok).toBe(false);
  });
});

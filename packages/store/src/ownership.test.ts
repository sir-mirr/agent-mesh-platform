/**
 * SPEC § 11.3. The tests that matter are the redemption races and the ones
 * about what a refused claim leaves behind.
 *
 * A pairing code that fails to work is noticed immediately — someone cannot
 * onboard. A code that works **twice** is silent: both parties believe they
 * own the agent, and nothing in either session says otherwise.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAt } from "./open";
import * as ownership from "./ownership";

function db() {
  const d = openAt(join(mkdtempSync(join(tmpdir(), "own-")), "t.db"), { create: true });
  ownership.migrate(d);
  return d;
}

describe("pairing codes", () => {
  test("a redeemed code establishes ownership and records where from", () => {
    const d = db();
    const c = ownership.issueCode(d, { identity: "lane-a", issuedBy: "alice", ttlSeconds: 300 });
    expect(ownership.redeem(d, c.code, "alice", "203.0.113.7")).toEqual({
      ok: true, identity: "lane-a", owner: "alice",
    });
    expect(ownership.isOwner(d, "alice", "lane-a")).toBe(true);

    // § 8.11's observed half, captured at the one moment we know both the
    // agent's host and the person vouching for it.
    const row = d.prepare(`SELECT redeemed_from FROM pairing_codes WHERE code = ?`)
      .get(c.code) as { redeemed_from: string };
    expect(row.redeemed_from).toBe("203.0.113.7");
    d.close();
  });

  test("a code is single-use, and the second attempt says so specifically", () => {
    // Not just "invalid". "Somebody already used this" and "ask for another"
    // call for different reactions.
    const d = db();
    const c = ownership.issueCode(d, { identity: "lane-b", issuedBy: "alice", ttlSeconds: 300 });
    expect(ownership.redeem(d, c.code, "alice", null).ok).toBe(true);
    expect(ownership.redeem(d, c.code, "mallory", null)).toEqual({
      ok: false, reason: "already-redeemed",
    });
    // And the loser takes nothing.
    expect(ownership.isOwner(d, "mallory", "lane-b")).toBe(false);
    d.close();
  });

  test("an expired code is refused, and is distinguishable from a spent one", () => {
    const d = db();
    const c = ownership.issueCode(d, { identity: "lane-c", issuedBy: "alice", ttlSeconds: -1 });
    expect(ownership.redeem(d, c.code, "alice", null)).toEqual({ ok: false, reason: "expired" });
    expect(ownership.owners(d, "lane-c")).toHaveLength(0);
    d.close();
  });

  test("an unknown code is refused without revealing whether one exists", () => {
    const d = db();
    expect(ownership.redeem(d, "ZZZZ-ZZZZ-ZZZZ", "alice", null)).toEqual({
      ok: false, reason: "unknown",
    });
    d.close();
  });

  test("the redeemed row survives, because it is the provenance of the claim", () => {
    // Deleting the code after use would throw away the only record of how the
    // ownership was established.
    const d = db();
    const c = ownership.issueCode(d, { identity: "lane-d", issuedBy: "bob", ttlSeconds: 300 });
    ownership.redeem(d, c.code, "bob", "198.51.100.9");
    const row = d.prepare(`SELECT issued_by, redeemed_at FROM pairing_codes WHERE code = ?`)
      .get(c.code) as { issued_by: string; redeemed_at: string };
    expect(row.issued_by).toBe("bob");
    expect(row.redeemed_at).not.toBeNull();
    d.close();
  });

  test("codes avoid characters that are misread aloud", () => {
    // They are read out or retyped. `I`/`1` and `O`/`0` are where that goes
    // wrong, and a failed claim is indistinguishable from a stolen code.
    const d = db();
    for (let i = 0; i < 40; i++) {
      const c = ownership.issueCode(d, { identity: `x${i}`, issuedBy: "a", ttlSeconds: 60 });
      expect(c.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    d.close();
  });
});

describe("ownership", () => {
  test("owners are plural, so a departure does not strand the agent", () => {
    const d = db();
    ownership.assign(d, { identity: "lane-e", owner: "alice", grantedBy: "tenant-admin" });
    ownership.assign(d, { identity: "lane-e", owner: "bob", grantedBy: "tenant-admin" });
    expect(ownership.owners(d, "lane-e").map((o) => o.owner)).toEqual(["alice", "bob"]);
    ownership.unassign(d, { identity: "lane-e", owner: "alice" });
    expect(ownership.isOwner(d, "bob", "lane-e")).toBe(true);
    d.close();
  });

  test("ownership does not leak across identities", () => {
    const d = db();
    ownership.assign(d, { identity: "lane-f", owner: "alice", grantedBy: "t" });
    expect(ownership.isOwner(d, "alice", "lane-g")).toBe(false);
    d.close();
  });

  test("ownership does not leak across tenants", () => {
    const d = db();
    ownership.assign(d, { tenant: "acme", identity: "lane-h", owner: "alice", grantedBy: "t" });
    expect(ownership.isOwner(d, "alice", "lane-h", "acme")).toBe(true);
    expect(ownership.isOwner(d, "alice", "lane-h", "nova")).toBe(false);
    d.close();
  });

  test("ownedBy answers what a scoped queue should show", () => {
    // The screen that changes: an operator's approval queue is their agents,
    // and someone with none sees an empty queue rather than a refusal.
    const d = db();
    ownership.assign(d, { identity: "lane-i", owner: "alice", grantedBy: "t" });
    ownership.assign(d, { identity: "lane-j", owner: "alice", grantedBy: "t" });
    ownership.assign(d, { identity: "lane-k", owner: "bob", grantedBy: "t" });
    expect(ownership.ownedBy(d, "alice")).toEqual(["lane-i", "lane-j"]);
    expect(ownership.ownedBy(d, "carol")).toEqual([]);
    d.close();
  });
});

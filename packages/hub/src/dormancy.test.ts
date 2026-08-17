/**
 * SPEC § 8.11.2. Pure logic, driven directly — the wire-level path needs a
 * three-hour wait or a mesh started with an overridden window, and this is the
 * part where the conditions are decided.
 *
 * Every test here is about **not** refusing. The refusal is one line; the
 * value of the mechanism is entirely in how rarely it fires on someone
 * legitimate, because a control that cries wolf gets switched off.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsSchema, openAt, sources } from "@agent-mesh/store";

import { checkDormantSource, DORMANCY_SECONDS } from "./dormancy";

function db() {
  const d = openAt(join(mkdtempSync(join(tmpdir(), "dorm-")), "a.db"), { create: true });
  agentsSchema.migrate(d);
  return d;
}
/** A send that happened `seconds` ago. */
function sentAgo(d: ReturnType<typeof db>, identity: string, seconds: number) {
  d.prepare(`INSERT INTO agents (identity, type) VALUES (?, 'ai-claude') ON CONFLICT DO NOTHING`).run(identity);
  d.prepare(`UPDATE agents SET last_send_at = datetime('now', ? || ' seconds') WHERE identity = ?`)
    .run(`-${seconds}`, identity);
}
const seen = (d: ReturnType<typeof db>, identity: string, addr: string) =>
  sources.recordSource(d, identity, addr);

describe("when it refuses", () => {
  test("dormant, and from a network never seen", () => {
    const d = db();
    sentAgo(d, "a", DORMANCY_SECONDS + 60);
    seen(d, "a", "203.0.113.10");
    const r = checkDormantSource(d, "a", "a", "198.51.100.10");
    expect(r.refusal?.code).toBe(-32017);
    expect(r.refusal?.data.code).toBe("SOURCE_CHANGED");
    // The prefix, not the address: an operator needs the unit the decision was
    // made in, and the full address is already in `agent_sources`.
    expect(r.refusal?.data.observed_prefix).toBe("198.51.100.0/24");
    d.close();
  });
});

describe("when it must not refuse", () => {
  test("a different address inside the same /24 — the churn with no meaning", () => {
    // A cloud instance restarting, or a DHCP renewal. `exact` fires on both,
    // and an operator who is paged for those turns the control off.
    const d = db();
    sentAgo(d, "b", DORMANCY_SECONDS + 60);
    seen(d, "b", "203.0.113.10");
    expect(checkDormantSource(d, "b", "b", "203.0.113.200").refusal).toBeNull();
    d.close();
  });

  test("a new network, but the identity is not dormant", () => {
    // Someone sending every few minutes has an owner who would notice a second
    // sender. Dormancy is the whole trigger.
    const d = db();
    sentAgo(d, "c", 30);
    seen(d, "c", "203.0.113.10");
    expect(checkDormantSource(d, "c", "c", "198.51.100.10").refusal).toBeNull();
    d.close();
  });

  test("a proxied send, because the address observed is the proxy's", () => {
    // `sent_by: http-server` is identical for every web send. Comparing it
    // would refuse on the proxy's history and never on the sender's.
    const d = db();
    sentAgo(d, "alice", DORMANCY_SECONDS + 60);
    seen(d, "alice", "203.0.113.10");
    expect(checkDormantSource(d, "alice", "http-server", "198.51.100.10").refusal).toBeNull();
    d.close();
  });

  test("an identity that has never sent", () => {
    // Nothing to be silent relative to. Refusing here would make this a
    // barrier to onboarding rather than to theft.
    const d = db();
    d.prepare(`INSERT INTO agents (identity, type) VALUES ('d', 'ai-claude')`).run();
    expect(checkDormantSource(d, "d", "d", "198.51.100.10").refusal).toBeNull();
    d.close();
  });

  test("an identity with no recorded source", () => {
    const d = db();
    sentAgo(d, "e", DORMANCY_SECONDS + 60);
    expect(checkDormantSource(d, "e", "e", "198.51.100.10").refusal).toBeNull();
    d.close();
  });

  test("no observation at all — 'we could not tell' is not 'somewhere new'", () => {
    const d = db();
    sentAgo(d, "f", DORMANCY_SECONDS + 60);
    seen(d, "f", "203.0.113.10");
    expect(checkDormantSource(d, "f", "f", null).refusal).toBeNull();
    d.close();
  });

  test("a second known network, because an agent may legitimately run in two", () => {
    const d = db();
    sentAgo(d, "g", DORMANCY_SECONDS + 60);
    seen(d, "g", "203.0.113.10");
    seen(d, "g", "198.51.100.10");
    expect(checkDormantSource(d, "g", "g", "198.51.100.77").refusal).toBeNull();
    d.close();
  });
});

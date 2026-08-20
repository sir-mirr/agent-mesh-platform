/**
 * Deleting something absent is not an error (SPEC § 9.2a).
 *
 * One clause, four delete routes, and before this file four different answers:
 * `egress` said `404` with `ok: true` — a status and a body disagreeing about
 * one call — `grants` said `removed: true`, `agent-types` said
 * `action: "removed"`, and teardown said `action: "soft-deleted"`. Every one of
 * them had a passing test, because each test asserted what its own route
 * happened to do. `agent-mesh-local-pm` found the first of the four by holding
 * the clause against the running stack rather than against the tests
 * (mail #1556).
 *
 * So this file does not test a route. It derives the list of routes from the
 * source and refuses to run until every one of them is accounted for here —
 * the next delete route added to `main.ts` fails this file until its absent
 * case is written down, which is the only form of this test that keeps being
 * true after the person who wrote it has stopped looking.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loginAsAdmin, startMesh, type Mesh } from "./harness";

const SOURCE = join(import.meta.dir, "..", "packages", "http", "src", "main.ts");

/** Every `app.delete('…')` in the http service, read out of the source. */
function declaredDeleteRoutes(): string[] {
  return [...readFileSync(SOURCE, "utf8").matchAll(/app\.delete\(\s*'([^']+)'/g)]
    .map((m) => m[1]!);
}

/**
 * How to aim each route at something that is not there.
 *
 * Named identities rather than a generated one: the point is a target that
 * cannot exist, and a name saying so survives being read a year from now.
 */
const ABSENT: Record<string, { path: string; body?: unknown }> = {
  "/api/v1/admin/groups/:group_id/egress/:to_group": {
    path: "/api/v1/admin/groups/absence-probe-src/egress/absence-probe-dst",
  },
  "/api/v1/admin/grants": {
    // The only one of the four that carries its target in a body.
    path: "/api/v1/admin/grants",
    body: { subject: "absence-probe-nobody", capability: "key.approve" },
  },
  "/api/v1/admin/agent-types/:type": {
    path: "/api/v1/admin/agent-types/absence-probe-type",
  },
  "/api/v1/admin/agents/:identity": {
    path: "/api/v1/admin/agents/absence-probe-agent",
  },
};

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
});
afterAll(() => mesh?.stop());

describe("deleting something absent", () => {
  test("every delete route in the source is accounted for here", () => {
    const declared = declaredDeleteRoutes();
    // A floor as well as a match: a regex that stopped matching would make the
    // set comparison pass against an empty list, which is the failure mode of
    // every test that derives its own subject.
    expect(declared.length).toBeGreaterThanOrEqual(4);
    expect(declared.filter((r) => !(r in ABSENT))).toEqual([]);
    expect(Object.keys(ABSENT).filter((r) => !declared.includes(r))).toEqual([]);
  });

  for (const [route, aim] of Object.entries(ABSENT)) {
    test(`${route} answers 200 and says which happened`, async () => {
      const res = await fetch(`${mesh.http.url}${aim.path}`, {
        method: "DELETE",
        headers: { cookie, "content-type": "application/json" },
        ...(aim.body ? { body: JSON.stringify(aim.body) } : {}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.action).toBe("not-found");
      // `removed` was the other half of the drift: two names for one outcome
      // means a caller reading either one can never be wrong, and a route
      // answering neither can never be caught.
      expect(body).not.toHaveProperty("removed");
    });
  }
});

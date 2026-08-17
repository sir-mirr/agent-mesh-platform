/**
 * § 9.1 — the two auth rules, applied to every route rather than to a sample.
 *
 * > Unauthenticated access to any non-public route MUST return `401`.
 * > Insufficient role for a `JWT*` route MUST return `403`.
 *
 * These were covered by three spot checks. A missing guard on any one route is
 * invisible by construction — the route works, so nothing fails — and spot
 * checks find it only if the spot happened to be the hole. So this drives the
 * § 9.1 table itself: adding a route to the SPEC without a guard fails here,
 * and so does adding a guard the SPEC did not ask for.
 *
 * The route list is parsed out of SPEC.md rather than restated, because a
 * restated list is a second copy that goes stale the first time the table
 * changes — and it would go stale *silently*, since a route dropped from the
 * copy is simply a route this stops testing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createHmac } from "node:crypto";

import { loginAsAdmin, startMesh, type Mesh } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

type Auth = "None" | "JWT" | "JWT*" | "JWT †" | "JWT ¶" | "Token" | "Sig";

interface Route {
  method: string;
  path: string;
  auth: Auth;
}

/**
 * The § 9.1 route table, read from the document.
 *
 * `‡`, `§` and `*` are footnote markers in the Auth column; they carry meaning
 * (`JWT*` is admin-only) so they are kept, and only the escaping is stripped.
 */
function routesFromSpec(): Route[] {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const start = spec.indexOf("### 9.1.");
  const end = spec.indexOf("### 9.2.");
  const table = spec.slice(start, end);

  const routes: Route[] = [];
  for (const line of table.split("\n")) {
    // Trailing prose after the backticked path is allowed — `(SSE)` follows one
    // of them. A regex that required the cell to end at the backtick dropped
    // that row silently, which is a route this stops sweeping rather than a
    // failure anyone would see.
    const m = /^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`[^|]*\|\s*([^|]+)\|/.exec(line);
    if (!m) continue;
    const auth = m[3]!.replace(/\\/g, "").replace(/[‡§]/g, "").trim();
    routes.push({ method: m[1]!, path: m[2]!.replace(/\s*\(SSE\)\s*/, ""), auth: auth as Auth });
  }
  if (routes.length < 20) throw new Error(`only parsed ${routes.length} routes from § 9.1`);
  return routes;
}

/** A standard HS256 JWT. */
function hs256(claims: Record<string, unknown>, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ ...claims, iat: now, exp: now + 3600 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/**
 * `JWT` routes that gate on approval — every one except `/auth/me`, which
 * answers `approved: false` instead of refusing (§ 9.1 ¶). It is how a client
 * discovers it is pending, so it is not part of the refusal rule.
 */
function ordinaryJwtRoutes(): Route[] {
  return routesFromSpec().filter((r) => r.auth === "JWT" || r.auth === "JWT †");
}

/** Concrete path for a route template, with the parameters filled in. */
function concrete(path: string): string {
  return path
    .replace(/:agentId/g, "someone")
    .replace(/:agent\b/g, "someone")
    .replace(/:id\b/g, "0".repeat(64))
    .replace(/\{key\}/g, "0".repeat(64))
    .replace(/\{event_id\}/g, "01900000-0000-7000-8000-000000000000");
}

let mesh: Mesh;
/** A signed, valid, non-admin session. Approval is a separate gate. */
let viewerCookie: string;
let adminCookie: string;

beforeAll(async () => {
  mesh = await startMesh();

  // A signed, valid, non-admin session, minted here rather than obtained by
  // logging in: the local login seeds only an admin, and a `403` test needs a
  // caller the server accepts and then refuses.
  //
  // Signed here rather than by importing the server's `signJwt`: the test
  // project cannot reach across the package boundary, and an independent HS256
  // is the better check anyway — it proves the server accepts a standard token
  // rather than only tokens its own encoder produced.
  //
  // It is also, necessarily, an *unapproved* user: a pending approval row is
  // created only by the GitHub OAuth callback, so an approved non-admin session
  // cannot be constructed in this harness at all. That is why the positive case
  // below uses the admin session.
  viewerCookie = `mesh_token=${hs256(
    { github_id: 7, github_login: "viewer", role: "user" },
    "integration-test-secret",
  )}`;
  adminCookie = await loginAsAdmin(mesh.http);
}, 60_000);

afterAll(() => mesh?.stop());

function token(cookie: string | undefined): string {
  return cookie?.replace(/^mesh_token=/, "") ?? "";
}

async function call(route: Route, headers: Record<string, string> = {}): Promise<number> {
  // The SSE route used to read its JWT from the query string and no longer
  // does — the cookie carries it, which is what `EventSource` sends anyway.
  // The special case is gone, and this sweep treating every route the same is
  // the evidence that it is.
  const credential = "";
  const res = await fetch(`${mesh.http.url}${concrete(route.path)}${credential}`, {
    method: route.method,
    headers: { "content-type": "application/json", ...headers },
    // A body for the methods that take one, so a route cannot answer 400
    // before it reaches its auth guard and look like a pass.
    ...(route.method === "GET" || route.method === "DELETE" ? {} : { body: "{}" }),
    redirect: "manual",
  });
  // Drain, so an SSE route does not hold the connection open past the test.
  try {
    await res.body?.cancel();
  } catch {}
  return res.status;
}

describe("§ 9.1 auth", () => {
  test("the SPEC table parses into the routes this sweeps", () => {
    const routes = routesFromSpec();
    expect(routes.length).toBeGreaterThanOrEqual(32);
    expect(new Set(routes.map((r) => r.auth))).toEqual(
      new Set(["None", "JWT", "JWT*", "JWT †", "JWT ¶", "Token", "Sig"]),
    );
  });

  test("no session is 401 on every non-public route", async () => {
    const guarded = routesFromSpec().filter((r) => r.auth.startsWith("JWT"));
    expect(guarded.length).toBeGreaterThan(10);

    const wrong: string[] = [];
    for (const route of guarded) {
      const status = await call(route);
      if (status !== 401) wrong.push(`${route.method} ${route.path} → ${status}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  test("a valid non-admin session is 403 on every admin route", async () => {
    // The distinction that matters: 401 says "who are you", 403 says "not you".
    // A route that answered 401 here would be telling an authenticated user
    // its session is invalid, and a route that answered 200 would be an
    // unguarded admin surface.
    const adminOnly = routesFromSpec().filter((r) => r.auth === "JWT*");
    expect(adminOnly.length).toBeGreaterThan(5);

    const wrong: string[] = [];
    for (const route of adminOnly) {
      const status = await call(route, { cookie: viewerCookie });
      if (status !== 403) wrong.push(`${route.method} ${route.path} → ${status}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  test("an approved session is not refused on ordinary JWT routes", async () => {
    // The other half. A guard that refused everyone would pass the test above
    // and break the product. The admin is the only approved principal this
    // harness can produce, and approval — not role — is what these routes gate
    // on, so it is the right caller for the check.
    const userRoutes = ordinaryJwtRoutes();
    const refused: string[] = [];
    for (const route of userRoutes) {
      const status = await call(route, { cookie: adminCookie });
      if (status === 401 || status === 403) refused.push(`${route.method} ${route.path} → ${status}`);
    }
    expect(refused).toEqual([]);
  }, 60_000);

  test("a session for an unapproved user is 403, not 401", async () => {
    // The third state § 9.1 now names. `401` would tell a client its
    // credentials are wrong and send it back through login forever; the truth
    // is that the login worked and no operator has acted yet.
    const userRoutes = ordinaryJwtRoutes();
    expect(userRoutes.length).toBeGreaterThan(3);
    for (const route of userRoutes) {
      expect(await call(route, { cookie: viewerCookie }), `${route.method} ${route.path}`).toBe(403);
    }
  }, 60_000);

  test("a session claiming the admin role but holding no grant is refused", async () => {
    // **The half § 11 exists for, and the half nothing checked.** Every gate
    // above distinguishes 401 from 403, and a route that swapped
    // `requireCapability(KEY_APPROVE)` for `payload.role !== 'admin'` answers
    // both of them exactly the same way — so the whole sweep stays green while
    // the capability model is gone. That mutation was applied and the full 601
    // tests passed.
    //
    // What separates the two is a token whose `role` is `admin` and whose
    // subject holds nothing: role-checking lets it in, capability-checking does
    // not. The seeded `admin` is the only subject with grants (they are written
    // as grants precisely so nothing compares the string), so any other login
    // is that caller.
    const roleOnly = `mesh_token=${hs256(
      { github_id: 9, github_login: "role-without-grants", role: "admin" },
      "integration-test-secret",
    )}`;

    // **Eight routes fail this today** and are listed rather than excused. They
    // still gate the way everything did before § 11 — `extractJwt` then
    // `payload.role !== 'admin'` — and were never migrated, which nothing
    // noticed because both models answer 401 and 403 identically for every
    // caller the other tests use.
    //
    // Fixing them is not a code change alone: three of them approve *people*
    // and two report AI usage, and § 11's vocabulary has a capability for
    // neither. Inventing one here would be deciding a contract in a test file.
    //
    // So the list is sealed instead of skipped. This fails the moment a ninth
    // route joins the set, and it fails again when one is migrated — which
    // forces the list down rather than letting it sit. A `skip` would have done
    // neither.
    // **Empty, and this is the state it was built to reach.** It began at
    // eight, dropped to five when the chat-audit routes migrated, and is now
    // nothing: every JWT* route in § 9.1 refuses a session whose role says
    // admin and whose subject holds no grant.
    //
    // It stays here rather than being deleted with the list. The check that
    // matters now is the other one — a *new* route gating on the role — and an
    // empty allowance says plainly that there is no exception, where a deleted
    // block would leave the next reader to work out whether there ever was one.
    const NOT_YET_ON_CAPABILITIES = new Set<string>([]);

    const adminOnly = routesFromSpec().filter((r) => r.auth === "JWT*");
    expect(adminOnly.length).toBeGreaterThan(5);

    const roleGated: string[] = [];
    for (const route of adminOnly) {
      const status = await call(route, { cookie: roleOnly });
      // 403 is the capability model refusing. Anything else — a 200, or a 400
      // reached because the guard let the request through to body parsing —
      // means the role got in.
      if (status !== 403) roleGated.push(`${route.method} ${route.path}`);
    }

    const unexpected = roleGated.filter((r) => !NOT_YET_ON_CAPABILITIES.has(r));
    expect(unexpected, "a new route gates on the role rather than a capability").toEqual([]);

    const migrated = [...NOT_YET_ON_CAPABILITIES].filter((r) => !roleGated.includes(r));
    expect(migrated, "these now refuse a role-only session — take them off the list").toEqual([]);
  }, 60_000);

  test("every implemented API route is in the § 9.1 table", async () => {
    // The direction the table cannot check itself. Five admin key-approval
    // routes existed with no entry here and none in § 10.2 either — a surface
    // a client had to be told about out of band, or discover by reading the
    // server.
    const source = await Bun.file(join(REPO_ROOT, "packages/http/src/main.ts")).text();
    const implemented = new Set<string>();
    for (const m of source.matchAll(/app\.(get|post|put|delete)\('(\/api\/v1\/[^']*)'/g)) {
      implemented.add(`${m[1]!.toUpperCase()} ${m[2]!}`);
    }
    // Normalise the two parameter spellings — `:id` in Hono, `{id}` in SPEC.
    const documented = new Set(
      routesFromSpec().map((r) => `${r.method} ${r.path.replace(/[:{]([a-zA-Z_]+)\}?/g, ":$1")}`),
    );
    const undocumented = [...implemented].filter(
      (r) => !documented.has(r.replace(/[:{]([a-zA-Z_]+)\}?/g, ":$1")),
    );
    expect(undocumented).toEqual([]);
  });

  test("public routes answer without a session", async () => {
    const open = routesFromSpec().filter((r) => r.auth === "None");
    for (const route of open) {
      const status = await call(route);
      expect(status, `${route.method} ${route.path}`).not.toBe(401);
      expect(status, `${route.method} ${route.path}`).not.toBe(403);
    }
  }, 60_000);

  test("a forged session is refused, not merely decoded", async () => {
    // `role` is a claim inside the token. A server that read it without
    // verifying the signature would hand admin to anyone who could base64.
    const forged = Buffer.from(JSON.stringify({ github_id: 1, github_login: "x", role: "admin" }))
      .toString("base64url");
    const token = `eyJhbGciOiJIUzI1NiJ9.${forged}.not-a-signature`;
    for (const route of routesFromSpec().filter((r) => r.auth === "JWT*")) {
      const status = await call(route, { cookie: `mesh_token=${token}` });
      expect(status, `${route.method} ${route.path}`).toBe(401);
    }
  }, 60_000);

  test("the token-authenticated ingest route is closed when no token is configured", async () => {
    // `AI_USAGE_INGEST_TOKEN` is unset in this harness, and the route answers
    // `503` rather than accepting anything — which is the right direction to
    // fail: an unconfigured shared secret must not mean "no secret required".
    const route = routesFromSpec().find((r) => r.auth === "Token");
    expect(route).toBeDefined();
    const res = await fetch(`${mesh.http.url}${route!.path}`, {
      method: route!.method,
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: "{}",
    });
    expect([401, 403, 503]).toContain(res.status);
    expect(res.status).not.toBe(200);
  }, 60_000);
});

/**
 * The routes, called in this process instead of through a port.
 *
 * **This file lives beside the service rather than in `test/`.** It imports the
 * entrypoint, and a project that imports a file outside its own directory has
 * to contain that file — listing `main.ts` in `test/tsconfig.json` pulled in
 * everything it imports, then everything *those* import, one `TS6307` at a
 * time. Here the project already holds them.
 *
 * Every file in `test/` spawns the http service, which is the right way
 * to test wiring — ports, signals, a restart — and the reason no coverage
 * instrument has ever seen a line of `main.ts`: it runs in a child. The service
 * used to bind a port and dial the hub on *import*, so importing was not an
 * option; `import.meta.main` now separates being loaded from being the program,
 * and `startup()` is what a served process does before it answers anything.
 *
 * What is asserted here is deliberately thin. The value is that the handler
 * stack executes where it can be counted; the behaviour of these routes is
 * already asserted, at length, by the suites that drive a real one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { agentsSchema, auditSchema, groups, hubSchema } from "@agent-mesh/store";

// The run's state directory, set by `scripts/test-state-dir.ts` before any
// test file loaded — which is the only moment early enough, because the paths
// these databases live at were computed when their modules were imported.
const STATE = process.env.AGENT_MESH_STATE_DIR!;

// These databases belong to other processes — the hub's, the audit log's — and
// http opens them expecting them to exist. Nothing is spawned here, so the
// schemas go in directly, using the same `migrate` their owners run at boot.
for (const [file, migrate] of [
  ["agents.db", agentsSchema.migrate],
  // `groups.migrate` is separate from the agents schema and lives in the same
  // file as the store that reads it, so a caller that only ran `agentsSchema`
  // gets `no such table: agent_groups` at the first write rather than at open.
  ["agents.db", groups.migrate],
  // `hub.db` too: `startup` starts the audit poller, which opens it, and with
  // it absent the poller logged a stack trace on every run and carried on. A
  // swallowed open is exactly the kind of thing this file makes visible.
  ["hub.db", hubSchema.migrate],
  ["audit.db", auditSchema.migrate],
] as const) {
  const db = new Database(join(STATE, file), { create: true, readwrite: true });
  migrate(db);
  db.close();
}

process.env.JWT_SECRET = "in-process-test-secret";
// A port nothing binds: `Bun.serve` is behind the guard, and this proves it.
process.env.PORT = "3998";

const mod = await import("./main.ts");
const app = mod.app;

beforeAll(async () => { await mod.startup(); });
afterAll(() => { /* no process to stop: nothing was started */ });

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://in-process${path}`, init));

describe("the http service, imported", () => {
  test("binds no port", () => {
    const listening = Bun.spawnSync(["lsof", "-nP", "-iTCP:3998", "-sTCP:LISTEN"]).stdout.toString();
    expect(listening.trim()).toBe("");
  });

  test("answers health", async () => {
    const res = await call("/api/v1/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBeTruthy();
  });

  test("refuses an admin route to nobody", async () => {
    // Unauthenticated, so this is the refusal path rather than the work.
    const res = await call("/api/v1/admin/users");
    expect([401, 403]).toContain(res.status);
  });

  test("answers a login with the form parser, not the JSON one", async () => {
    const res = await call("/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: "admin", password: "admin" }).toString(),
    });
    // Either it signs the seeded admin in or it refuses; what matters here is
    // that the body was parsed at all rather than read as an empty username.
    expect([200, 401, 403]).toContain(res.status);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  test("says not-found for a route that does not exist", async () => {
    expect((await call("/api/v1/no-such-route")).status).toBe(404);
  });

  test("creating a group twice answers 201 then 200", async () => {
    const login = await call("/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: "admin", password: "admin" }).toString(),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("=");

    // **The seeded admin has to change its password before anything else.**
    // Every other route answers `403 { must_change_password: true }` while the
    // flag is set — the guard is the server's, not the screen's — so the
    // in-process walk has to cross the same gate a person does.
    const changed = await call("/auth/local/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current: "admin", next: "in-process-password" }),
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).must_change_password).toBe(false);

    const create = (group_id: string) =>
      call("/api/v1/admin/groups", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ group_id }),
      });

    // SPEC § 9.1's table said `201` for this route and the route answers
    // `created ? 201 : 200` — idempotent, because asking for a group that is
    // already there created nothing. agent-mesh-local-pm measured the gap
    // (mail #1553); the second call is what nothing was asserting.
    const first = await create("in-process-idempotent");
    expect(first.status).toBe(201);
    expect((await first.json()).created).toBe(true);

    const again = await create("in-process-idempotent");
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
  });
});

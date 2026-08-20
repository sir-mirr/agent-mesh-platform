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

/**
 * An admin session, shared by every walk below.
 *
 * The seeded admin is held behind a password change — every other route
 * answers `403 { must_change_password: true }` while the flag is set, and that
 * guard is the server's rather than the screen's. Signing in is therefore two
 * requests, not one, and a walk that skipped the second would read the mesh as
 * refusing everything.
 */
let cookie = "";

beforeAll(async () => {
  await mod.startup();

  const login = await app.fetch(new Request("http://in-process/auth/local", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ username: "admin", password: "admin" }).toString(),
  }));
  if (login.status !== 200) throw new Error(`sign-in failed: ${login.status} ${await login.text()}`);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

  const changed = await app.fetch(new Request("http://in-process/auth/local/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ current: "admin", next: "in-process-password" }),
  }));
  if (changed.status !== 200) throw new Error(`password change failed: ${changed.status}`);
});

afterAll(() => { /* no process to stop: nothing was started */ });

/** As the admin, with a JSON body when there is one. */
const asAdmin = (path: string, method: string, body?: unknown) =>
  app.fetch(new Request(`http://in-process${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

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
    // SPEC § 9.1's table said `201` for this route and the route answers
    // `created ? 201 : 200` — idempotent, because asking for a group that is
    // already there created nothing. agent-mesh-local-pm measured the gap
    // (mail #1553); the second call is what nothing was asserting.
    const first = await asAdmin("/api/v1/admin/groups", "POST", { group_id: "in-process-idempotent" });
    expect(first.status).toBe(201);
    expect((await first.json()).created).toBe(true);

    const again = await asAdmin("/api/v1/admin/groups", "POST", { group_id: "in-process-idempotent" });
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
  });

  /**
   * SPEC § 9.2a from the route's side, in one process.
   *
   * The clause — a delete whose target is absent answers `200` and the body
   * names which of the two happened — was false on three of four routes until
   * today, and each had a passing test asserting whatever its own route did.
   * `test/delete-absence.test.ts` derives the route list and covers the absent
   * half against a spawned service; this covers the *present* half, which is
   * the branch that only exists once something has been created.
   */
  test("agent-types: created, listed, deleted, then absent", async () => {
    const created = await asAdmin("/api/v1/admin/agent-types", "POST",
      { type: "in-process-type", description: "written by a test" });
    expect(created.status).toBe(201);

    const listed = await asAdmin("/api/v1/admin/agent-types", "GET");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("in-process-type");

    const gone = await asAdmin("/api/v1/admin/agent-types/in-process-type", "DELETE");
    expect(gone.status).toBe(200);
    expect((await gone.json()).action).toBe("deleted");

    const again = await asAdmin("/api/v1/admin/agent-types/in-process-type", "DELETE");
    expect(again.status).toBe(200);
    expect((await again.json()).action).toBe("not-found");
  });

  test("grants: given, read back, withdrawn, then absent", async () => {
    const given = await asAdmin("/api/v1/admin/grants", "POST",
      { subject: "in-process-subject", capability: "key.approve", scope: "*" });
    expect(given.status).toBe(201);

    const read = await asAdmin("/api/v1/admin/grants?subject=in-process-subject", "GET");
    const body = await read.json();
    expect(body.grants.some((g: { capability: string }) => g.capability === "key.approve")).toBe(true);
    // **Filtered by subject, the answer is that subject's grants and nothing
    // else** — no `capabilities`. Three questions, three shapes: `?subject=`
    // answers `{ grants }`, `?capability=` answers `{ subjects }`, and the
    // unfiltered read is the only one that carries the vocabulary. A caller
    // reading `capabilities` off a filtered response gets `undefined`, which
    // is why the front end's type marks it optional.
    expect(body.capabilities).toBeUndefined();

    const whole = await asAdmin("/api/v1/admin/grants", "GET");
    // The vocabulary travels with the map: without it a matrix screen compiles
    // its own copy of the capability list, which goes stale silently.
    expect((await whole.json()).capabilities.length).toBeGreaterThan(0);

    const withdrawn = await asAdmin("/api/v1/admin/grants", "DELETE",
      { subject: "in-process-subject", capability: "key.approve", scope: "*" });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json()).action).toBe("deleted");

    const again = await asAdmin("/api/v1/admin/grants", "DELETE",
      { subject: "in-process-subject", capability: "key.approve", scope: "*" });
    expect((await again.json()).action).toBe("not-found");
  });

  test("egress: allowed, withdrawn, then absent", async () => {
    await asAdmin("/api/v1/admin/groups", "POST", { group_id: "in-process-src" });
    await asAdmin("/api/v1/admin/groups", "POST", { group_id: "in-process-dst" });

    const allowed = await asAdmin("/api/v1/admin/groups/in-process-src/egress", "POST",
      { to_group: "in-process-dst" });
    expect(allowed.status).toBe(201);

    const withdrawn = await asAdmin("/api/v1/admin/groups/in-process-src/egress/in-process-dst", "DELETE");
    // This route answered `404` with `ok: true` until today — a status and a
    // body saying opposite things about one call.
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json()).action).toBe("deleted");

    const again = await asAdmin("/api/v1/admin/groups/in-process-src/egress/in-process-dst", "DELETE");
    expect(again.status).toBe(200);
    expect((await again.json()).action).toBe("not-found");
  });

  test("admitting a person hands back a password shown once", async () => {
    const admitted = await asAdmin("/api/v1/admin/users", "POST", { username: "in-process-newcomer" });
    expect(admitted.status).toBe(201);
    const body = await admitted.json();
    expect(typeof body.temporary_password).toBe("string");
    expect(body.temporary_password.length).toBeGreaterThan(8);

    const roster = await asAdmin("/api/v1/admin/users", "GET");
    expect(JSON.stringify(await roster.json())).toContain("in-process-newcomer");
  });

  test("the key queue answers under the name D-689 moved it to", async () => {
    const pending = await asAdmin("/api/v1/admin/keys/pending", "GET");
    expect(pending.status).toBe(200);
    const body = await pending.json();
    // `keys`, not `pending`: this queue and the admission queue answered the
    // same body one path segment apart, and a reader holding a response could
    // not tell which one it was.
    expect(Array.isArray(body.keys)).toBe(true);
  });

  /**
   * The read-only surfaces a dashboard opens on load.
   *
   * These are the panels `fetchTelemetry` asks for in one breath, and the
   * reason it has to tell *refused* from *unreachable*: two of the five are
   * ungated — none of § 11's twelve capabilities names reading the registry —
   * so they answer for anybody signed in, and the other three do not. Walking
   * them here covers the query and audit modules, which no in-process caller
   * had ever loaded.
   */
  test("the dashboard's panels answer, and say what they are counting", async () => {
    const health = await asAdmin("/api/v1/health", "GET");
    expect(health.status).toBe(200);
    const h = await health.json();
    // `agent_count` counts mesh identities that are alive; the registry list
    // is a different table answering a different question, and putting one
    // under the other's label was a measured defect (12 against 13).
    expect(typeof h.agent_count === "number" || h.agent_count === null).toBe(true);

    const mailbox = await asAdmin("/api/v1/admin/mailbox", "GET");
    expect(mailbox.status).toBe(200);
    const m = await mailbox.json();
    // `mailboxes` and `total_queued` are the names this route sends. `depth`
    // and `unacked_count` are names it has never sent, and a reader that summed
    // them drew `0 queued` on a mesh with a backlog.
    expect(Array.isArray(m.mailboxes)).toBe(true);
    expect(typeof m.total_queued).toBe("number");

    const behaviour = await asAdmin("/api/v1/admin/telemetry/behaviour", "GET");
    expect(behaviour.status).toBe(200);
    expect(await behaviour.json()).toHaveProperty("counting_since");

    const telemetry = await asAdmin("/api/v1/admin/telemetry", "GET");
    expect(telemetry.status).toBe(200);
  });

  test("the audit log answers a list, and a miss is a miss", async () => {
    const events = await asAdmin("/api/v1/audit/events", "GET");
    expect(events.status).toBe(200);
    const body = await events.json();
    expect(Array.isArray(body.events ?? body)).toBe(true);

    // An id nothing wrote. `404` here is a statement about one event, unlike a
    // delete, where absence is the operator's own request already satisfied.
    const missing = await asAdmin("/api/v1/audit/events/in-process-no-such-event", "GET");
    expect([404, 400]).toContain(missing.status);
  });

  test("the admission queue answers under its own name", async () => {
    const waiting = await asAdmin("/api/v1/admin/pending", "GET");
    expect(waiting.status).toBe(200);
    expect(Array.isArray((await waiting.json()).users)).toBe(true);
  });
});

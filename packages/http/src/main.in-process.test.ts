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
import { agentsSchema, auditSchema, groups, hubSchema, ownership } from "@agent-mesh/store";

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
// The chat page needs a user row for the session behind it; nothing else here
// writes one.
const { upsertUser, upsertApprovedWebUser, insertMessage } = await import("./db.ts");
// The mesh database, opened by the same accessor the routes use, so a row
// written here is the row they read rather than a second handle onto the file.
const { agentsDb } = await import("./keys-admin.ts");
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

  /**
   * The one live route no test anywhere named.
   *
   * `agent-mesh-local-pm` counted the routes against both the suite and the
   * contract and found this the only one covered by neither (I-148, narrowed to
   * two and then to one once the contract was added to their denominator). It
   * refuses correctly — it names the field it wants — so the first test is the
   * refusal, which is also the half a caller meets first.
   */
  test("search refuses without a session, and names the parameter it wants", async () => {
    expect((await app.fetch(new Request("http://in-process/api/v1/messages/search?q=hello"))).status)
      .toBe(401);

    const noQuery = await asAdmin("/api/v1/messages/search", "GET");
    expect(noQuery.status).toBe(400);
    // Named rather than described: a caller reading `400 Bad Request` has to
    // guess, and SPEC § 9.2 says the message carries the field.
    expect((await noQuery.json()).error).toContain("q");

    const blank = await asAdmin("/api/v1/messages/search?q=%20%20", "GET");
    expect(blank.status).toBe(400);
  });

  test("search answers a list, and says what it searched for", async () => {
    const res = await asAdmin("/api/v1/messages/search?q=in-process-needle", "GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The query travels back with the answer: a screen drawing "no results for
    // X" needs the X the server actually used, which is the trimmed one.
    expect(body.query).toBe("in-process-needle");
    expect(body.count).toBe(0);
    expect(Array.isArray(body.messages)).toBe(true);
    // `count` is the length of what came back, not a total the route invented.
    expect(body.count).toBe(body.messages.length);
  });

  test("search survives a limit that is not a number", async () => {
    // `parseInt("many", 10)` is `NaN`, and `NaN || 50` is what keeps this from
    // reaching SQLite as a limit of nothing.
    const res = await asAdmin("/api/v1/messages/search?q=x&limit=many", "GET");
    expect(res.status).toBe(200);
  });

  /**
   * The three server-rendered pages, which nothing has ever opened.
   *
   * `packages/http/src/ui/` is out of the coverage denominator by the owner's
   * decision, and `agent-mesh-local-pm` pointed out what that leaves behind:
   * excluded from a number is not the same as looked at by nobody. Those files
   * are 1,864 lines, `/admin` is the only screen that draws the human admission
   * queue, and the only test touching them was one that fetches a route rather
   * than opens a page.
   *
   * This is the cheapest thing that is not nothing: ask each route, in this
   * process, and assert what it answers — including the redirect an
   * unauthenticated visitor gets, which is the half a stranger meets.
   */
  test("the landing page renders, with and without an error to report", async () => {
    const plain = await app.fetch(new Request("http://in-process/"));
    expect(plain.status).toBe(200);
    expect((plain.headers.get("content-type") ?? "")).toContain("text/html");
    const html = await plain.text();
    expect(html).toContain("<html");

    // The query parameter is how a failed sign-in comes back to this page.
    const withError = await app.fetch(new Request("http://in-process/?error=denied"));
    expect(withError.status).toBe(200);
    expect((await withError.text()).length).toBeGreaterThan(0);
  });

  test("the chat and admin pages send a stranger back to the landing page", async () => {
    for (const path of ["/chat", "/chat/some-agent", "/admin"]) {
      const res = await app.fetch(new Request(`http://in-process${path}`), );
      // A redirect, not a 401: these are pages rather than routes, and a person
      // who is not signed in is sent somewhere they can sign in.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  test("the chat page opens once the session has a user row behind it", async () => {
    // `/chat` reads `getUser(payload.github_id)` and sends anybody without a
    // row back to the landing page. A local sign-in has a github id in its
    // token and no row, which is why every earlier attempt at this page was a
    // redirect — and why `ui/chat.ts`, the largest of the four, had never been
    // rendered by anything.
    const me = await (await asAdmin("/auth/me", "GET")).json();
    expect(typeof me.github_id).toBe("number");
    upsertUser(me.github_id, me.github_login);

    const res = await asAdmin("/chat", "GET");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
    // Either page is `ui/chat.ts` — the approved one or the one that says the
    // account is still waiting. Which of the two depends on the seeded admin's
    // approval, and this file is not the place that decides it.
    expect(html.length).toBeGreaterThan(500);
  });

  test("the admin page opens for an administrator", async () => {
    const res = await asAdmin("/admin", "GET");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
    // The one screen that draws the human admission queue — the reason this
    // page is worth opening at all rather than counting.
    expect(html.length).toBeGreaterThan(1000);
  });

  test("a pairing code is minted for a name the mesh will accept, and refused otherwise", async () => {
    const made = await asAdmin("/api/v1/admin/pairing-codes", "POST", { identity: "in-process-pairee" });
    expect(made.status).toBe(201);
    const body = await made.json();
    // The code is the only credential the redeem route takes, so it comes from
    // here rather than from the screen that shows it — the console's own modal
    // inventing one is a defect on the ledger (I-143).
    expect(typeof body.code).toBe("string");
    expect(body.code.length).toBeGreaterThan(4);
    expect(body.identity).toBe("in-process-pairee");
    expect(typeof body.ttl_seconds).toBe("number");

    // § 10.1's pattern is the gate, and the message names it rather than
    // answering a bare 400.
    const refused = await asAdmin("/api/v1/admin/pairing-codes", "POST", { identity: "not a valid name" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("identity");
  });

  test("nobody owns an identity that was never provisioned", async () => {
    const owners = await asAdmin("/api/v1/admin/agents/in-process-nobody/owners", "GET");
    expect(owners.status).toBe(200);
    const body = await owners.json();
    // An empty list, not a 404: who is answerable for a name is a question
    // with an answer even when the answer is nobody.
    expect(Array.isArray(body.owners)).toBe(true);
    expect(body.identity).toBe("in-process-nobody");

    const malformed = await asAdmin("/api/v1/admin/agents/not%20a%20name/owners", "GET");
    expect(malformed.status).toBe(400);
  });

  test("the key history of an identity nobody proposed is empty rather than missing", async () => {
    const keys = await asAdmin("/api/v1/admin/keys/in-process-nobody", "GET");
    expect(keys.status).toBe(200);
    expect(await keys.json()).toBeDefined();
  });

  test("tenant traffic answers a shape a screen can draw", async () => {
    const tenants = await asAdmin("/api/v1/admin/tenants", "GET");
    expect(tenants.status).toBe(200);
    const body = await tenants.json();
    expect(Array.isArray(body.tenants)).toBe(true);
    // The window travels with the counts: a number of messages means nothing
    // without the hours it was counted over.
    expect(typeof body.hours).toBe("number");
  });

  test("the admission queue answers under its own name", async () => {
    const waiting = await asAdmin("/api/v1/admin/pending", "GET");
    expect(waiting.status).toBe(200);
    expect(Array.isArray((await waiting.json()).users)).toBe(true);
  });
});

/**
 * `/api/v1/agents`, and what one session may see of the registry (§ 12).
 *
 * The route answered the whole registry to anybody approved — 44 identities to
 * an account with no capabilities, measured on the standing stack — and now
 * scopes on four terms: the actor, what it owns, who shares its group, and who
 * it has exchanged with. A leak here is not a missing feature but a boundary
 * that reads as working, so each term is added one at a time and the identity
 * that satisfies none of them is asserted absent every time.
 *
 * These run in file order and each builds on the last: the first measures a
 * session with nothing, and every later one adds exactly one reason to see
 * exactly one identity. Asserting only the additions would pass equally well
 * against a route that returns everything, which is why `STRANGER` is checked
 * in all of them.
 *
 * **`test/agents-visibility.test.ts` is not this file, and neither replaces the
 * other.** That one drives a real stack through a port, which is the only way
 * to know the boundary survives the wiring — and, because it runs in a child,
 * it has never counted a line of `main.ts`. Three of the terms overlap; the
 * ones only here are ownership, the outbound direction of a conversation, the
 * `last_seen` join, the approved-key filter, and the absent `status` field.
 * Deleting either as a copy of the other would drop those.
 */
describe("the registry, scoped to the session", () => {
  const MEMBER = "in-process-scoped-member";
  const OWNED = "in-process-scoped-owned";
  const GROUPMATE = "in-process-scoped-groupmate";
  const CORRESPONDENT = "in-process-scoped-correspondent";
  const ADDRESSEE = "in-process-scoped-addressee";
  const STRANGER = "in-process-scoped-stranger";

  let memberCookie = "";

  /** The identities the route returned, for whoever the cookie belongs to. */
  const idsFor = async (session: string): Promise<string[]> => {
    const res = await call("/api/v1/agents", { headers: { cookie: session } });
    expect(res.status).toBe(200);
    const body = await res.json();
    return (body.agents as Array<{ id: string }>).map(a => a.id);
  };

  beforeAll(async () => {
    // Approved in the registry, or `isUserApproved` refuses before any scoping
    // runs and every assertion below would measure a `403` instead.
    for (const id of [MEMBER, OWNED, GROUPMATE, CORRESPONDENT, ADDRESSEE, STRANGER]) {
      upsertApprovedWebUser(id);
    }

    const admitted = await asAdmin("/api/v1/admin/users", "POST", { username: MEMBER });
    if (admitted.status !== 201) throw new Error(`admit failed: ${admitted.status}`);
    const { temporary_password } = await admitted.json();

    const login = await call("/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: MEMBER, password: temporary_password }).toString(),
    });
    if (login.status !== 200) throw new Error(`member sign-in failed: ${login.status}`);
    memberCookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

    // An admitted account is behind the first-login gate, and every other route
    // answers `403 { must_change_password: true }` until it is passed.
    const changed = await call("/auth/local/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ current: temporary_password, next: "in-process-member-password" }),
    });
    if (changed.status !== 200) throw new Error(`member password change failed: ${changed.status}`);
  });

  test("refuses a session it cannot identify", async () => {
    expect((await call("/api/v1/agents")).status).toBe(401);
  });

  test("an administrator sees every registered identity", async () => {
    const ids = await idsFor(cookie);
    for (const id of [MEMBER, OWNED, GROUPMATE, CORRESPONDENT, ADDRESSEE, STRANGER]) {
      expect({ id, visible: ids.includes(id) }).toEqual({ id, visible: true });
    }
  });

  test("a session that owns nothing and knows nobody sees only itself", async () => {
    const ids = await idsFor(memberCookie);
    expect(ids).toEqual([MEMBER]);
  });

  test("an owned identity becomes visible", async () => {
    ownership.assign(agentsDb(), { identity: OWNED, owner: MEMBER, grantedBy: "admin" });
    const ids = await idsFor(memberCookie);
    expect({
      self: ids.includes(MEMBER),
      owned: ids.includes(OWNED),
      stranger: ids.includes(STRANGER),
    }).toEqual({ self: true, owned: true, stranger: false });
  });

  test("everyone in the session's own group becomes visible", async () => {
    const made = await asAdmin("/api/v1/admin/groups", "POST", { group_id: "in-process-scoped-group" });
    expect([200, 201]).toContain(made.status);
    for (const identity of [MEMBER, GROUPMATE]) {
      const moved = await asAdmin("/api/v1/admin/groups/in-process-scoped-group/members", "POST", { identity });
      expect(moved.status).toBe(200);
    }
    const ids = await idsFor(memberCookie);
    expect({
      groupmate: ids.includes(GROUPMATE),
      stranger: ids.includes(STRANGER),
    }).toEqual({ groupmate: true, stranger: false });
  });

  test("an identity the session has exchanged with becomes visible, sent or received", async () => {
    // **Both directions, because one of them is free.** The route adds both
    // ends of every row it finds, and a test that only ever received would
    // pass just as well against a route that dropped `to_agent` — measured:
    // deleting that line left this file green until the outbound half existed.
    // "Have these two met" is not directional, and neither is this check.
    insertMessage({
      id: "in-process-scoped-message-in",
      from: CORRESPONDENT,
      to: MEMBER,
      content: "in-process",
      status: "delivered",
      ts: new Date().toISOString(),
    });
    insertMessage({
      id: "in-process-scoped-message-out",
      from: MEMBER,
      to: ADDRESSEE,
      content: "in-process",
      status: "delivered",
      ts: new Date().toISOString(),
    });
    const ids = await idsFor(memberCookie);
    expect({
      inbound: ids.includes(CORRESPONDENT),
      outbound: ids.includes(ADDRESSEE),
      stranger: ids.includes(STRANGER),
    }).toEqual({ inbound: true, outbound: true, stranger: false });
  });

  test("carries the mesh's last_seen, and null where the mesh has no record", async () => {
    // `agent_registry` and the mesh's `agents` are two tables on one namespace;
    // the route joins them. Before it did, the console had nothing to draw and
    // drew `ONLINE` for everyone.
    const seen = "2026-08-20T00:00:00.000Z";
    agentsDb()
      .prepare(`INSERT INTO agents (identity, last_seen) VALUES (?, ?)
                ON CONFLICT(identity) DO UPDATE SET last_seen = excluded.last_seen`)
      .run(OWNED, seen);

    const res = await call("/api/v1/agents", { headers: { cookie: memberCookie } });
    const agents = (await res.json()).agents as Array<{ id: string; last_seen_at: string | null }>;
    const byId = new Map(agents.map(a => [a.id, a] as const));

    expect(byId.get(OWNED)?.last_seen_at).toBe(seen);
    // Never connected is not the same fact as offline, and the route says so
    // with `null` rather than inventing a state for it.
    expect(byId.get(CORRESPONDENT)?.last_seen_at).toBeNull();
  });

  test("carries a fingerprint only for an approved key", async () => {
    const mesh = agentsDb();
    const insert = mesh.prepare(
      `INSERT OR REPLACE INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run("in-process-scoped-fp-approved", OWNED, "in-process-key", "approved");
    insert.run("in-process-scoped-fp-pending", CORRESPONDENT, "in-process-key", "pending");

    const res = await call("/api/v1/agents", { headers: { cookie: memberCookie } });
    const agents = (await res.json()).agents as Array<{ id: string; fingerprint: string | null }>;
    const byId = new Map(agents.map(a => [a.id, a] as const));

    expect({
      approved: byId.get(OWNED)?.fingerprint,
      // A proposed key is not a key the mesh trusts, so it is not one the
      // console should draw beside an identity.
      pending: byId.get(CORRESPONDENT)?.fingerprint,
    }).toEqual({ approved: "in-process-scoped-fp-approved", pending: null });
  });

  test("reports no status field", async () => {
    // Deliberate absence. Whether silence for five minutes is `inactive` is an
    // operating policy, and a route answering it would ship a judgement dressed
    // as a measurement — the defect the screens were fixed for in `71afcdb`.
    const res = await call("/api/v1/agents", { headers: { cookie: memberCookie } });
    const agents = (await res.json()).agents as Array<Record<string, unknown>>;
    expect(agents.length).toBeGreaterThan(0);
    for (const entry of agents) {
      expect({ id: entry.id, hasStatus: "status" in entry }).toEqual({ id: entry.id, hasStatus: false });
    }
  });
});

/**
 * What a browser is handed when it installs the app.
 *
 * These five routes are 100 uncovered lines and no test anywhere touches them,
 * which is what a service worker looks like right up until an install breaks:
 * nothing throws, the console draws, and the failure is that a phone keeps
 * serving a build from last week.
 *
 * Each check below is a cross-check rather than a shape assertion — the
 * manifest against the files it names, the worker's cache version against the
 * version the server reports — because "the route returned 200" is exactly the
 * assertion that stays green through every defect in this list.
 */
describe("what a browser installs", () => {
  test("serves the service worker as JavaScript, and unnamed as anything else", async () => {
    const res = await call("/sw.js");
    expect(res.status).toBe(200);
    // A service worker delivered with any other type is refused at
    // registration — the browser will not run a worker it was handed as text.
    // Nothing on the server notices; the app simply never installs.
    expect(res.headers.get("content-type") ?? "").toContain("application/javascript");
  });

  test("tells the browser not to cache the service worker", async () => {
    const res = await call("/sw.js");
    // The worker is the thing that invalidates everything else, so a cached
    // one cannot be replaced by shipping a new build: the copy that would
    // fetch the new copy is itself the stale one.
    expect(res.headers.get("cache-control") ?? "").toContain("no-cache");
  });

  test("names its cache after the version the server reports", async () => {
    const [health, sw] = await Promise.all([call("/api/v1/health"), call("/sw.js")]);
    const version = (await health.json()).version as string;
    const body = await sw.text();

    // `activate` deletes every cache whose name is not the current one, so the
    // name is the whole invalidation mechanism. Pinned to a literal — or
    // pinned to a *different* constant than the one the server answers with —
    // it never changes, the delete never fires, and the install that was
    // supposed to bring a new build serves the old one from cache.
    expect({ version, named: body.includes(`const CACHE_VERSION = '${version}';`) })
      .toEqual({ version, named: true });
  });

  test("names icons in the manifest that the server actually serves", async () => {
    const manifest = await (await call("/manifest.json")).json();
    const icons = manifest.icons as Array<{ src: string; sizes: string; type: string }>;
    expect(icons.length).toBeGreaterThan(0);

    // A manifest is a list of promises about other URLs, and nothing checks
    // them: an icon that 404s makes the install fail with no error anywhere
    // the server can see. Asking for each one is the only way to know.
    for (const icon of icons) {
      const res = await call(icon.src);
      expect({
        src: icon.src,
        status: res.status,
        type: res.headers.get("content-type"),
      }).toEqual({ src: icon.src, status: 200, type: icon.type });
    }
  });

  test("draws each icon at the size its name claims", async () => {
    // Two routes built from one template differing only in an argument is
    // where a copy-paste survives review: both answer 200, both are valid SVG,
    // and the large icon is a small one scaled up on every device that asks
    // for it.
    const at = async (path: string) => (await call(path)).text();
    const [small, large] = await Promise.all([at("/icon-192.svg"), at("/icon-512.svg")]);
    expect({
      small: small.includes('width="192"'),
      large: large.includes('width="512"'),
      distinct: small !== large,
    }).toEqual({ small: true, large: true, distinct: true });
  });

  test("answers null for an unconfigured push key rather than leaving the field out", async () => {
    const res = await call("/api/v1/push/vapid-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    // `undefined` disappears from a JSON body, and a client reading a missing
    // key cannot tell "this deployment has no push configured" from "the
    // server did not answer that". Null says which.
    expect("publicKey" in body).toBe(true);
  });
});

/**
 * A send with no hub behind it, and the two edges of the GitHub sign-in.
 *
 * **The first of these catches nothing new, and that is the honest statement
 * of what it is for.** `test/message-status.test.ts` already asserts both
 * facts below against a *real* hub, in both directions and through three
 * readers, and every mutation these two assertions kill is killed there
 * first. What that file cannot do is let an instrument see the lines: it
 * drives a spawned service, so `main.ts` executes in a child and counts as
 * nothing. That is this file's whole purpose, and this is that purpose rather
 * than a new catch.
 *
 * **So nobody may thin `test/message-status.test.ts` on the strength of this.**
 * With no hub in this process the guard in `sendViaHub` returns at its first
 * line every time, which means the hub-*up* direction is unreachable here and
 * `if (!hubMessageId)` → `if (true)` — one edit, every message in the product
 * reading as failed — stays green through everything below. Only the real-hub
 * file kills that.
 *
 * The two sign-in checks are the opposite case: `GET /auth/github/callback`
 * has no server-side test anywhere, and its first four lines are the only part
 * of it reachable without either `mock.module` or a live consent screen.
 */
describe("a send with nothing behind it, and the edges of sign-in", () => {
  const HUBLESS = "in-process-hubless";

  test("a message the hub never took is failed in the answer and in the row", async () => {
    upsertApprovedWebUser(HUBLESS);

    // Both halves in one test on purpose: the second reads an id the first
    // produced, and split across two tests a name filter on either one breaks
    // the other with an error about nothing.
    const sent = await asAdmin("/api/v1/messages", "POST", {
      to: HUBLESS,
      // Deliberately free of the substrings other tests in this file search
      // for — `agent_registry` and `messages` are shared by the whole run.
      text: "in-process-with-no-hub",
    });
    expect(sent.status).toBe(201);
    const { message } = await sent.json();
    expect(message.status).toBe("failed");

    // **The row, not the reply.** The correction used to be applied to the
    // object the response is built from and to nothing else, so the caller was
    // told the truth once and every later read — history, conversation, search
    // — served the `pending` the insert left behind.
    const history = await asAdmin(`/api/v1/messages/${HUBLESS}`, "GET");
    expect(history.status).toBe(200);
    const rows = (await history.json()).messages as Array<{ id: string; status: string }>;
    const stored = rows.find(r => r.id === message.id);
    expect({ found: stored !== undefined, status: stored?.status }).toEqual({ found: true, status: "failed" });
  });

  test("a callback with no code is refused before anything is exchanged", async () => {
    // Cancelling GitHub's consent screen returns here with `?error=...` and no
    // code, and so does anyone who simply opens the URL. Reaching the token
    // exchange with `undefined` spends a network call to be told the same
    // thing, and answers whatever GitHub says instead of what happened.
    const res = await call("/auth/github/callback");
    expect(res.status).toBe(400);
  });

  test("an empty code is treated as missing rather than exchanged", async () => {
    // `?code=` with nothing after it — a proxy that strips the value, a
    // truncated URL — is not a code, and `if (!code)` is what makes the empty
    // string join `undefined` rather than travel to GitHub.
    const res = await call("/auth/github/callback?code=");
    expect(res.status).toBe(400);
  });

  test("signing out clears the browser's copy of the session", async () => {
    const res = await call("/auth/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    // The front end clearing its own state is not signing out: the cookie is
    // what the next request carries. Expiring it is the server's half, and on
    // a shared machine it is the half that matters.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect({ names: setCookie.includes("mesh_token="), expires: setCookie.includes("Max-Age=0") })
      .toEqual({ names: true, expires: true });
  });
});

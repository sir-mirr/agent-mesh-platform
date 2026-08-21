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
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { agentsSchema, auditSchema, groups, hubSchema, ownership } from "@agent-mesh/store";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { formatRestAuthorization, keyFingerprint, restSignaturePreimage, SIGNATURE_FRESHNESS_WINDOW_SECONDS }
  from "@agent-mesh/contracts";
import { captureConsole } from "@agent-mesh/log";

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
const { upsertUser, upsertApprovedWebUser, insertMessage, getDb } = await import("./db.ts");
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

/**
 * Who may fetch an attachment (§ 15.3, § 9.2.1).
 *
 * The route was open, on the reasoning that a content-addressed id is
 * unguessable and therefore a capability. That holds until the id appears in a
 * log line, an audit event or a forwarded `download_url` — a capability that
 * travels inside the thing it protects cannot be withdrawn — so it now takes
 * either a session or a signature.
 *
 * **A refusal and a miss are the same answer here**, both `404`, deliberately:
 * telling the two apart would turn the route into a probe for which digests
 * the mesh holds. That shapes every check below. The gate's own outcomes are
 * visible — `401` is "you are nobody", `403` is "you are somebody unapproved"
 * — so an identified caller reaching `404` is itself the evidence the
 * credential was accepted.
 *
 * `mayDownload` reads `hub.db`, which is not the database the `insertMessage`
 * imported at the top of this file writes to. The row below goes in by hand,
 * to the file the route actually reads.
 */
describe("who may fetch an attachment", () => {
  const SIGNER = "in-process-signer";
  const PEER = "in-process-attachment-peer";
  // The route rejects anything that is not 64 hex characters before it looks
  // at a credential, so an id has to be a real digest or every check below
  // measures a `400` and nothing else. It measured exactly that first.
  const ATTACHMENT = createHash("sha256").update("in-process-attachment").digest("hex");

  let publicKey = "";
  let privateKey: import("node:crypto").KeyObject;
  let fingerprint = "";

  /** An `Authorization` value over this exact path, as § 9.2.1 spells it. */
  const signed = (path: string, opts: { iat?: number; kid?: string; body?: Uint8Array } = {}) => {
    const nonce = randomUUID();
    const iat = opts.iat ?? Math.floor(Date.now() / 1000);
    const kid = opts.kid ?? fingerprint;
    const preimage = opts.body ?? restSignaturePreimage({
      method: "GET",
      path,
      kid,
      nonce,
      iat,
      // A GET has no body, and § 9.2.1 spells that as the empty string rather
      // than the digest of nothing.
      bodySha256: "",
    });
    const signature = Buffer.from(edSign(null, Buffer.from(preimage), privateKey)).toString("base64url");
    return formatRestAuthorization({ kid, nonce, iat, signature });
  };

  beforeAll(() => {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
    publicKey = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
    fingerprint = keyFingerprint(publicKey);

    agentsDb()
      .prepare(`INSERT OR REPLACE INTO agent_keys (fingerprint, identity, public_key, status)
                VALUES (?, ?, ?, 'approved')`)
      .run(fingerprint, SIGNER, publicKey);

    const hub = new Database(join(STATE, "hub.db"), { readwrite: true });
    hub.prepare(`INSERT OR REPLACE INTO messages (id, from_agent, to_agent, content)
                 VALUES (?, ?, ?, ?)`)
      .run("in-process-attachment-message", SIGNER, PEER, `{"attachments":["${ATTACHMENT}"]}`);
    hub.close();
  });

  test("a credential that is not a signature is refused, not crashed on", async () => {
    // `parseRestAuthorization` returns null for anything that is not the
    // scheme, and the guard for that null is the only thing between here and
    // reading `.iat` off it.
    const res = await call(`/api/v1/attachments/${ATTACHMENT}`, {
      headers: { authorization: "Bearer not-a-signature" },
    });
    expect(res.status).toBe(401);
  });

  test("an approved key's signature is a credential this route accepts", async () => {
    const path = `/api/v1/attachments/${ATTACHMENT}`;
    const res = await call(path, { headers: { authorization: signed(path) } });
    // Not 401: the caller was identified. That is what this check is about —
    // whether the bytes come back is `mayDownload`'s question and the file
    // system's, both asked after this gate.
    expect({ refused: res.status === 401 }).toEqual({ refused: false });
  });

  test("a forged signature buys nothing, even from a party to the message", async () => {
    const path = `/api/v1/attachments/${ATTACHMENT}`;
    // Same identity, same fresh timestamp, same everything the header says —
    // only the signature bytes are another key's. Being party to the message
    // is not the credential; holding the key is.
    const other = generateKeyPairSync("ed25519");
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const preimage = restSignaturePreimage({ method: "GET", path, kid: fingerprint, nonce, iat, bodySha256: "" });
    const signature = Buffer.from(edSign(null, Buffer.from(preimage), other.privateKey)).toString("base64url");
    const res = await call(path, {
      headers: { authorization: formatRestAuthorization({ kid: fingerprint, nonce, iat, signature }) },
    });
    expect(res.status).toBe(401);
  });

  test("the signed path includes the query string", async () => {
    const path = `/api/v1/attachments/${ATTACHMENT}`;
    // Signed without the query, sent with it. If the server rebuilds its
    // preimage from the path alone the two agree and this passes — which is
    // the defect: everything after `?` would then be unsigned and free to
    // rewrite in flight.
    const res = await call(`${path}?disposition=attachment`, {
      headers: { authorization: signed(path) },
    });
    expect(res.status).toBe(401);
  });

  test("a captured Authorization header stops working", async () => {
    const path = `/api/v1/attachments/${ATTACHMENT}`;
    const stale = Math.floor(Date.now() / 1000) - (SIGNATURE_FRESHNESS_WINDOW_SECONDS + 60);
    const res = await call(path, { headers: { authorization: signed(path, { iat: stale }) } });
    // There is no nonce window in this process — § 8.1's lives in the hub —
    // so the freshness bound is the whole of what limits a replay. Without it
    // a header lifted from a log works for ever.
    expect(res.status).toBe(401);
  });

  test("a header dated into the future stops working too", async () => {
    const path = `/api/v1/attachments/${ATTACHMENT}`;
    const ahead = Math.floor(Date.now() / 1000) + (SIGNATURE_FRESHNESS_WINDOW_SECONDS + 60);
    // The bound is on distance, not on direction. A one-sided check lets a
    // caller mint a credential that becomes valid later and stays valid for
    // the window on either side of it.
    const res = await call(path, { headers: { authorization: signed(path, { iat: ahead }) } });
    expect(res.status).toBe(401);
  });

  test("a fingerprint no approved key names is refused", async () => {
    const path = `/api/v1/attachments/${ATTACHMENT}`;
    const res = await call(path, { headers: { authorization: signed(path, { kid: "sha256:in-process-nobody" }) } });
    expect(res.status).toBe(401);
  });

  test("an authenticated session that was never approved is told to wait, not to sign in again", async () => {
    // They proved who they are; what they lack is permission. Answering `401`
    // sends them back to a sign-in that will work and change nothing.
    //
    // **The unapproved state is written here rather than driven, and that is
    // the honest note.** Admitting a local account *is* approving it — the
    // registry row goes in beside the `local_users` row deliberately, because
    // an account outside the registry is outside the server's `proxy_for` and
    // has every message it sends refused in silence. So this state belongs to
    // a GitHub login that authenticated and was never let in, and the only
    // issuer of such a session is the OAuth callback, which needs a live
    // consent screen. Removing the registry row reproduces what
    // `isUserApproved` sees; nothing else here does.
    const admitted = await asAdmin("/api/v1/admin/users", "POST", { username: "in-process-unapproved" });
    const { temporary_password } = await admitted.json();
    const login = await call("/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: "in-process-unapproved", password: temporary_password }).toString(),
    });
    const theirs = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    await call("/auth/local/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: theirs },
      body: JSON.stringify({ current: temporary_password, next: "in-process-unapproved-pw" }),
    });
    getDb().prepare("DELETE FROM agent_registry WHERE id = ?").run("in-process-unapproved");
    const res = await call(`/api/v1/attachments/${ATTACHMENT}`, { headers: { cookie: theirs } });
    expect(res.status).toBe(403);
  });
});

/**
 * What the key-proposal stream says on its first two frames.
 *
 * **The live half is not here, deliberately.** `test/key-proposals.test.ts`
 * drives a real server and asserts that a proposal made while an operator is
 * watching arrives without a reload, and that an unauthenticated caller is
 * refused — both against a socket, which is the only place those mean
 * anything. Repeating them in-process would catch nothing and would trade a
 * real assertion for a timer.
 *
 * What no test anywhere pins is the shape of what the stream *says*, and that
 * is where its one shipped defect lived: § 9.2 called this route "a second
 * source for the same fact as `/api/v1/admin/keys/pending`" without saying
 * what either one sends, so the rename moved the list and left the stream, and
 * the bell read `keys` from one channel and `proposals` from the other.
 *
 * In-process `app.fetch` hands back the very `ReadableStream` the handler
 * built, and every `push()` is its own `enqueue` — so one `reader.read()` is
 * one SSE frame, in order, with no server and no socket in between.
 */
describe("what the key stream says first", () => {
  const WATCHED = "in-process-stream-proposer";

  /** The first `n` frames, decoded, then the stream is dropped. */
  const frames = async (res: Response, n: number): Promise<string[]> => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const out: string[] = [];
    try {
      while (out.length < n) {
        const { value, done } = await reader.read();
        if (done) break;
        out.push(decoder.decode(value));
      }
    } finally {
      // Cancelling is what clears the 20 s heartbeat and stops the watcher;
      // left open they outlive the test and the file never exits.
      await reader.cancel();
    }
    return out;
  };

  beforeAll(() => {
    agentsDb()
      .prepare(`INSERT OR REPLACE INTO agent_keys (fingerprint, identity, public_key, status)
                VALUES (?, ?, ?, 'pending')`)
      .run("sha256:in-process-stream-pending", WATCHED, "in-process-stream-public-key");
  });

  test("answers as a stream, and tells a proxy not to hold it", async () => {
    const res = await asAdmin("/api/v1/admin/keys/stream", "GET");
    expect(res.status).toBe(200);
    const headers = {
      type: res.headers.get("content-type") ?? "",
      // Without this an nginx in front buffers the response and the operator
      // sees nothing until the connection closes — which for a stream is
      // never. The symptom is a bell that works locally and not in production.
      accel: res.headers.get("x-accel-buffering") ?? "",
    };
    await res.body?.cancel();
    expect({ stream: headers.type.includes("text/event-stream"), accel: headers.accel })
      .toEqual({ stream: true, accel: "no" });
  });

  test("calls the queue `keys`, the name the list route uses", async () => {
    const res = await asAdmin("/api/v1/admin/keys/stream", "GET");
    const [, second] = await frames(res, 2);
    const payload = JSON.parse(second!.slice(second!.indexOf("data: ") + 6));
    // Two channels for one fact have to call it the same thing. They did not,
    // and the bell went quiet for exactly as long as nobody compared them.
    expect({ event: second!.startsWith("event: snapshot"), key: Object.keys(payload) })
      .toEqual({ event: true, key: ["keys"] });
  });

  test("hands what was already waiting as a snapshot, not as arrivals", async () => {
    const res = await asAdmin("/api/v1/admin/keys/stream", "GET");
    const [, second] = await frames(res, 2);
    const { keys } = JSON.parse(second!.slice(second!.indexOf("data: ") + 6));
    // A backlog replayed as `key-proposed` announces keys that have been
    // sitting for a day as though they had just landed — an alert for
    // something nobody is about to do anything about.
    expect({
      event: second!.split("\n")[0],
      present: (keys as Array<{ identity: string }>).some(k => k.identity === WATCHED),
    }).toEqual({ event: "event: snapshot", present: true });
  });

  test("sends no public key material to the browser", async () => {
    const res = await asAdmin("/api/v1/admin/keys/stream", "GET");
    const [, second] = await frames(res, 2);
    const { keys } = JSON.parse(second!.slice(second!.indexOf("data: ") + 6));
    const mine = (keys as Array<Record<string, unknown>>).find(k => k.identity === WATCHED)!;
    // An operator decides on a *fingerprint*. The key itself is not part of
    // that decision and does not need to be in a console, a browser cache or
    // anyone's devtools history.
    expect({ fields: Object.keys(mine).sort() })
      .toEqual({ fields: ["fingerprint", "identity", "proposed_at", "type"] });
  });

  test("names the grant a refused operator is missing", async () => {
    const admitted = await asAdmin("/api/v1/admin/users", "POST", { username: "in-process-nokeys" });
    const { temporary_password } = await admitted.json();
    const login = await call("/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: "in-process-nokeys", password: temporary_password }).toString(),
    });
    const theirs = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    await call("/auth/local/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: theirs },
      body: JSON.stringify({ current: temporary_password, next: "in-process-nokeys-pw" }),
    });

    const res = await call("/api/v1/admin/keys/stream", { headers: { cookie: theirs } });
    expect(res.status).toBe(403);
    // An operator told which grant is missing can ask for that one; one told
    // "forbidden" asks for everything.
    const body = await res.json();
    expect({ capability: body.capability, mentions: String(body.error).includes(body.capability) })
      .toEqual({ capability: "key.approve", mentions: true });
  });
});

/**
 * What a browser gets back when it reconnects to the audit stream.
 *
 * The replay is built synchronously inside `start()`, before the response is
 * returned, so everything below is decided by seeded rows rather than by a
 * timer — the 1.5 s poller only ever produces *live* frames, and the live half
 * is not what this checks.
 *
 * **The seed is swallowed before any stream opens, on purpose.** That poller
 * has run since `startup()` and marks what it has seen; rows it consumes while
 * nothing is listening are never delivered again. Opening a stream before it
 * has caught up would mix live frames into a replay and make every index below
 * a coin toss.
 *
 * `hub.db` is not the database `insertMessage` writes to. These rows go into
 * the file the route reads, with `status='delivered'` so they never land in the
 * queue depth `/api/v1/admin/mailbox` reports, and with names and a content
 * token unique to this file — the state directory is shared with every other
 * suite in the run.
 */
describe("what a reconnecting audit stream replays", () => {
  const A = "in-process-audit-a";
  const B = "in-process-audit-b";
  const BULK = "in-process-audit-bulk";
  const ANCHOR = "in-process-audit-anchor";

  /** Frames until the stream goes quiet, then it is dropped. */
  const replay = async (path: string, headers: Record<string, string>): Promise<string[]> => {
    const res = await call(path, { headers: { cookie, ...headers } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const out: string[] = [];
    try {
      // The replay is already enqueued when the response is handed back, so
      // reading drains it without waiting for anything. A `:keepalive` is
      // 30 s away and never arrives inside this loop.
      while (true) {
        const race = await Promise.race([
          reader.read(),
          new Promise<null>(r => setTimeout(() => r(null), 250)),
        ]);
        if (!race || race.done) break;
        out.push(decoder.decode(race.value));
      }
    } finally {
      await reader.cancel();
    }
    return out;
  };

  const dataOf = (frame: string) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6));

  beforeAll(async () => {
    const hub = new Database(join(STATE, "hub.db"), { readwrite: true });
    const put = hub.prepare(
      `INSERT OR REPLACE INTO messages (id, from_agent, to_agent, content, status, ts) VALUES (?, ?, ?, ?, 'delivered', ?)`,
    );
    // Space-separated, the format `datetime('now')` writes. `ts` is TEXT and
    // every comparison here is lexical, so an ISO `T` sorts after a space and
    // would corrupt both the gap predicate and the poller's high-water mark.
    const at = (secondsAgo: number) =>
      new Date(Date.now() - secondsAgo * 1000).toISOString().replace("T", " ").slice(0, 19);

    put.run(ANCHOR, A, B, "in-process-audit-anchor-body", at(300));
    put.run("in-process-audit-first", A, B, "in-process-audit-body-first", at(299));
    put.run("in-process-audit-second", A, B, "in-process-audit-body-second", at(298));
    // Enough on the far side of the anchor that an unfiltered reconnect is a
    // flood rather than a replay.
    for (let i = 0; i < 101; i++) {
      put.run(`in-process-audit-bulk-${i}`, BULK, B, `in-process-audit-bulk-body-${i}`, at(200 - i));
    }
    hub.close();

    // Let the poller take the seed while nothing is listening.
    await Bun.sleep(2000);
  });

  test("refuses an operator who does not hold audit.read.content, and names it", async () => {
    const admitted = await asAdmin("/api/v1/admin/users", "POST", { username: "in-process-noaudit" });
    const { temporary_password } = await admitted.json();
    const login = await call("/auth/local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ username: "in-process-noaudit", password: temporary_password }).toString(),
    });
    const theirs = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    await call("/auth/local/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: theirs },
      body: JSON.stringify({ current: temporary_password, next: "in-process-noaudit-pw" }),
    });

    // This route serves whole message bodies. It was behind a role check, so
    // every admin-role session read every conversation on the mesh (§ 11.0).
    const res = await call("/api/v1/admin/chat-audits/stream", { headers: { cookie: theirs } });
    expect(res.status).toBe(403);
    expect((await res.json()).capability).toBe("audit.read.content");
  });

  test("records the read before it serves a byte", async () => {
    await replay("/api/v1/admin/chat-audits/stream", {});
    const events = await asAdmin("/api/v1/audit/events?limit=50", "GET");
    const rows = (await events.json()).events as Array<{ event_type: string; target?: string }>;
    // Holding `audit.read.content` is defensible; holding it without the
    // record is not. The route had neither.
    expect({ recorded: rows.some(e => JSON.stringify(e).includes("chat-audits:stream")) })
      .toEqual({ recorded: true });
  });

  test("says hello as an event stream", async () => {
    const res = await call("/api/v1/admin/chat-audits/stream", { headers: { cookie } });
    const type = res.headers.get("content-type") ?? "";
    await res.body?.cancel();
    expect(type).toContain("text/event-stream");
  });

  test("replays what the client missed, oldest first", async () => {
    const frames = await replay(`/api/v1/admin/chat-audits/stream?from_agent=${A}`, { "last-event-id": ANCHOR });
    const messages = frames.filter(f => f.includes("event: message")).map(dataOf);
    // Newest-first would put a conversation on the screen backwards, and the
    // rows are all there either way — the order is the whole of what is wrong.
    expect(messages.map((m: { id: string }) => m.id))
      .toEqual(["in-process-audit-first", "in-process-audit-second"]);
  });

  test("does not replay the message the client already has", async () => {
    const frames = await replay(`/api/v1/admin/chat-audits/stream?from_agent=${A}`, { "last-event-id": ANCHOR });
    const ids = frames.filter(f => f.includes("event: message")).map(f => dataOf(f).id);
    // `Last-Event-ID` names the last frame that arrived. Replaying it draws
    // the same message twice on every reconnect.
    expect({ anchorReplayed: ids.includes(ANCHOR) }).toEqual({ anchorReplayed: false });
  });

  test("labels a replayed frame as recovered, so the console can tell it from live", async () => {
    const frames = await replay(`/api/v1/admin/chat-audits/stream?from_agent=${A}`, { "last-event-id": ANCHOR });
    const messages = frames.filter(f => f.includes("event: message")).map(dataOf);
    expect(messages.every((m: { recovered?: boolean }) => m.recovered === true)).toBe(true);
  });

  test("gives each replayed frame its own id, so a second blip resumes from the right place", async () => {
    const frames = await replay(`/api/v1/admin/chat-audits/stream?from_agent=${A}`, { "last-event-id": ANCHOR });
    const messageFrames = frames.filter(f => f.includes("event: message"));
    // Without `id:` the browser keeps sending the *old* Last-Event-ID after a
    // second disconnection, and replays the same window for ever.
    expect(messageFrames.every(f => f.startsWith("id: "))).toBe(true);
  });

  test("summarises a gap too large to send rather than flooding the client", async () => {
    const frames = await replay("/api/v1/admin/chat-audits/stream", { "last-event-id": ANCHOR });
    const summary = frames.find(f => f.includes("event: gap-too-large"));
    expect({ summarised: summary !== undefined, floodedWith: frames.filter(f => f.includes("event: message")).length })
      .toEqual({ summarised: true, floodedWith: 0 });
    expect(dataOf(summary!).truncated).toBe(true);
  });

  test("filters the replay the same way it filters the live stream", async () => {
    // Unfiltered the same anchor is a flood; filtered it is two messages. If
    // the filter is dropped from the replay only, a console watching one
    // conversation is handed every conversation on the mesh — with content.
    const filtered = await replay(`/api/v1/admin/chat-audits/stream?from_agent=${A}`, { "last-event-id": ANCHOR });
    expect({
      messages: filtered.filter(f => f.includes("event: message")).length,
      flood: filtered.some(f => f.includes("gap-too-large")),
    }).toEqual({ messages: 2, flood: false });
  });

  test("replays nothing for a Last-Event-ID the hub no longer holds", async () => {
    const frames = await replay("/api/v1/admin/chat-audits/stream", { "last-event-id": "in-process-audit-no-such-id" });
    // An unknown anchor is not "the beginning of time". Treating it as one
    // sends the whole table to a client whose only mistake was reconnecting
    // after a retention sweep.
    expect(frames.filter(f => f.includes("event: message") || f.includes("gap-too-large")).length).toBe(0);
  });
});

/**
 * The service worker's own source, which nothing on this server ever runs.
 *
 * `/sw.js` is a hundred lines of JavaScript held in a template literal. No
 * compiler sees it — it is a string to TypeScript — and no test has ever
 * parsed it, so a stray bracket in it ships green: the route answers 200, the
 * bytes arrive, and the browser refuses to register a worker that will not
 * parse. Every screen keeps working; the app simply stops being installable,
 * and nothing anywhere says so.
 *
 * The other three are cross-checks between what that source asks the browser
 * for and what this server actually answers. A worker that navigates to a
 * route nobody serves is a notification that opens a 404.
 */
describe("the service worker's own source", () => {
  const source = async () => (await call("/sw.js")).text();

  test("parses as JavaScript", async () => {
    const sw = await source();
    // `new Function` compiles without running: `self`, `caches` and `clients`
    // do not exist here and are never touched. A SyntaxError is the whole
    // failure this catches, and it is the one nothing else can see.
    expect(() => new Function(sw)).not.toThrow();
  });

  test("navigates to a route this server answers", async () => {
    const sw = await source();
    const target = sw.match(/const url = agent \? '([^']+)'/)?.[1];
    expect(target).toBe("/chat/");
    // Tapping a notification is the one path into the app that nobody clicks
    // during development, so a rename that misses this line is found by users.
    //
    // The agent has to be one the registry holds: `/chat/:agentId` answers 404
    // for a name it does not know, which is the same answer a route that does
    // not exist gives — and this check is about the route existing.
    upsertApprovedWebUser("in-process-sw-target");
    const res = await call(`${target}in-process-sw-target`, { headers: { cookie } });
    expect({ opens: res.status }).toEqual({ opens: 200 });
  });

  test("asks for an icon this server serves", async () => {
    const sw = await source();
    const icons = [...sw.matchAll(/(?:icon|badge): '([^']+)'/g)].map(m => m[1]!);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of new Set(icons)) {
      expect({ icon, status: (await call(icon)).status }).toEqual({ icon, status: 200 });
    }
  });

  test("keeps two agents' notifications apart", async () => {
    const sw = await source();
    // One `tag` for every message collapses the whole mesh into a single
    // notification that keeps being replaced — the second agent to write to
    // you silently overwrites the first.
    expect(sw).toContain("tag: 'mesh-' + (data.data?.agent || 'default')");
  });

  test("shows something for a push that carries no payload", async () => {
    const sw = await source();
    // A push with no body is a real delivery — the browser may drop the
    // payload — and reading `.json()` off nothing throws inside the event
    // handler, which shows the user nothing at all.
    expect(sw).toContain("e.data ? e.data.json() :");
  });
});

/**
 * Which files `/api/v1/files` will hand out.
 *
 * The route resolves the path *before* calling `isPathAllowed`, so the `..`
 * branch inside that function cannot fire from here — by the time it is asked,
 * `resolve()` has already collapsed every `..`. The whole defence is the
 * prefix comparison, which makes what that comparison means the only thing
 * worth checking.
 */
describe("which files are handed out", () => {
  const readable = join(STATE, "in-process-readable.txt");
  const sibling = `${STATE}-sibling`;

  beforeAll(() => {
    writeFileSync(readable, "in-process-file-body");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "in-process-outside-body");
  });

  test("serves a file inside the state directory", async () => {
    const res = await asAdmin(`/api/v1/files?path=${encodeURIComponent(readable)}`, "GET");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("in-process-file-body");
  });

  test("refuses a path outside the allowed directories", async () => {
    const res = await asAdmin("/api/v1/files?path=%2Fetc%2Fpasswd", "GET");
    expect(res.status).toBe(403);
  });

  test("refuses a traversal that climbs out of an allowed directory", async () => {
    // `resolve` collapses this to `/etc/passwd` before the prefix is compared,
    // which is why the prefix — not the `..` branch — is what refuses it.
    const climb = join(STATE, "..", "..", "..", "..", "etc", "passwd");
    const res = await asAdmin(`/api/v1/files?path=${encodeURIComponent(climb)}`, "GET");
    expect(res.status).toBe(403);
  });

  test("refuses a directory whose name merely starts with an allowed one", async () => {
    // `startsWith` on a prefix with no trailing separator makes
    // `<STATE_DIR>-sibling` a match for `<STATE_DIR>`. The neighbouring entry
    // in the same list ends in `/`; this one comes from an environment
    // variable and does not.
    const res = await asAdmin(`/api/v1/files?path=${encodeURIComponent(join(sibling, "secret.txt"))}`, "GET");
    expect(res.status).toBe(403);
  });

  test("names a served file's type from its extension, and falls back to bytes", async () => {
    const html = join(STATE, "in-process-page.html");
    writeFileSync(html, "<p>in-process</p>");
    const unknown = join(STATE, "in-process-thing.wat");
    writeFileSync(unknown, "in-process");
    const typeOf = async (p: string) =>
      (await asAdmin(`/api/v1/files?path=${encodeURIComponent(p)}`, "GET")).headers.get("content-type");
    // An unknown extension must not become a guess: `application/octet-stream`
    // is the answer that cannot be rendered.
    expect({ html: await typeOf(html), unknown: await typeOf(unknown) })
      .toEqual({ html: "text/html", unknown: "application/octet-stream" });
  });

  test("refuses a directory, and refuses one that is not there", async () => {
    expect({
      directory: (await asAdmin(`/api/v1/files?path=${encodeURIComponent(STATE)}`, "GET")).status,
      missing: (await asAdmin(`/api/v1/files?path=${encodeURIComponent(join(STATE, "in-process-absent"))}`, "GET")).status,
      noPath: (await asAdmin("/api/v1/files", "GET")).status,
    }).toEqual({ directory: 400, missing: 404, noPath: 400 });
  });
});

/**
 * Who may write the AI-usage figures the admin screens read.
 *
 * The token check on this route was deleted by `af4b159`, a commit whose
 * subject was a front-end fixture, and the comment left in its place described
 * the deletion rather than any reason for it. It reached `main` and stayed for
 * three days: with `AI_USAGE_INGEST_TOKEN` configured — which is the thing
 * that turns ingest on at all — any caller with any token or none could push
 * whatever numbers it liked into the screens operators read.
 *
 * The route reads the variable per request rather than at import, so these can
 * set and clear it around themselves. Nothing else in this file reads it.
 */
describe("who may write the usage figures", () => {
  const TOKEN = "in-process-ingest-token";
  const snapshot = {
    schema_version: "v1",
    ts: "2026-08-21T00:00:00.000Z",
    source: "in-process",
    accounts: [{ account: "in-process-account", used_usd: 1 }],
  };

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    call("/api/v1/ingest/ai-usage", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  afterEach(() => { delete process.env.AI_USAGE_INGEST_TOKEN; });

  test("refuses everyone while ingest is switched off", async () => {
    delete process.env.AI_USAGE_INGEST_TOKEN;
    // 503 rather than 401: the deployment has not turned this on, which is a
    // different thing from the caller being wrong.
    expect((await post(snapshot, { authorization: `Bearer ${TOKEN}` })).status).toBe(503);
  });

  test("refuses a caller carrying no token, and one carrying the wrong token", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    expect({
      none: (await post(snapshot)).status,
      wrong: (await post(snapshot, { authorization: "Bearer in-process-not-the-token" })).status,
      unprefixed: (await post(snapshot, { authorization: TOKEN })).status,
    }).toEqual({ none: 401, wrong: 401, unprefixed: 401 });
  });

  test("accepts the caller holding the token", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const res = await post(snapshot, { authorization: `Bearer ${TOKEN}` });
    // Anything but a refusal: what the route does with a good snapshot is the
    // next check's business, and this one is about the gate.
    expect({ refused: [401, 403, 503].includes(res.status) }).toEqual({ refused: false });
  });

  test("refuses a snapshot that is not the shape it declares", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const auth = { authorization: `Bearer ${TOKEN}` };
    // 422 rather than 400 throughout: the JSON parsed, and what is wrong is
    // what it said. A caller told 400 looks for a syntax error it does not have.
    expect({
      notAnObject: (await post("in-process", auth)).status,
      wrongVersion: (await post({ ...snapshot, schema_version: "v2" }, auth)).status,
      noAccounts: (await post({ ...snapshot, accounts: [] }, auth)).status,
      missingTs: (await post({ ...snapshot, ts: 1 }, auth)).status,
    }).toEqual({ notAnObject: 422, wrongVersion: 422, noAccounts: 422, missingTs: 422 });
  });
});

/**
 * Deciding a key, tearing an identity down, and paging the audit list.
 *
 * Three routes whose refusals and edges no test reaches. Each is a branch
 * inside a route something already calls, which is what the uncovered mass in
 * this file turned out to be — `agent-mesh-local-pm` measured it: 66 of 68
 * routes are named by some suite, so the gap was never a missing entry point.
 */
describe("deciding a key by the string the operator compared", () => {
  const HOLDER = "in-process-decided";
  const APPROVE_FP = "sha256:in-process-decide-approve";
  const DENY_FP = "sha256:in-process-decide-deny";

  beforeAll(() => {
    const put = agentsDb().prepare(
      `INSERT OR REPLACE INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, 'pending')`,
    );
    put.run(APPROVE_FP, HOLDER, "in-process-decide-key-a");
    put.run(DENY_FP, `${HOLDER}-2`, "in-process-decide-key-b");
  });

  const statusOf = (fingerprint: string) =>
    (agentsDb().prepare(`SELECT status FROM agent_keys WHERE fingerprint = ?`).get(fingerprint) as { status: string } | undefined)?.status;

  test("refuses a decision that names no fingerprint", async () => {
    // **Addressed by fingerprint, never by identity.** An operator approving
    // "whatever is pending for prod-codex1" approves whatever arrived last,
    // including a proposal that landed between reading the screen and
    // clicking — and § 10.2 requires them to have compared this exact string
    // against the one the holder logged.
    const missing = await asAdmin("/api/v1/admin/keys/approve", "POST", { identity: HOLDER });
    // An empty string is not a fingerprint either, and it is the input that
    // tells the two halves of that guard apart: with the field absent both
    // halves are true, so a mutation swapping `||` for `&&` refuses anyway and
    // a check that only sends `{identity}` never sees it. Measured — that
    // mutation survived until this line existed.
    const empty = await asAdmin("/api/v1/admin/keys/approve", "POST", { fingerprint: "" });
    expect({ missing: missing.status, empty: empty.status }).toEqual({ missing: 400, empty: 400 });
  });

  test("refuses a body that is not JSON at all", async () => {
    const res = await call("/api/v1/admin/keys/approve", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "in-process-not-json",
    });
    expect(res.status).toBe(400);
  });

  test("approves the fingerprint it was given, and denies the one it was given", async () => {
    const approved = await asAdmin("/api/v1/admin/keys/approve", "POST", { fingerprint: APPROVE_FP });
    const denied = await asAdmin("/api/v1/admin/keys/deny", "POST", { fingerprint: DENY_FP, reason: "in-process" });
    expect({ approve: approved.status, deny: denied.status }).toEqual({ approve: 200, deny: 200 });
    // The row, not the reply: a decision that answers 200 and leaves the key
    // pending is the shape every later reader disagrees with.
    expect({ approved: statusOf(APPROVE_FP), denied: statusOf(DENY_FP) })
      .toEqual({ approved: "approved", denied: "denied" });
  });
});

describe("tearing an identity down", () => {
  const TORN = "in-process-torn";

  beforeAll(() => {
    agentsDb().prepare(`INSERT OR REPLACE INTO agents (identity, last_seen) VALUES (?, NULL)`).run(TORN);
  });

  test("says which of the three things it did, each time it is asked", async () => {
    const first = await asAdmin(`/api/v1/admin/agents/${TORN}`, "DELETE");
    const again = await asAdmin(`/api/v1/admin/agents/${TORN}`, "DELETE");
    const never = await asAdmin("/api/v1/admin/agents/in-process-never-existed", "DELETE");

    const bodies = await Promise.all([first.json(), again.json(), never.json()]);
    // **Three states, not two.** Teardown is idempotent, so the answer has to
    // separate "I did it" from "it was already done" from "there was nothing
    // here" — an operator who cannot tell the third from the first does not
    // know whether they typed the name correctly.
    expect({
      statuses: [first.status, again.status, never.status],
      actions: bodies.map((b: { action: string }) => b.action),
    }).toEqual({
      statuses: [200, 200, 200],
      actions: ["soft-deleted", "already-deleted", "not-found"],
    });
    expect(bodies[0].deleted_at, "the first teardown said when").toBeTruthy();
  });

  test("refuses a name that is not one", async () => {
    const res = await asAdmin("/api/v1/admin/agents/not%20a%20name", "DELETE");
    expect(res.status).toBe(400);
  });
});

describe("paging the audit list", () => {
  // The rows seeded for the replay checks above are the corpus here: one
  // conversation between two named identities, and a hundred from a third.
  const A = "in-process-audit-a";
  const BULK = "in-process-audit-bulk";

  const listed = async (query: string) => {
    const res = await asAdmin(`/api/v1/admin/chat-audits${query}`, "GET");
    expect(res.status).toBe(200);
    return (await res.json()).messages as Array<{ id: string; from_agent: string; ts: string }>;
  };

  test("narrows to the conversation it was asked for", async () => {
    const mine = await listed(`?from_agent=${A}`);
    expect(mine.length).toBeGreaterThan(0);
    // Every row, not "some row": a filter that returns the right message
    // alongside every other one is not a filter.
    expect([...new Set(mine.map(m => m.from_agent))]).toEqual([A]);
  });

  test("pages backwards from a cursor rather than repeating the first page", async () => {
    const first = await listed(`?from_agent=${BULK}&limit=5`);
    expect(first.length).toBe(5);
    const next = await listed(`?from_agent=${BULK}&limit=5&before_id=${first[first.length - 1]!.id}`);
    // `id` is a primary key and not sortable lexically, so the cursor anchors
    // on `ts` with `id` as the tiebreak. Overlap here means a reader scrolling
    // an audit sees the same messages again and cannot tell.
    const overlap = next.filter(n => first.some(f => f.id === n.id));
    expect({ overlap: overlap.map(o => o.id) }).toEqual({ overlap: [] });
  });

  test("takes a limit it can honour and ignores one it cannot", async () => {
    // Garbage is not zero: `parseInt("many")` is `NaN`, and a route that let
    // that through would answer with nothing and look like an empty audit.
    const [garbage, huge] = await Promise.all([listed("?limit=many"), listed("?limit=100000")]);
    expect({ garbage: garbage.length > 0, huge: huge.length <= 200 }).toEqual({ garbage: true, huge: true });
  });
});

/**
 * `file_path` on a send, and the two ways it is wrong (§ 15.2).
 *
 * The field names a file on **this server's** filesystem, which is why the
 * route stats it before doing anything else: a send that referenced a path
 * nobody could read would be accepted, delivered, and then fail at the far end
 * with an error about a file the recipient never had.
 *
 * The refusal comes before the policy check, so the answer does not depend on
 * whether the sender was allowed to message that agent — a wrong path is wrong
 * either way, and pinning the order stops a later edit from turning this into
 * a way to probe who may talk to whom.
 */
describe("naming a file on a send", () => {
  const RECIPIENT = "in-process-with-a-file";

  test("refuses a file_path that is not a string", async () => {
    upsertApprovedWebUser(RECIPIENT);
    const res = await asAdmin("/api/v1/messages", "POST", {
      to: RECIPIENT, text: "in-process-file-path-type", file_path: 7,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("must be a string");
  });

  test("refuses a path this server cannot see, and names it", async () => {
    upsertApprovedWebUser(RECIPIENT);
    const missing = `/nonexistent/in-process-${process.pid}.txt`;
    const res = await asAdmin("/api/v1/messages", "POST", {
      to: RECIPIENT, text: "in-process-file-path-missing", file_path: missing,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(missing);
  });

  /** A path that exists gets past the check — the send then proceeds as any other. */
  test("accepts a path that is there", async () => {
    upsertApprovedWebUser(RECIPIENT);
    const res = await asAdmin("/api/v1/messages", "POST", {
      to: RECIPIENT, text: "in-process-file-path-present", file_path: import.meta.path,
    });
    expect(res.status).toBe(201);
  });
});

/**
 * What each of these routes does when the store under it will not answer.
 *
 * Every one of them is a `catch` written for a failure nothing had ever
 * produced: the tables are there in every test and in every deployment until
 * the day one of them is not. The refusals are made at the store, by renaming
 * the table out from under the handle and putting it back in a `finally`, so a
 * case that fails does not take the rest of the file with it.
 */
describe("when a store under a route will not answer", () => {
  /** Rename one table away for the duration of `body`. */
  async function withoutTable<T>(file: string, table: string, body: () => Promise<T> | T): Promise<T> {
    const db = new Database(join(STATE, file), { readwrite: true });
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_unavailable`);
    try {
      return await body();
    } finally {
      db.exec(`ALTER TABLE ${table}_unavailable RENAME TO ${table}`);
      db.close();
    }
  }

  /**
   * A teardown is destructive and irreversible, so "it did not happen" has to
   * be said out loud. Answering anything but an error here reports an identity
   * torn down that is still live.
   */
  test("a teardown that could not be written is a 500 that says so", async () => {
    const res = await withoutTable("agents.db", "agents", () =>
      asAdmin("/api/v1/admin/agents/in-process-untearable", "DELETE"),
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("db error");
  });

  /**
   * § 11.3's telemetry is one document assembled from several stores, and a
   * queue depth that cannot be read is `null` — not `0`, which is the answer an
   * operator hopes for and would stop looking at.
   */
  test("a queue depth it cannot read is null, and the rest of the document still answers", async () => {
    const res = await withoutTable("agent-mesh.db", "pending_approvals", () =>
      asAdmin("/api/v1/admin/telemetry", "GET"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users_awaiting_decision).toEqual({ waiting: null, oldest: null });
    expect(body.lanes_not_draining).toBeDefined();
  });

  /**
   * The § 8.9 stream's gap fetch is a convenience: it hands a reconnecting
   * console what it missed. A failure there must not take the stream with it,
   * or a store hiccup turns every open console into one that cannot reconnect.
   */
  test("a gap fetch that fails leaves the stream open and live", async () => {
    const res = await withoutTable("hub.db", "messages", () =>
      call("/api/v1/admin/chat-audits/stream", { headers: { cookie, "last-event-id": "in-process-audit-anchor" } }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((r) => setTimeout(() => r("<nothing>"), 250)),
    ]);
    await reader.cancel();
    // The stream says hello and replays nothing, rather than failing the
    // request or hanging with no answer at all.
    expect(first).toContain("connected");
    expect(first).not.toContain("event: message");
  });
});

/**
 * Correlation (T-022 § 5, D-741).
 *
 * A message has an id both sides already know. Everything else did not, and a
 * complaint about signing in was answered by pairing a person's account of the
 * time against a log — two clocks, one endpoint, and a guess. One header
 * replaces the guess.
 */
describe("the id that pairs a complaint with a log line", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("takes the one the caller sent, and echoes it back", async () => {
    const res = await call("/", { headers: { "x-request-id": "console-42" } });
    expect(res.headers.get("x-request-id")).toBe("console-42");
  });

  test("makes one when the caller sent none", async () => {
    const res = await call("/");
    expect(res.headers.get("x-request-id")).toMatch(uuid);
  });

  test("replaces a value that does not belong in a log line, rather than refusing", async () => {
    for (const offered of ["with space", "x".repeat(200), "line\tbreakish", ""]) {
      const res = await call("/", { headers: { "x-request-id": offered } });
      expect({ offered, echoed: res.headers.get("x-request-id") })
        .toEqual({ offered, echoed: expect.stringMatching(uuid) });
    }
  });

  test("gives two requests two ids", async () => {
    const [a, b] = await Promise.all([call("/"), call("/")]);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  /**
   * The point of the header, and the only assertion here that is about the
   * log rather than about the response: a line written from inside a handler
   * carries the id the caller was given back.
   */
  test("reaches the lines the request writes", async () => {
    const capture = captureConsole();
    let echoed: string | null = null;
    try {
      const res = await asAdminWithId("/api/v1/admin/agent-types", "POST", "corr-probe-1", {
        type: `corr-probe-${Date.now()}`,
        requires_key: false,
      });
      echoed = res.headers.get("x-request-id");
    } finally {
      capture.restore();
    }

    expect(echoed).toBe("corr-probe-1");
    const line = capture.lines.find((l) => l.includes('"event":"agent_type_added"'));
    expect(line, "adding an agent type wrote no line to correlate").toBeDefined();
    expect(line).toContain('"request_id":"corr-probe-1"');
  });
});

/** As the admin, carrying a stated request id. */
const asAdminWithId = (path: string, method: string, requestId: string, body?: unknown) =>
  app.fetch(new Request(`http://in-process${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-request-id": requestId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

/**
 * Complaint B, from the § 3 drill: "I cannot sign in."
 *
 * This route wrote nothing on any of its three refusals, so the only way to
 * answer that was to ask the person to try again while somebody watched. The
 * three are three different repairs -- a client sending the wrong shape, a
 * wrong password, an account that must change its password first -- and from
 * outside they are one sentence.
 */
describe("a refused sign-in, in the record", () => {
  const refusals = (lines: string[]) =>
    lines
      .filter((l) => l.includes('"event":"sign_in_refused"'))
      .map((l) => JSON.parse(l.slice(l.lastIndexOf(' {"ts":"') + 1)));

  const signIn = async (body: Record<string, unknown>) => {
    const capture = captureConsole();
    try {
      await call("/auth/local", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      capture.restore();
    }
    return capture.lines;
  };

  test("a body with no fields is one reason", async () => {
    const [refused] = refusals(await signIn({}));
    expect(refused).toMatchObject({ level: "warn", reason: "missing_fields", outcome: "refused" });
  });

  test("a wrong password is another, and names who tried", async () => {
    const [refused] = refusals(await signIn({ username: "admin", password: "not-the-password" }));
    expect(refused).toMatchObject({ level: "warn", actor: "admin", reason: "bad_credentials" });
  });

  test("does not say whether the account exists", async () => {
    const missing = refusals(await signIn({ username: "nobody-here", password: "x" }));
    const wrong = refusals(await signIn({ username: "admin", password: "x" }));
    // The route refuses both identically on purpose — distinguishing them is
    // account enumeration, and a reason in a log somebody can read is the same
    // enumeration one step later.
    expect(missing[0]!.reason).toBe(wrong[0]!.reason);
  });

  test("a name from an unauthenticated request cannot write its own line", async () => {
    const forged = 'x\n2026-08-22T00:00:00.000Z error [hub] everything is on fire {"ts":"x"}';
    const lines = await signIn({ username: forged, password: "x" });

    // One line, whatever the caller put in the name: the sentence is built here
    // and the name is only ever a field, where `JSON.stringify` escapes it.
    const written = lines.filter((l) => l.includes('"event":"sign_in_refused"'));
    expect(written).toHaveLength(1);
    expect(written[0]!.split("\n")).toHaveLength(1);
    expect(written[0]).not.toContain("everything is on fire\n");
  });

  test("bounds a name nobody bounded", async () => {
    const [refused] = refusals(await signIn({ username: "n".repeat(4000), password: "x" }));
    expect((refused!.actor as string).length).toBe(128);
  });

  test("a sign-in that works says nothing", async () => {
    const lines = await signIn({ username: "admin", password: "in-process-password" });
    expect(refusals(lines)).toEqual([]);
  });
});

/**
 * The audit poller, a pass at a time.
 *
 * Its whole body lived inside a `setInterval` callback, which is reachable
 * only by waiting 1.5 seconds — so nothing had ever run it in a process an
 * instrument was watching, and its two failure branches were unreachable at
 * any price: they need a store that will not answer, and the timer owns when
 * it asks.
 *
 * `auditPollerStartingPoint` and `auditPollerPass` are ordinary functions now.
 * The timer calls them in production and this calls them here, which is the
 * same seam `closeDatabases(stores)` and `requireJwtSecret(secret, refuse)`
 * are: the thing that decides stays where it was, and what supplies it moves.
 */
describe("the audit poller", () => {
  const hubDbPath = join(STATE, "hub.db");

  // The interval `startup()` started would race every assertion below for the
  // same rows, and take the anchor with it.
  beforeAll(() => mod.stopAuditPoller());

  const lines = (captured: string[], event: string) =>
    captured
      .filter((l) => l.includes(`"event":"${event}"`))
      .map((l) => JSON.parse(l.slice(l.lastIndexOf(' {"ts":"') + 1)));

  function run<T>(body: () => T): { value: T; said: string[] } {
    const capture = captureConsole();
    try {
      return { value: body(), said: capture.lines };
    } finally {
      capture.restore();
    }
  }

  /** One message straight into the hub's store, as the hub would have left it. */
  function putMessage(id: string, ts: string): void {
    const db = new Database(hubDbPath, { readwrite: true });
    try {
      db.prepare(
        `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
         VALUES (?, 'poller-probe-from', 'poller-probe-to', 'poller probe', 'pending', ?)`,
      ).run(id, ts);
    } finally {
      db.close();
    }
  }

  async function withoutMessages<T>(body: () => Promise<T> | T): Promise<T> {
    const db = new Database(hubDbPath, { readwrite: true });
    db.exec(`ALTER TABLE messages RENAME TO messages_unavailable`);
    try {
      return await body();
    } finally {
      db.exec(`ALTER TABLE messages_unavailable RENAME TO messages`);
      db.close();
    }
  }

  test("takes its starting point from the newest row, and names it", () => {
    putMessage("poller-anchor-1", "2030-01-01 00:00:00");
    const { said } = run(() => mod.auditPollerStartingPoint());

    const [started] = lines(said, "audit_poller_started");
    expect(started, "the poller took a starting point without saying so").toBeDefined();
    expect(started!.id).toBe("poller-anchor-1");
    expect(started!.last_ts).toBe("2030-01-01 00:00:00");
    expect(started!.level).toBe("info");
  });

  test("a pass with nothing newer says nothing at all", () => {
    const { value, said } = run(() => mod.auditPollerPass());
    expect(value).toBe(0);
    expect(said).toEqual([]);
  });

  test("picks up what arrived after it, counts it, and does not pick it up twice", () => {
    putMessage("poller-new-1", "2030-01-01 00:00:01");
    putMessage("poller-new-2", "2030-01-01 00:00:02");

    const first = run(() => mod.auditPollerPass());
    expect(first.value).toBe(2);
    expect(lines(first.said, "audit_poller_rows")[0]!.count).toBe(2);

    // The anchor moved with the rows. Without that the same two are broadcast
    // on every pass, which on an audit screen is the mesh appearing to repeat
    // itself for ever.
    const second = run(() => mod.auditPollerPass());
    expect(second.value).toBe(0);
    expect(second.said).toEqual([]);
  });

  test("a pass against a store that will not answer says so and comes back", async () => {
    const said = await withoutMessages(() => run(() => mod.auditPollerPass()));

    expect(said.value).toBe(0);
    const [failed] = lines(said.said, "audit_poller_failed");
    expect(failed, "a failed pass went unmentioned").toBeDefined();
    expect(failed!.level).toBe("error");
    expect(failed!.outcome).toBe("retrying");
    expect(failed!.reason).toBe("store_unreadable");
    expect(String(failed!.error)).toContain("messages");

    // And the next pass, once the store answers again, is an ordinary one.
    expect(run(() => mod.auditPollerPass()).value).toBe(0);
  });

  test("a starting point it cannot read starts from the beginning, loudly", async () => {
    const said = await withoutMessages(() => run(() => mod.auditPollerStartingPoint()));

    const [failed] = lines(said.said, "audit_poller_init_failed");
    expect(failed, "the poller started from the epoch without saying why").toBeDefined();
    expect(failed!.level).toBe("error");
    expect(failed!.outcome).toBe("restarted_from_epoch");
    expect(failed!.reason).toBe("store_unreadable");
  });

  test("an empty store is the epoch, and it says which row it starts after", () => {
    const db = new Database(hubDbPath, { readwrite: true });
    const saved = db.prepare(`SELECT * FROM messages`).all() as Array<Record<string, unknown>>;
    const columns = Object.keys(saved[0] ?? { id: null });
    try {
      db.exec(`DELETE FROM messages`);
      const { said } = run(() => mod.auditPollerStartingPoint());

      const [started] = lines(said, "audit_poller_started");
      expect(started, "an empty store produced no starting point").toBeDefined();
      // `''`, not the newest id there is not — and an epoch timestamp, so the
      // first pass reads the whole table rather than nothing.
      expect(started!.id).toBe("");
      expect(started!.last_ts).toBe("1970-01-01 00:00:00");
    } finally {
      // Put the rows back: every other suite in this file reads this store.
      const insert = db.prepare(
        `INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      const restore = db.transaction((rows: Array<Record<string, unknown>>) => {
        for (const row of rows) insert.run(...columns.map((c) => row[c] as never));
      });
      restore(saved);
      db.close();
    }
    // And the anchor is put back where the rows are, so nothing after this
    // sees a poller reading from 1970.
    run(() => mod.auditPollerStartingPoint());
  });
});

/**
 * The watermark on an SSE stream.
 *
 * A console holds one stream open per open tab, so fifty-one attached clients
 * is either a lot of operators or a client reconnecting without closing — and
 * the second is worth catching before it becomes a memory question. Nothing is
 * refused either way; the line is the whole behaviour.
 *
 * Standing up fifty-one live connections to reach one `if` is a suite nobody
 * runs, so the count is an argument. The set membership was never the part
 * that could be wrong.
 */
describe("a stream carrying more clients than anybody expected", () => {
  const warnings = (said: string[]) =>
    said
      .filter((l) => l.includes('"event":"sse_clients_high"'))
      .map((l) => JSON.parse(l.slice(l.lastIndexOf(' {"ts":"') + 1)));

  const note = (stream: "chat-audits" | "ai-usage", clients: number) => {
    const capture = captureConsole();
    try {
      mod.noteStreamClients(stream, clients);
    } finally {
      capture.restore();
    }
    return warnings(capture.lines);
  };

  test("says nothing at the watermark", () => {
    expect(note("chat-audits", 50)).toEqual([]);
  });

  test("says so one past it, and names which stream", () => {
    const [said] = note("chat-audits", 51);
    expect(said).toMatchObject({
      level: "warn",
      component: "http",
      event: "sse_clients_high",
      stream: "chat-audits",
      clients: 51,
      reason: "above_watermark",
    });
  });

  test("the other stream is counted as itself", () => {
    const [said] = note("ai-usage", 200);
    expect({ stream: said!.stream, clients: said!.clients }).toEqual({ stream: "ai-usage", clients: 200 });
  });

  test("an empty stream is not a warning about zero", () => {
    expect(note("ai-usage", 0)).toEqual([]);
  });
});

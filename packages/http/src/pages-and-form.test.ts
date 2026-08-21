/**
 * The server-rendered half: the pages a browser lands on, and the form post
 * behind them.
 *
 * These paths answer in HTML and redirects rather than JSON, which is why they
 * went untested — but the branches are not decorative. Whether an unapproved
 * account sees the pending page or the chat page, and whether a browser form
 * that fails leaves with a cookie, are the same authorisation questions the
 * API routes answer, decided again in a second place.
 *
 * **The redirect is the answer here.** A caller with no session is sent to
 * `/`, not refused with `401`: this is a page, and a person who is not signed
 * in wants the sign-in screen. The form's failures are redirects too, each
 * carrying a distinct `?error=` so the landing page can say which of them
 * happened — and none of them carrying a cookie.
 *
 * This file owns the `pg-` prefix.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "pages-and-form-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval, getDb, seedLocalUsers } =
  await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir } = await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const agents = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(agents);
grants.migrate(agents);

/**
 * **Seeded here because this file is the one that would stop it.**
 *
 * `seedLocalUsers` creates `admin` only while `local_users` is empty, and the
 * sign-in cases below admit an account through the admin route. Every test
 * file in this package shares one state directory, so a run that reached this
 * file first left the table non-empty and the documented `admin`/`admin` path
 * never existed for whatever ran next — which is exactly how it was found:
 * `main.in-process.test.ts` failed its own sign-in with `401`.
 */
await seedLocalUsers();

let n = 0;
const uniq = (p: string) => `pg-${p}-${++n}-${process.pid}`;

const page = (path: string, cookie = "") =>
  app.fetch(new Request(`http://pg-probe${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  }));

/** A form post, exactly as a browser sends one: no `accept: application/json`. */
const form = (fields: Record<string, string>) =>
  app.fetch(new Request("http://pg-probe/auth/local", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  }));

/**
 * **The row's role decides, not the token's.** These pages read the user out of
 * the database and ask `isUserApproved(login, row.role)`, and `upsertUser`
 * makes the very first user in an empty table an admin — who is approved by
 * definition. Run alone, this file created that first user, and an
 * "unapproved" account was served the chat page for a reason that had nothing
 * to do with the branch under test. The role is stated here so the test means
 * the same thing whatever ran before it.
 */
async function signedIn(approved: boolean) {
  const login = uniq("person");
  const user = upsertUser(1_040_000 + n, login);
  getDb().prepare("UPDATE users SET role = 'member' WHERE github_id = ?").run(user.github_id);
  createPendingApproval(login, user.github_id);
  if (approved) expect(approveUser(login)).toBe(true);
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

function registerAgent(id: string) {
  getDb().prepare(
    "INSERT OR IGNORE INTO agent_registry (id, name, channel, type, approved) VALUES (?, ?, 'mesh', 'agent', 1)",
  ).run(id, id);
  return id;
}

describe("the chat pages", () => {
  test("send a visitor with no session to the sign-in screen", async () => {
    for (const path of ["/chat", `/chat/${uniq("agent")}`]) {
      const res = await page(path);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  /**
   * A signed cookie for a user row that is not there. The signature is good —
   * the account was deleted, or the store was replaced — and the page cannot
   * be built, so it is the same answer as no session at all.
   */
  test("send a valid session for a user who is gone to the same place", async () => {
    const jwt = await signJwt({ github_id: 987_654_321, github_login: uniq("ghost"), role: "member" });
    for (const path of ["/chat", `/chat/${uniq("agent")}`]) {
      const res = await page(path, `mesh_token=${jwt}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  /**
   * Waiting on an admin is not the same as being turned away: it has its own
   * page.
   *
   * **Asserted on the title, not on the login.** Both pages render the
   * person's name, so a chat page served to an unapproved account contains
   * everything a first draft of this test looked for — the registered mutation
   * that drops the approval check passed it. The two pages differ by which one
   * they are.
   */
  test("tell an account still waiting that it is waiting", async () => {
    const who = await signedIn(false);
    const agent = registerAgent(uniq("agent"));
    for (const path of ["/chat", `/chat/${agent}`]) {
      const res = await page(path, who.cookie);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(`${path}: ${html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "no title"}`)
        .toBe(`${path}: Agent Mesh - Pending Approval`);
      expect(html).toContain(who.login);
    }
  });

  test("answer 404 for an agent the registry does not hold", async () => {
    const who = await signedIn(true);
    expect((await page(`/chat/${uniq("ghost")}`, who.cookie)).status).toBe(404);
  });

  test("open the conversation for an agent it does hold", async () => {
    const who = await signedIn(true);
    const agent = registerAgent(uniq("agent"));
    expect((await page(`/chat/${agent}`, who.cookie)).status).toBe(200);
    expect((await page("/chat", who.cookie)).status).toBe(200);
  });
});

describe("asking who you are", () => {
  /** The one place a session is *asked about* rather than used, so it refuses in JSON. */
  test("refuses without a session, in the shape a client can read", async () => {
    const res = await page("/auth/me");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  test("answers 404 for a signed session whose user is gone", async () => {
    const jwt = await signJwt({ github_id: 987_654_322, github_login: uniq("ghost"), role: "member" });
    const res = await page("/auth/me", `mesh_token=${jwt}`);
    expect(res.status).toBe(404);
  });
});

describe("starting the OAuth flow", () => {
  test("hands the browser to GitHub, carrying the callback it will come back to", async () => {
    const res = await page("/auth/github");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read:user");
    expect(to.searchParams.get("redirect_uri")).toBeTruthy();
  });
});

describe("the browser sign-in form", () => {
  /** An admitted local account, holding the temporary password it was issued. */
  async function admitted() {
    const login = uniq("admin");
    const user = upsertUser(1_040_000 + n, login);
    createPendingApproval(login, user.github_id);
    expect(approveUser(login)).toBe(true);
    grants.grant(agents, {
      subject: login, capability: CAPABILITY.USER_ADMIT, grantedBy: "pages-and-form-test",
    });
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });

    const username = uniq("local");
    const res = await app.fetch(new Request("http://pg-probe/api/v1/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `mesh_token=${jwt}` },
      body: JSON.stringify({ username }),
    }));
    expect(res.status).toBe(201);
    const { temporary_password } = await res.json();
    return { username, password: temporary_password as string };
  }

  /**
   * **Each failure names itself, and none of them sets a cookie.** The landing
   * page reads `?error=` to say what happened; a redirect that carried a
   * session would be a sign-in that failed and worked.
   */
  test("sends a form with nothing in it back to the landing page", async () => {
    for (const fields of [{}, { username: "someone" }, { password: "secret" }]) {
      const res = await form(fields as Record<string, string>);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?error=missing");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  /**
   * One answer for "no such user" and "wrong password", because two would make
   * this route a way to find out which accounts exist.
   */
  test("does not say which half of the credential was wrong", async () => {
    const who = await admitted();
    const wrongPassword = await form({ username: who.username, password: "not-it" });
    const noSuchUser = await form({ username: uniq("nobody"), password: who.password });
    for (const res of [wrongPassword, noSuchUser]) {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/?error=invalid");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("signs the browser in, and lands it on the conversation", async () => {
    const who = await admitted();
    const res = await form({ username: who.username, password: who.password });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/chat");

    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("mesh_token=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");

    // The session it handed out is a session: the same cookie answers `/auth/me`.
    const me = await (await page("/auth/me", cookie!.split(";")[0]!)).json();
    expect(me.github_login).toBe(who.username);
    expect(me.approved).toBe(true);
  });
});

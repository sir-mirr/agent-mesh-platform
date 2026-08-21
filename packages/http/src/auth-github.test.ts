/**
 * The GitHub sign-in exchange, and the callback that spends it.
 *
 * `auth.ts` read 36% and `GET /auth/github/callback` was twenty-six of
 * `main.ts`'s uncovered lines, for one reason: both talk to github.com, and
 * nothing in this repository had ever stood in for it. So the path a person
 * actually arrives on — the only one that mints a session from an identity
 * provider — was the least measured thing in the service.
 *
 * **`fetch` is stood in for, and put back.** The two helpers name their URLs
 * literally, so a stand-in can answer by host and let everything else through;
 * anything it does not recognise throws rather than reaching the network, which
 * is the difference between a test that is offline and a test that is offline
 * *today*.
 *
 * What is asserted is the shape of the refusals and the one thing the happy
 * path must do besides redirect: an unapproved login has to leave a pending
 * approval behind, exactly once, or an operator never learns anybody is
 * waiting.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "auth-github-probe";

const { exchangeCodeForToken, getGithubUser } = await import("./auth");
const { app } = await import("./main.ts");
const { getPendingApproval } = await import("./db");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Answer = { status?: number; json?: unknown; ok?: boolean; statusText?: string };
/** Answer github.com and api.github.com; refuse to reach anything else. */
function standIn(routes: { token?: Answer; user?: Answer }) {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    const pick =
      url.startsWith("https://github.com/login/oauth/access_token") ? routes.token :
      url.startsWith("https://api.github.com/user") ? routes.user :
      undefined;
    if (!pick) throw new Error(`the stand-in was asked for ${url}, which no test set up`);
    return new Response(JSON.stringify(pick.json ?? {}), {
      status: pick.status ?? 200,
      statusText: pick.statusText ?? "",
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let n = 0;
const login = () => `gh-probe-${++n}-${process.pid}`;

describe("exchanging the code for a token", () => {
  test("returns the token GitHub sent", async () => {
    standIn({ token: { json: { access_token: "tok-1" } } });
    expect(await exchangeCodeForToken("code-1")).toBe("tok-1");
  });

  /**
   * GitHub answers `200` with an error *body* for a bad code, so the status is
   * not the signal — which is why this reads the payload and not `res.ok`.
   */
  test("throws GitHub's own description when it refuses the code", async () => {
    standIn({ token: { json: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } } });
    await expect(exchangeCodeForToken("stale")).rejects.toThrow("The code passed is incorrect or expired.");
  });

  test("falls back to the error itself when there is no description", async () => {
    standIn({ token: { json: { error: "bad_verification_code" } } });
    await expect(exchangeCodeForToken("stale")).rejects.toThrow("bad_verification_code");
  });

  /** A `200` with neither token nor error is still a failure, not a session. */
  test("and refuses an answer carrying no token at all", async () => {
    standIn({ token: { json: {} } });
    await expect(exchangeCodeForToken("code")).rejects.toThrow("Failed to exchange code for token");
  });
});

describe("reading the user behind the token", () => {
  test("returns only the four fields it is declared to", async () => {
    standIn({ user: { json: { id: 7, login: "octo", name: "Octo", avatar_url: "https://a", extra: "dropped" } } });
    expect(await getGithubUser("tok")).toEqual({ id: 7, login: "octo", name: "Octo", avatar_url: "https://a" });
  });

  test("and throws with the status when GitHub refuses the token", async () => {
    standIn({ user: { status: 401, statusText: "Unauthorized", json: {} } });
    await expect(getGithubUser("tok")).rejects.toThrow("GitHub API error: 401");
  });
});

describe("the callback a person actually arrives on", () => {
  const callback = (query: string) =>
    app.fetch(new Request(`http://auth-probe/auth/github/callback${query}`));

  test("refuses to start without a code", async () => {
    const res = await callback("");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Missing");
  });

  /**
   * The exchange is a network call to somebody else's service, so it fails in
   * ways this one cannot prevent. What it must not do is fail silently or
   * redirect anyway — a `302` to `/chat` with no session is a login loop.
   */
  test("answers 500 with the detail when the exchange fails", async () => {
    standIn({ token: { json: { error: "bad_verification_code", error_description: "expired" } } });
    const res = await callback("?code=stale");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("OAuth callback failed");
    expect(body.detail).toContain("expired");
  });

  test("sets a session and sends an approved person to the console", async () => {
    const who = login();
    standIn({
      token: { json: { access_token: "tok" } },
      user: { json: { id: 4000 + n, login: who, name: null, avatar_url: "https://a" } },
    });
    const res = await callback("?code=good");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/chat");
    expect(res.headers.get("set-cookie") ?? "").toContain("=");
  });

  /**
   * **The part that is not the redirect.** An unapproved login looks identical
   * to an approved one from the browser — same `302`, same cookie — and the
   * only difference is a row an operator later reads. If it is not written,
   * nobody ever learns that somebody is waiting, and the person sees a console
   * that refuses them with no way to ask.
   */
  test("leaves a pending approval behind for someone not yet approved", async () => {
    const who = login();
    standIn({
      token: { json: { access_token: "tok" } },
      user: { json: { id: 5000 + n, login: who, name: null, avatar_url: "https://a" } },
    });
    expect(getPendingApproval(who)).toBeFalsy();
    expect((await callback("?code=good")).status).toBe(302);
    expect(getPendingApproval(who)).toBeTruthy();
  });

  /** Signing in again while waiting must not queue a second request. */
  test("and does not write a second one when they come back", async () => {
    const who = login();
    standIn({
      token: { json: { access_token: "tok" } },
      user: { json: { id: 6000 + n, login: who, name: null, avatar_url: "https://a" } },
    });
    await callback("?code=good");
    const first = getPendingApproval(who);
    await callback("?code=good");
    const second = getPendingApproval(who);
    expect(second).toEqual(first);
  });
});

/**
 * Registering and dropping a delivery endpoint (§ 9.1).
 *
 * Both routes were uncovered, and the reason they are worth a file of their own
 * is the guard they carry: **approval, not merely a session.** These two were
 * once the only `JWT` routes that stopped at `extractJwt`, so somebody an
 * operator had not granted access to could register a push endpoint against
 * this deployment — and would then be holding a subscription for a mesh they
 * cannot read.
 *
 * The rest is the shape of what they accept, which matters because a
 * subscription is three fields and two of them live one level down: a body that
 * carries the endpoint and neither key is a subscription this service can never
 * deliver to, and storing it would put a permanently failing row in the table
 * the sender iterates.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "push-routes-probe";

const { app } = await import("./main.ts");
const { getDb, getPushSubscriptions, upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");

let n = 0;
const uniq = (p: string) => `push-${p}-${++n}-${process.pid}`;

async function session(approved: boolean) {
  const login = uniq(approved ? "member" : "waiting");
  const user = upsertUser(550000 + n, login);
  createPendingApproval(login, user.github_id);
  if (approved) expect(approveUser(login)).toBe(true);
  // `member`, stated: an admin is approved by definition, and the first user of
  // an empty table becomes one — so reading the role back would make the
  // refusal below depend on how many people the table already held.
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

const post = (path: string, body: unknown, cookie?: string) =>
  app.fetch(new Request(`http://push-probe${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const subscription = (endpoint: string) => ({
  subscription: { endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } },
});

describe("registering an endpoint", () => {
  test("refuses a caller with no session", async () => {
    expect((await post("/api/v1/push/subscribe", subscription("https://push/x"))).status).toBe(401);
  });

  /**
   * The guard that was added here: a session is not permission. Somebody
   * waiting on an operator can hold a valid token and must not be able to
   * register a delivery endpoint with it.
   */
  test("refuses a signed-in person the operator has not approved", async () => {
    const waiting = await session(false);
    const res = await post("/api/v1/push/subscribe", subscription("https://push/y"), waiting.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Forbidden");
  });

  test("refuses a body that is not JSON", async () => {
    const me = await session(true);
    const res = await post("/api/v1/push/subscribe", "{not json", me.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid JSON");
  });

  /**
   * Three fields, two of them a level down. A subscription missing any of them
   * is one this service can never deliver to, and storing it would leave a
   * permanently failing row in the table the sender iterates.
   */
  test("refuses a subscription missing the endpoint or either key", async () => {
    const me = await session(true);
    const bad: unknown[] = [
      {},
      { subscription: {} },
      { subscription: { endpoint: "https://push/z" } },
      { subscription: { endpoint: "https://push/z", keys: { p256dh: "only-one" } } },
      { subscription: { endpoint: "https://push/z", keys: { auth: "only-the-other" } } },
      { subscription: { keys: { p256dh: "a", auth: "b" } } },
    ];
    for (const body of bad) {
      const res = await post("/api/v1/push/subscribe", body, me.cookie);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Missing subscription data");
    }
  });

  test("stores one it can deliver to", async () => {
    const me = await session(true);
    const endpoint = `https://push.example/${uniq("ep")}`;
    const res = await post("/api/v1/push/subscribe", subscription(endpoint), me.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stored = getPushSubscriptions(me.login);
    const row = stored.find((s) => s.endpoint === endpoint);
    expect(row).toBeDefined();
    // Both keys, because a row with one is a row that fails on every send.
    expect(row!.p256dh).toBe("p256dh-value");
    expect(row!.auth).toBe("auth-value");
  });

  /** The same browser re-registering is one endpoint, not two. */
  test("and re-registering the same endpoint does not double it", async () => {
    const me = await session(true);
    const endpoint = `https://push.example/${uniq("ep")}`;
    await post("/api/v1/push/subscribe", subscription(endpoint), me.cookie);
    await post("/api/v1/push/subscribe", subscription(endpoint), me.cookie);
    expect(getPushSubscriptions(me.login).filter((s) => s.endpoint === endpoint)).toHaveLength(1);
  });
});

describe("dropping an endpoint", () => {
  test("refuses a caller with no session, and one not approved", async () => {
    expect((await post("/api/v1/push/unsubscribe", { endpoint: "https://push/x" })).status).toBe(401);
    const waiting = await session(false);
    expect((await post("/api/v1/push/unsubscribe", { endpoint: "https://push/x" }, waiting.cookie)).status).toBe(403);
  });

  test("refuses a body that is not JSON, and one with no endpoint", async () => {
    const me = await session(true);
    expect((await post("/api/v1/push/unsubscribe", "{not json", me.cookie)).status).toBe(400);
    const res = await post("/api/v1/push/unsubscribe", {}, me.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing endpoint");
  });

  test("removes the row the browser is giving up", async () => {
    const me = await session(true);
    const endpoint = `https://push.example/${uniq("ep")}`;
    await post("/api/v1/push/subscribe", subscription(endpoint), me.cookie);
    expect(getPushSubscriptions(me.login).some((s) => s.endpoint === endpoint)).toBe(true);

    const res = await post("/api/v1/push/unsubscribe", { endpoint }, me.cookie);
    expect(res.status).toBe(200);
    expect(getPushSubscriptions(me.login).some((s) => s.endpoint === endpoint)).toBe(false);
  });

  /**
   * Unsubscribing something that is already gone is the same end state, so it
   * is not an error — an operator or a browser retrying wanted this, and has it.
   */
  test("and says the same thing about an endpoint that was never there", async () => {
    const me = await session(true);
    const res = await post("/api/v1/push/unsubscribe", { endpoint: `https://push.example/${uniq("ghost")}` }, me.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  /**
   * **The endpoint is the key, and it is not scoped to the caller.** Measured
   * rather than assumed: `deletePushSubscription` takes an endpoint alone, so a
   * caller naming somebody else's endpoint removes it. Endpoints are long
   * unguessable URLs issued by a push service, which is why this has not
   * mattered — but a URL is not a secret the way a key is, and the route does
   * not check.
   */
  test("does not scope the removal to the caller who owns it", async () => {
    const mine = await session(true);
    const theirs = await session(true);
    const endpoint = `https://push.example/${uniq("ep")}`;
    await post("/api/v1/push/subscribe", subscription(endpoint), theirs.cookie);
    expect(getPushSubscriptions(theirs.login).some((s) => s.endpoint === endpoint)).toBe(true);

    expect((await post("/api/v1/push/unsubscribe", { endpoint }, mine.cookie)).status).toBe(200);
    expect(getPushSubscriptions(theirs.login).some((s) => s.endpoint === endpoint)).toBe(false);
  });
});

/**
 * Admitting a person, and turning one away (§ 11).
 *
 * **`user.admit` is its own capability**, and the comment on both routes says
 * why: it is not `role.grant`, which hands capabilities to somebody already
 * admitted, and not `agent.provision`, which claims a mesh identity. They sat
 * on the role check until there was a name for what they actually do.
 *
 * Approving is four writes, not one, and the route says so out loud because
 * three of them are what turn an approved row into a person who can use the
 * mesh: the registry entry this service speaks for, the mesh identity that
 * makes them a participant rather than a name the hub routes without
 * recognising, and the re-declaration that lets this server speak for them
 * before its next reconnect. Denying is one write, and the asymmetry is the
 * point.
 */
import { afterEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "admission-probe";

const { app } = await import("./main.ts");
const {
  getDb, upsertUser, approveUser, createPendingApproval, getPendingApproval,
  listApprovedWebUserIds, isAllowedToMessage,
} = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir } = await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const agentsDb = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(agentsDb);
grants.migrate(agentsDb);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let n = 0;
/**
 * **The prefix has to be this file's alone.** It was `adm-`, which
 * `admin-reads.test.ts` beside it also uses — two files each counting from
 * zero produce the same names, and the second `createPendingApproval` for a
 * login is ignored, so `approveUser` finds nothing pending and answers false.
 * Seven of its tests failed on a collision neither file could see.
 */
const uniq = (p: string) => `admit-${p}-${++n}-${process.pid}`;

/** The hub answers provisioning; nothing else may be reached. */
function hubAnswers(ok = true) {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("/api/v1/agents")) throw new Error(`unexpected fetch: ${url}`);
    if (!ok) throw new Error("hub unreachable");
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** An operator holding `user.admit`, or holding nothing. */
async function operator(withAdmit: boolean) {
  const login = uniq("op");
  const user = upsertUser(350000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  if (withAdmit) {
    grants.grant(agentsDb, { subject: login, capability: CAPABILITY.USER_ADMIT, grantedBy: "admission-test" });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, authorization: `Bearer ${jwt}` };
}

/** Somebody waiting in the queue an operator works through. */
function waiting() {
  const login = uniq("waiting");
  const user = upsertUser(360000 + n, login);
  createPendingApproval(login, user.github_id);
  return login;
}

const post = (path: string, body: unknown, cookie: string) =>
  app.fetch(new Request(`http://adm-probe${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: cookie },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

describe("who may admit", () => {
  test("refuses an operator holding everything else", async () => {
    const nobody = await operator(false);
    for (const path of ["/api/v1/admin/approve", "/api/v1/admin/deny"]) {
      const res = await post(path, { github_login: waiting() }, nobody.authorization);
      expect([401, 403]).toContain(res.status);
    }
  });
});

describe("admitting somebody", () => {
  test("refuses a body it cannot parse, or one naming nobody", async () => {
    const op = await operator(true);
    expect((await post("/api/v1/admin/approve", "{not json", op.authorization)).status).toBe(400);
    for (const body of [{}, { github_login: "" }, { github_login: 7 }]) {
      const res = await post("/api/v1/admin/approve", body, op.authorization);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("github_login");
    }
  });

  /**
   * `404` names the login, because an operator working a queue has a list of
   * them and needs to know which one this was about.
   */
  test("refuses a login with nothing pending, and says which", async () => {
    const op = await operator(true);
    const stranger = uniq("stranger");
    const res = await post("/api/v1/admin/approve", { github_login: stranger }, op.authorization);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(stranger);
  });

  /**
   * **Four writes.** The approval row is the one an operator sees; the other
   * three are what make the person usable — the registry this service builds
   * its proxy claim from, the mesh identity, and a messaging policy without
   * which they are admitted and unable to send to anyone.
   */
  test("approves, registers, provisions, and grants a policy", async () => {
    const op = await operator(true);
    const person = waiting();
    hubAnswers();

    const res = await post("/api/v1/admin/approve", { github_login: person }, op.authorization);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, github_login: person, status: "approved" });

    expect(getPendingApproval(person)?.status).toBe("approved");
    expect(listApprovedWebUserIds()).toContain(person);
    expect(isAllowedToMessage(person, "member", uniq("anyone"))).toBe(true);
  });

  /**
   * **Best effort, and deliberately so.** A hub that is briefly unreachable
   * must not fail an approval — the person is admitted either way and the
   * reconnect backfill retries the identity. Refusing here would make an
   * operator's decision depend on another process being up.
   */
  test("still admits somebody when the hub cannot be reached", async () => {
    const op = await operator(true);
    const person = waiting();
    hubAnswers(false);

    const res = await post("/api/v1/admin/approve", { github_login: person }, op.authorization);
    expect(res.status).toBe(200);
    expect(getPendingApproval(person)?.status).toBe("approved");
    expect(listApprovedWebUserIds()).toContain(person);
  });

  /** Approving twice is not an error the second time — it is a `404`, because
   *  there is no longer anything pending to move. The end state is what the
   *  operator wanted, and the answer says why nothing happened. */
  test("and answers the second approval with nothing left to approve", async () => {
    const op = await operator(true);
    const person = waiting();
    hubAnswers();
    expect((await post("/api/v1/admin/approve", { github_login: person }, op.authorization)).status).toBe(200);
    expect((await post("/api/v1/admin/approve", { github_login: person }, op.authorization)).status).toBe(404);
  });
});

describe("turning somebody away", () => {
  test("refuses a body it cannot parse, or one naming nobody", async () => {
    const op = await operator(true);
    expect((await post("/api/v1/admin/deny", "{not json", op.authorization)).status).toBe(400);
    const res = await post("/api/v1/admin/deny", {}, op.authorization);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("github_login");
  });

  test("refuses a login with nothing pending, and says which", async () => {
    const op = await operator(true);
    const stranger = uniq("stranger");
    const res = await post("/api/v1/admin/deny", { github_login: stranger }, op.authorization);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(stranger);
  });

  /**
   * **Denying is one write, and that asymmetry is the design.** A denied person
   * gets no registry row, no mesh identity and no messaging policy — nothing to
   * withdraw later, because nothing was granted. It also leaves the row denied
   * rather than removing it, so a second sign-in re-opens the request instead
   * of arriving as though it were the first.
   */
  test("marks the row denied and grants nothing", async () => {
    const op = await operator(true);
    const person = waiting();

    const res = await post("/api/v1/admin/deny", { github_login: person }, op.authorization);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, github_login: person, status: "denied" });

    expect(getPendingApproval(person)?.status).toBe("denied");
    expect(listApprovedWebUserIds()).not.toContain(person);
    expect(isAllowedToMessage(person, "member", uniq("anyone"))).toBe(false);
    expect(
      getDb().prepare(`SELECT 1 AS ok FROM policies WHERE github_login = ?`).get(person),
    ).toBeNull();
  });
});

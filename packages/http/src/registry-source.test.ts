/**
 * Where the console's list of agents comes from (P1, found in use).
 *
 * An agent was approved in the console, connected to the hub — the hub's log
 * says so, `event=connected` — and `GET /api/v1/agents` answered one row, the
 * signed-in account itself. The mesh knew about the agent; the console could
 * not see it.
 *
 * The two lists were never joined. `agent_registry` is this server's own table
 * and has exactly two writers: `upsertApprovedWebUser`, which inserts a *web
 * user*, and a one-time import of the pre-database `registry.json`. Nothing has
 * ever written an agent row for an identity the hub registered. It looked like
 * it worked because the legacy import had filled the table once, years of
 * identities deep — and the state directory was retired and re-seeded, so the
 * import had nothing to import and the only rows left were the people.
 *
 * The mesh's `agents` table is where an identity exists. This route already
 * reads it, twice, for `last_seen` and for fingerprints; it just did not list
 * from it.
 */
import { beforeAll, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "registry-source-probe";

const { app } = await import("./main.ts");
const { upsertApprovedWebUser, upsertUser, approveUser, createPendingApproval, getDb } =
  await import("./db");
const { agentsDb } = await import("./keys-admin");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, openAt, stateDir } = await import("@agent-mesh/store");
const { join } = await import("node:path");

// The store the hub owns and this process only reads. Created and migrated here
// for the same reason `grants-writes.test.ts` does it: `agentsDb()` opens
// without creating, so a suite that runs before any service has is the one that
// has to make the file exist.
agentsSchema.migrate(openAt(join(stateDir(), STORE_FILES.agents), { create: true }));

let n = 0;
const uniq = (p: string) => `rs-${p}-${++n}-${process.pid}`;

const call = (path: string, cookie: string) =>
  app.fetch(new Request(`http://rs-probe${path}`, { headers: { cookie } }));

/** An identity the hub knows about, the way the hub records one. */
function meshAgent(type = "agent"): string {
  const identity = uniq(type);
  agentsDb()
    .prepare(`INSERT INTO agents (identity, description, type) VALUES (?, ?, ?)`)
    .run(identity, `${identity} description`, type);
  return identity;
}

let adminCookie = "";

beforeAll(async () => {
  // **The `users` table, not `local_users`.** `seedLocalUsers` seeds the
  // documented `admin`/`admin` only while `local_users` is empty, so a file
  // that writes a row there before the seed runs disables the account every
  // other suite signs in with — which is exactly what the first version of
  // this file did, and `main.in-process.test.ts` failed at its `beforeAll`
  // three files later with `401 invalid username or password`.
  const login = uniq("admin");
  const user = upsertUser(1_090_000 + n, login);
  createPendingApproval(login, user.github_id);
  approveUser(login);
  getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(login);
  upsertApprovedWebUser(login);
  adminCookie = `mesh_token=${await signJwt({ github_id: user.github_id, github_login: login, role: "admin" })}`;
});

const listed = async (cookie: string): Promise<string[]> => {
  const res = await call("/api/v1/agents", cookie);
  expect(res.status).toBe(200);
  return ((await res.json()).agents as Array<{ id: string }>).map((a) => a.id);
};

describe("the console's registry", () => {
  test("lists an identity the mesh holds and this server has never seen", async () => {
    const agent = meshAgent();
    expect(await listed(adminCookie)).toContain(agent);
  });

  /**
   * The row the mesh holds, not a placeholder. `description` is what an
   * operator wrote when the identity was provisioned, and it is the only text
   * about the agent anywhere.
   */
  test("and carries what the mesh knows about it", async () => {
    const agent = meshAgent();
    const res = await call("/api/v1/agents", adminCookie);
    const row = ((await res.json()).agents as Array<{ id: string; description: string | null; type: string }>)
      .find((a) => a.id === agent);
    expect(row).toBeDefined();
    expect(row!.description).toBe(`${agent} description`);
    expect(row!.type).toBe("agent");
  });

  /**
   * **A torn-down identity stays gone.** § 9.3's delete is a `deleted_at`
   * stamp, and every other reader of this table filters on it; a list that
   * did not would put a destroyed agent back on the screen.
   */
  test("but not one that was torn down", async () => {
    const agent = meshAgent();
    agentsDb().prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ?`).run(agent);
    expect(await listed(adminCookie)).not.toContain(agent);
  });
});

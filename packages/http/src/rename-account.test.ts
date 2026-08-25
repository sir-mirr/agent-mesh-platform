/**
 * Renaming a local account (T-026), and the references that have to come with
 * it.
 *
 * **The identity is the address.** A username is written into the registry that
 * says who can be addressed, the grants that decide what they may do, the
 * ownership rows that say which agents are theirs, and the group membership
 * that decides who they may send to. Every test below is a table that has to
 * move, or a record that deliberately does not.
 *
 * This file owns the `rn-` prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "rename-account-probe";

const { renameLocalAccount } = await import("./rename-account");
const { renameSeededAdmin, seedLegacyAdminGrants } = await import("./main.ts");
const {
  getDb, getLocalUser, admitLocalUser, insertMessage, listApprovedWebUserIds,
  SEED_ADMIN_USERNAME, LEGACY_SEED_ADMIN_USERNAME,
} = await import("./db");
const { agentsDb } = await import("./keys-admin");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { STORE_FILES, agentsSchema, grants, groups, openAt, ownership, stateDir } =
  await import("@agent-mesh/store");
const { join } = await import("node:path");

// `agentsDb()` opens without creating, so a suite that runs before any service
// has is the one that has to make the file exist — the same reason
// `grants-writes.test.ts` opens it here.
const mesh = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(mesh);
grants.migrate(mesh);
ownership.migrate(mesh);
groups.migrate(mesh);

let n = 0;
const uniq = (p: string) => `rn-${p}-${++n}-${process.pid}`;

/**
 * Rows written by these tests, removed afterwards.
 *
 * One state directory holds for the whole run and `seedLocalUsers` seeds the
 * documented administrator only into an **empty** `local_users` — so a row left
 * behind here is a sign-in another file's `beforeAll` never gets.
 */
const written: string[] = [];
async function account(username = uniq("person")): Promise<string> {
  await admitLocalUser({ username });
  written.push(username);
  return username;
}
afterEach(() => {
  for (const username of written.splice(0)) {
    getDb().prepare(`DELETE FROM local_users WHERE username = ?`).run(username);
    getDb().prepare(`DELETE FROM agent_registry WHERE id = ?`).run(username);
  }
});

describe("renaming an account", () => {
  test("moves the login, the registry row, and the grants", async () => {
    const from = await account();
    const to = uniq("renamed");
    written.push(to);
    grants.grant(agentsDb(), { subject: from, capability: CAPABILITY.USAGE_READ, grantedBy: "rename-test" });

    const outcome = renameLocalAccount(from, to);
    expect(outcome).toMatchObject({ ok: true });

    expect(getLocalUser(from)).toBeNull();
    expect(getLocalUser(to)).not.toBeNull();
    // The registry row is what makes them addressable at all: a local user who
    // is not in it has every message refused by entitlement, silently.
    expect(listApprovedWebUserIds()).toContain(to);
    expect(listApprovedWebUserIds()).not.toContain(from);
    // And the grants, or the account signs in and can do nothing, with every
    // screen answering 403 and nothing anywhere saying why.
    expect(grants.listFor(agentsDb(), to).map((g: any) => g.capability)).toContain(CAPABILITY.USAGE_READ);
    expect(grants.listFor(agentsDb(), from)).toEqual([]);
  });

  test("moves what they own and the group they are in", async () => {
    const from = await account();
    const to = uniq("renamed");
    written.push(to);
    const agent = uniq("agent");
    ownership.assign(agentsDb(), { identity: agent, owner: from, grantedBy: "rename-test" });
    groups.createGroup(agentsDb(), { groupId: "rn-team", createdBy: "rename-test" });
    groups.moveTo(agentsDb(), { identity: from, groupId: "rn-team", movedBy: "rename-test" });

    expect(renameLocalAccount(from, to)).toMatchObject({ ok: true });

    expect(ownership.ownedBy(agentsDb(), to)).toContain(agent);
    expect(ownership.ownedBy(agentsDb(), from)).toEqual([]);
    expect(groups.groupOf(agentsDb(), to)).toBe("rn-team");
    // `default` is what `groupOf` answers for an identity nobody has placed —
    // so the old name reading `default` is the membership having moved.
    expect(groups.groupOf(agentsDb(), from)).toBe("default");
  });

  /**
   * **History is not rewritten.** What happened is that the old name sent that
   * message, and a record whose value is that nobody edited it afterwards is
   * the last place to start.
   */
  test("leaves the message history under the name that sent it", async () => {
    const from = await account();
    const to = uniq("renamed");
    written.push(to);
    const id = uniq("msg");
    insertMessage({
      id, from, to: "somebody", content: "before the rename",
      status: "sent", ts: new Date().toISOString(),
    });

    expect(renameLocalAccount(from, to)).toMatchObject({ ok: true });

    const row = getDb().prepare(`SELECT from_agent FROM messages WHERE id = ?`).get(id) as
      { from_agent: string };
    expect(row.from_agent).toBe(from);
  });

  test("counts what moved, so a log says what happened rather than that something did", async () => {
    const from = await account();
    const to = uniq("renamed");
    written.push(to);
    grants.grant(agentsDb(), { subject: from, capability: CAPABILITY.USAGE_READ, grantedBy: "rename-test" });

    const outcome = renameLocalAccount(from, to);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.moved["local_users.username"]).toBe(1);
    expect(outcome.moved["role_grants.subject"]).toBe(1);
    // A table nothing of this account's is in does not appear at all.
    expect(outcome.moved).not.toHaveProperty("pairing_codes.identity");
  });

  test("refuses a name nobody has, and a name somebody does", async () => {
    expect(renameLocalAccount(uniq("nobody"), uniq("free"))).toEqual({ ok: false, reason: "no_such_account" });

    const from = await account();
    const taken = await account();
    // **The account, with no registry row of its own.** Admission writes one
    // for every local account, so the registry check below would answer this
    // case too and the account check would be doing nothing — a guard that
    // cannot fail is one the next refactor deletes without noticing.
    getDb().prepare(`DELETE FROM agent_registry WHERE id = ?`).run(taken);

    expect(renameLocalAccount(from, taken))
      .toMatchObject({ ok: false, reason: "name_taken", blocked_by: "local_users.username" });
    // Nothing half-happened: the refusal is before the first write.
    expect(getLocalUser(from)).not.toBeNull();
  });

  /**
   * **The P0.** `agents.identity` is a primary key, so a deployment that
   * already had a mesh row under the new name met
   * `UNIQUE constraint failed: agents.identity` from inside `startup` — and the
   * http service did not come up at all. Reproduced on the running stack by
   * `agent-mesh-local-pm`.
   */
  test("refuses when both names hold a mesh identity, rather than throwing", async () => {
    const from = await account();
    const to = uniq("occupied");
    for (const identity of [from, to]) {
      mesh.prepare(`INSERT INTO agents (identity, description) VALUES (?, 'here')`).run(identity);
    }
    try {
      const outcome = renameLocalAccount(from, to);
      expect(outcome).toMatchObject({ ok: false, reason: "name_taken", blocked_by: "agents.identity" });
      // The refusal is before the first write, in either database.
      expect(getLocalUser(from)).not.toBeNull();
    } finally {
      mesh.prepare(`DELETE FROM agents WHERE identity IN (?, ?)`).run(from, to);
    }
  });

  test("refuses when a grant, an ownership row or a membership is held under both", async () => {
    const from = await account();
    // Each of these is part of a composite primary key, so two rows meeting
    // under one name is what made the `UPDATE` throw instead of skipping.
    grants.grant(mesh, { subject: from, capability: CAPABILITY.USAGE_READ, grantedBy: "t" });
    grants.grant(mesh, { subject: "rn-taken-subject", capability: CAPABILITY.USAGE_READ, grantedBy: "t" });
    ownership.assign(mesh, { identity: "rn-some-agent", owner: from, grantedBy: "t" });
    ownership.assign(mesh, { identity: "rn-some-agent", owner: "rn-taken-owner", grantedBy: "t" });
    groups.moveTo(mesh, { identity: from, groupId: "default", movedBy: "t" });
    groups.moveTo(mesh, { identity: "rn-taken-member", groupId: "default", movedBy: "t" });

    for (const taken of ["rn-taken-subject", "rn-taken-owner", "rn-taken-member"]) {
      expect(renameLocalAccount(from, taken), taken).toMatchObject({ ok: false, reason: "name_taken" });
    }
    expect(getLocalUser(from)).not.toBeNull();
  });

  /**
   * The constraint nobody predicted.
   *
   * The refusals above are the collisions this knows how to name; a database
   * saying no for another reason is still a database saying no, and the answer
   * has to be an account keeping its name rather than a process that fails to
   * start — which is how the first version reached a running deployment. The
   * handle is a parameter so the throw can be produced here without leaving a
   * real database in the shape the throw describes.
   */
  test("answers write_failed rather than throwing when a write is refused", async () => {
    const from = await account();
    const refuses = {
      prepare: (sql: string) => mesh.prepare(sql),
      transaction: () => () => { throw new Error("database is locked"); },
    } as unknown as typeof mesh;

    expect(renameLocalAccount(from, uniq("free"), getDb(), refuses))
      .toEqual({ ok: false, reason: "write_failed" });
    // The account is where it was: the transaction rolled back on the way out,
    // so half-renamed is not one of the outcomes.
    expect(getLocalUser(from)).not.toBeNull();
  });

  /**
   * **A half-finished rename is resumed, not refused.**
   *
   * The two databases cannot share a transaction, so a process that dies
   * between them — or a second process racing the same migration — leaves the
   * mesh rows moved and the account not. From here that looks exactly like a
   * name clash and is the opposite of one: the new name holds rows the old name
   * no longer has, which is this rename already applied. Refusing would strand
   * the deployment on a boot that can never finish what an earlier boot began.
   */
  test("finishes a rename an earlier boot left half done", async () => {
    const from = await account();
    const to = uniq("halfway");
    written.push(to);
    grants.grant(mesh, { subject: from, capability: CAPABILITY.USAGE_READ, grantedBy: "t" });
    // The mesh half, as a crashed boot would have left it.
    mesh.prepare(`UPDATE role_grants SET subject = ? WHERE subject = ?`).run(to, from);

    const outcome = renameLocalAccount(from, to);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The table that was already moved is not reported as moved again.
    expect(outcome.moved).not.toHaveProperty("role_grants.subject");
    expect(outcome.moved["local_users.username"]).toBe(1);
    expect(getLocalUser(to)).not.toBeNull();
    expect(grants.listFor(mesh, to).length).toBeGreaterThan(0);
  });

  test("refuses a name only the registry holds, because that is the same namespace", async () => {
    const from = await account();
    const to = uniq("addressed");
    getDb()
      .prepare(`INSERT INTO agent_registry (id, name, channel, approved) VALUES (?, ?, 'native', 1)`)
      .run(to, to);
    try {
      expect(renameLocalAccount(from, to))
        .toMatchObject({ ok: false, reason: "name_taken", blocked_by: "agent_registry.id" });
    } finally {
      getDb().prepare(`DELETE FROM agent_registry WHERE id = ?`).run(to);
    }
  });
});

describe("the seeded administrator's rename", () => {
  /** The legacy row, as an upgraded deployment has it. Removed by `afterEach`. */
  async function legacyAdmin(): Promise<void> {
    await admitLocalUser({ username: LEGACY_SEED_ADMIN_USERNAME, role: "admin" });
    written.push(LEGACY_SEED_ADMIN_USERNAME);
  }

  /**
   * **The new name has to be free, and this process is shared.**
   *
   * `agent_registry` is the same namespace as a login, and the rename refuses
   * rather than colliding — correctly. But every file in this package shares
   * one database, and one of them registers an agent called `platform-admin`,
   * so whether this test finds the name free came down to which file bun loaded
   * first. It passed here and refused in CI with `blocked_by:
   * agent_registry.id`. The row is borrowed for the length of the test and put
   * back, which is what the neighbouring cases already do with the ones they
   * create.
   */
  function borrowRegistryName<T>(id: string, fn: () => T): T {
    const db = getDb();
    const held = db.prepare(`SELECT * FROM agent_registry WHERE id = ?`).get(id) as Record<string, unknown> | null;
    if (held) db.prepare(`DELETE FROM agent_registry WHERE id = ?`).run(id);
    try {
      return fn();
    } finally {
      if (held) {
        const columns = Object.keys(held);
        db.prepare(
          `INSERT OR REPLACE INTO agent_registry (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ).run(...columns.map((c) => held[c] as never));
      }
    }
  }

  test("moves `admin` to `platform-admin` once, and does nothing on the next start", async () => {
    await legacyAdmin();
    written.push(SEED_ADMIN_USERNAME);

    borrowRegistryName(SEED_ADMIN_USERNAME, () => {
      renameSeededAdmin();
      expect(getLocalUser(LEGACY_SEED_ADMIN_USERNAME)).toBeNull();
      expect(getLocalUser(SEED_ADMIN_USERNAME)?.role).toBe("admin");

      // Idempotent: the second start has nothing named `admin` to find.
      renameSeededAdmin();
      expect(getLocalUser(SEED_ADMIN_USERNAME)).not.toBeNull();
    });
  });

  /**
   * An `admin` that is not the seeded administrator — somebody admitted under
   * that name — is left alone. The rename is about one account, and it is the
   * `role` that says which.
   */
  test("leaves an ordinary account called `admin` where it is", async () => {
    await admitLocalUser({ username: LEGACY_SEED_ADMIN_USERNAME });
    written.push(LEGACY_SEED_ADMIN_USERNAME);

    renameSeededAdmin();

    expect(getLocalUser(LEGACY_SEED_ADMIN_USERNAME)).not.toBeNull();
    expect(getLocalUser(SEED_ADMIN_USERNAME)).toBeNull();
  });

  /**
   * **A migration must not take the service down.** The first version threw
   * `UNIQUE constraint failed: agents.identity` out of `startup` and the http
   * service did not start — every screen and every agent, for a name.
   */
  test("comes up anyway when the rename cannot run", async () => {
    await legacyAdmin();
    const boom = (): never => { throw new Error("the database said no"); };

    expect(() => renameSeededAdmin(boom)).not.toThrow();
    // The account keeps its name, which is the survivable half: an operator
    // signs in under the old one and the server is answering.
    expect(getLocalUser(LEGACY_SEED_ADMIN_USERNAME)).not.toBeNull();
  });

  test("refuses rather than merging when both names are taken", async () => {
    await legacyAdmin();
    await admitLocalUser({ username: SEED_ADMIN_USERNAME, role: "admin" });
    written.push(SEED_ADMIN_USERNAME);

    renameSeededAdmin();

    // Two accounts under one meaning is worse than an old name, and nothing
    // here can know which of the two the operator signs in with.
    expect(getLocalUser(LEGACY_SEED_ADMIN_USERNAME)).not.toBeNull();
    expect(getLocalUser(SEED_ADMIN_USERNAME)).not.toBeNull();
  });
});

/**
 * The web `users` table, which the rename did not know about.
 *
 * Found on the running stack by the owner, through the screens: the account
 * permissions page listed `admin` and the local accounts page did not.
 * `agent-mesh-local-pm` measured it — `/api/v1/admin/users` held only
 * `platform-admin`, while `/api/v1/admin/grants` still carried twelve rows for
 * subject `admin`, the same twelve `platform-admin` had.
 *
 * Deleting those rows would not have fixed it, and that is the part worth
 * pinning. `administratorLogins()` reads **two** tables — `local_users` and
 * `users` — and `seedLegacyAdminGrants()` re-grants the full set to every name
 * it returns, on every start. So a `users` row still called by the old name
 * regrows its grants the next time the service boots, and a repair that only
 * removed grants would look correct until the next restart.
 */
describe("an account that is also a web user", () => {
  const webUser = (login: string, role = "admin") => {
    getDb()
      .prepare(`INSERT INTO users (github_id, github_login, role) VALUES (?, ?, ?)`)
      .run(Math.floor(Math.random() * 1e9) + 1000, login, role);
    return login;
  };
  const webLogins = (): string[] =>
    (getDb().prepare(`SELECT github_login FROM users`).all() as Array<{ github_login: string }>)
      .map((r) => r.github_login);

  afterEach(() => {
    for (const login of webLogins()) {
      if (login.startsWith("rn-")) getDb().prepare(`DELETE FROM users WHERE github_login = ?`).run(login);
    }
  });

  test("moves the web user row too, so nothing still answers to the old name", async () => {
    const from = await account();
    const to = uniq("renamed");
    written.push(to);
    webUser(from);

    expect(renameLocalAccount(from, to)).toMatchObject({ ok: true });
    expect(webLogins()).toContain(to);
    expect(webLogins()).not.toContain(from);
  });

  test("the old name does not regrow its grants on the next start", async () => {
    // The failure exactly as the owner saw it: twelve rows under a name no
    // account has, identical to the twelve the renamed account holds.
    const from = await account();
    const to = uniq("renamed");
    written.push(to);
    webUser(from);
    renameLocalAccount(from, to);

    // What a boot does.
    seedLegacyAdminGrants();

    const subjects = (agentsDb()
      .prepare(`SELECT DISTINCT subject FROM role_grants`)
      .all() as Array<{ subject: string }>).map((r) => r.subject);
    expect(subjects).not.toContain(from);
  });
});

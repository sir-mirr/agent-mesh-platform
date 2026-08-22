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
const { renameSeededAdmin } = await import("./main.ts");
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
    expect(renameLocalAccount(from, taken)).toEqual({ ok: false, reason: "name_taken" });
    // Nothing half-happened: the refusal is before the first write.
    expect(getLocalUser(from)).not.toBeNull();
  });

  test("refuses a name only the registry holds, because that is the same namespace", async () => {
    const from = await account();
    const to = uniq("addressed");
    getDb()
      .prepare(`INSERT INTO agent_registry (id, name, channel, approved) VALUES (?, ?, 'native', 1)`)
      .run(to, to);
    try {
      expect(renameLocalAccount(from, to)).toEqual({ ok: false, reason: "name_taken" });
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

  test("moves `admin` to `platform-admin` once, and does nothing on the next start", async () => {
    await legacyAdmin();
    written.push(SEED_ADMIN_USERNAME);

    renameSeededAdmin();
    expect(getLocalUser(LEGACY_SEED_ADMIN_USERNAME)).toBeNull();
    expect(getLocalUser(SEED_ADMIN_USERNAME)?.role).toBe("admin");

    // Idempotent: the second start has nothing named `admin` to find.
    renameSeededAdmin();
    expect(getLocalUser(SEED_ADMIN_USERNAME)).not.toBeNull();
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

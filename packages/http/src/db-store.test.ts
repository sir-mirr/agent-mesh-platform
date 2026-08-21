/**
 * The parts of `db.ts` a route never reaches: the conversation query, the
 * registry count, the admin seed's two decisions, and closing the handle.
 *
 * **The seed cases empty `local_users` and put it back.** Every test file in
 * this package shares one state directory and one process, so the table is
 * whatever the files before this one left; `seedLocalUsers` only acts on an
 * empty table, and the re-seed branch only on a non-empty one. Each case sets
 * up the table it needs and the snapshot is restored in `afterAll`, so a file
 * that runs after this one sees exactly what it would have seen without it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "@agent-mesh/store";

import { captureConsole } from "@agent-mesh/log";

import {
  closeDb,
  countRegistryAgents,
  getConversation,
  getDb,
  getLocalUser,
  insertMessage,
  listApprovedWebUserIds,
  listRegistryAgents,
  seedLocalUsers,
  upsertApprovedWebUser,
} from "./db";

let n = 0;
const uniq = (p: string) => `dbs-${p}-${++n}-${process.pid}`;

const snapshot = getDb().prepare("SELECT * FROM local_users").all() as Array<Record<string, unknown>>;

function emptyLocalUsers(): void {
  getDb().prepare("DELETE FROM local_users").run();
}

function restoreLocalUsers(): void {
  emptyLocalUsers();
  for (const row of snapshot) {
    const columns = Object.keys(row);
    getDb()
      .prepare(`INSERT INTO local_users (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...(columns.map((column) => row[column]) as any[]));
  }
}

afterAll(restoreLocalUsers);

describe("getConversation", () => {
  test("returns both directions between the two agents and nothing else", () => {
    const a = uniq("a");
    const b = uniq("b");
    const c = uniq("c");
    const at = (seconds: number) => `2026-08-22 10:00:0${seconds}`;
    insertMessage({ id: uniq("m"), from: a, to: b, content: "one", status: "sent", ts: at(1) });
    insertMessage({ id: uniq("m"), from: b, to: a, content: "two", status: "sent", ts: at(2) });
    insertMessage({ id: uniq("m"), from: a, to: c, content: "elsewhere", status: "sent", ts: at(3) });
    insertMessage({ id: uniq("m"), from: c, to: b, content: "elsewhere too", status: "sent", ts: at(4) });

    expect(getConversation(a, b).map((m) => m.content)).toEqual(["one", "two"]);
  });

  test("is symmetric in its arguments", () => {
    const a = uniq("a");
    const b = uniq("b");
    insertMessage({ id: uniq("m"), from: a, to: b, content: "one", status: "sent", ts: "2026-08-22 11:00:01" });
    insertMessage({ id: uniq("m"), from: b, to: a, content: "two", status: "sent", ts: "2026-08-22 11:00:02" });

    expect(getConversation(b, a).map((m) => m.content)).toEqual(getConversation(a, b).map((m) => m.content));
  });

  test("the limit keeps the newest and still answers oldest first", () => {
    const a = uniq("a");
    const b = uniq("b");
    for (let i = 1; i <= 4; i++) {
      insertMessage({ id: uniq("m"), from: a, to: b, content: `m${i}`, status: "sent", ts: `2026-08-22 12:00:0${i}` });
    }

    expect(getConversation(a, b, 2).map((m) => m.content)).toEqual(["m3", "m4"]);
  });

  test("carries the stored row through, not a summary of it", () => {
    const a = uniq("a");
    const b = uniq("b");
    const id = uniq("m");
    insertMessage({
      id,
      from: a,
      to: b,
      content: "with an attachment",
      reply_to: "earlier-id",
      file_path: "/tmp/attachment.txt",
      status: "delivered",
      ts: "2026-08-22 13:00:00",
    });

    expect(getConversation(a, b)[0]).toEqual({
      id,
      from_agent: a,
      to_agent: b,
      content: "with an attachment",
      reply_to: "earlier-id",
      file_path: "/tmp/attachment.txt",
      status: "delivered",
      ts: "2026-08-22 13:00:00",
    });
  });

  test("two agents who never spoke have no conversation", () => {
    expect(getConversation(uniq("a"), uniq("b"))).toEqual([]);
  });
});

describe("countRegistryAgents", () => {
  test("agrees with the listing", () => {
    expect(countRegistryAgents()).toBe(listRegistryAgents().length);
  });

  test("rises by one for a registry agent that is new, and not for one that is not", () => {
    const before = countRegistryAgents();
    const login = uniq("user");
    upsertApprovedWebUser(login);
    expect(countRegistryAgents()).toBe(before + 1);

    upsertApprovedWebUser(login);
    expect(countRegistryAgents()).toBe(before + 1);
  });
});

describe("seedLocalUsers", () => {
  let logged: string[] = [];
  let restore = () => {};

  beforeEach(() => {
    ({ lines: logged, restore } = captureConsole());
    emptyLocalUsers();
    delete process.env.AGENT_MESH_ADMIN_PASSWORD;
  });

  afterEach(() => {
    restore();
    delete process.env.AGENT_MESH_ADMIN_PASSWORD;
  });

  test("with no password stated, seeds the documented default and says so", async () => {
    await seedLocalUsers();

    const admin = getLocalUser("admin");
    expect(admin).not.toBeNull();
    expect(await Bun.password.verify("admin", admin!.password_hash)).toBe(true);
    expect(admin!.must_change_password).toBe(1);
    expect(admin!.role).toBe("admin");
    expect(logged.join("\n")).toContain("default password");
  });

  test("with a password stated, seeds that one and names the variable, not the password", async () => {
    process.env.AGENT_MESH_ADMIN_PASSWORD = "a-stated-one";
    await seedLocalUsers();

    const admin = getLocalUser("admin");
    expect(await Bun.password.verify("a-stated-one", admin!.password_hash)).toBe(true);
    expect(await Bun.password.verify("admin", admin!.password_hash)).toBe(false);
    expect(logged.join("\n")).toContain("AGENT_MESH_ADMIN_PASSWORD");
    expect(logged.join("\n")).not.toContain("a-stated-one");
  });

  test("a stated password is an initial one: the first login still has to change it", async () => {
    process.env.AGENT_MESH_ADMIN_PASSWORD = "a-stated-one";
    await seedLocalUsers();

    expect(getLocalUser("admin")!.must_change_password).toBe(1);
  });

  test("the seeded account is a mesh participant, not only a login", async () => {
    await seedLocalUsers();

    expect(listApprovedWebUserIds()).toContain("admin");
  });

  test("an existing admin still on the initial password is marked on the next boot", async () => {
    await seedLocalUsers();
    getDb().prepare("UPDATE local_users SET must_change_password = 0 WHERE username = 'admin'").run();
    logged.length = 0;

    await seedLocalUsers();

    expect(getLocalUser("admin")!.must_change_password).toBe(1);
    expect(logged.join("\n")).toContain("initial password");
  });

  test("the initial password it checks against is the stated one", async () => {
    process.env.AGENT_MESH_ADMIN_PASSWORD = "a-stated-one";
    await seedLocalUsers();
    getDb().prepare("UPDATE local_users SET must_change_password = 0 WHERE username = 'admin'").run();

    await seedLocalUsers();

    expect(getLocalUser("admin")!.must_change_password).toBe(1);
  });

  test("an admin who chose a password is left alone", async () => {
    await seedLocalUsers();
    const chosen = await Bun.password.hash("something-nobody-published", { algorithm: "bcrypt" });
    getDb()
      .prepare("UPDATE local_users SET must_change_password = 0, password_hash = ? WHERE username = 'admin'")
      .run(chosen);
    logged.length = 0;

    await seedLocalUsers();

    expect(getLocalUser("admin")!.must_change_password).toBe(0);
    expect(logged.join("\n")).not.toContain("initial password");
  });

  test("an admin already marked is not re-checked against the initial password", async () => {
    await seedLocalUsers();
    logged.length = 0;

    await seedLocalUsers();

    expect(getLocalUser("admin")!.must_change_password).toBe(1);
    expect(logged).toEqual([]);
  });

  test("a second boot does not seed a second admin", async () => {
    await seedLocalUsers();
    await seedLocalUsers();

    const count = getDb().prepare("SELECT COUNT(*) as cnt FROM local_users").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  test("every local user reaches the registry, not only the seeded one", async () => {
    await seedLocalUsers();
    const late = uniq("late-user");
    getDb()
      .prepare("INSERT INTO local_users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)")
      .run(late, "not-a-real-hash", null, "member");

    await seedLocalUsers();

    expect(listApprovedWebUserIds()).toContain(late);
  });
});

describe("closeDb", () => {
  const wal = () =>
    existsSync(join(stateDir(), "agent-mesh.db-wal")) ? statSync(join(stateDir(), "agent-mesh.db-wal")).size : 0;

  test("folds the log rather than leaving it beside a one-page database", () => {
    const payload = "x".repeat(4000);
    for (let i = 0; i < 200; i++) {
      insertMessage({ id: uniq("wal"), from: "a", to: "b", content: payload, status: "sent", ts: "2026-08-22 15:00:00" });
    }
    expect(wal()).toBeGreaterThan(0);

    closeDb();

    expect(wal()).toBe(0);
  });

  test("what was written before the close is there after it", () => {
    const a = uniq("a");
    const b = uniq("b");
    insertMessage({ id: uniq("m"), from: a, to: b, content: "survives", status: "sent", ts: "2026-08-22 14:00:00" });

    closeDb();

    expect(getConversation(a, b).map((m) => m.content)).toEqual(["survives"]);
  });

  test("opens a new handle rather than handing back the closed one", () => {
    const before = getDb();
    closeDb();

    expect(getDb()).not.toBe(before);
  });

  test("closing twice is not an error", () => {
    closeDb();
    expect(() => closeDb()).not.toThrow();
    expect(countRegistryAgents()).toBeGreaterThanOrEqual(0);
  });
});

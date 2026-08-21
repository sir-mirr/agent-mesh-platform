/**
 * The hub's handles: what the proxy declaration parses to, what applying it
 * writes, and what the shutdown does to the files.
 *
 * The shutdown case runs against stores this file opens in its own directory.
 * `close-databases.test.ts` is the same call against the module's singletons
 * and needs a child process to survive it; this one asserts the same property
 * — every log folded, `audit` folded without being closed — in a process that
 * keeps running, so nothing here can close a handle another test file holds.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsSchema, auditSchema, hubSchema, openAt, selfReminderSchema } from "@agent-mesh/store";

import {
  agentsDb,
  applyDeclaredProxy,
  auditDb,
  closeDatabases,
  db,
  hubStores,
  parseDeclaredProxies,
  srDb,
  type HubStores,
} from "./db";

let n = 0;
const uniq = (p: string) => `hdb-${p}-${++n}-${process.pid}`;

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("parseDeclaredProxies", () => {
  test("a deployment that declares nothing declares nothing", () => {
    expect(parseDeclaredProxies(undefined).size).toBe(0);
    expect(parseDeclaredProxies("").size).toBe(0);
  });

  test("reads a comma-separated list, spacing and all", () => {
    expect([...parseDeclaredProxies(" agent-mesh-http , other-proxy ")]).toEqual([
      "agent-mesh-http",
      "other-proxy",
    ]);
  });

  test("an empty segment is not an identity", () => {
    expect([...parseDeclaredProxies("a,,b,")]).toEqual(["a", "b"]);
    expect([...parseDeclaredProxies(" , ")]).toEqual([]);
  });

  test("declaring the same identity twice declares it once", () => {
    expect([...parseDeclaredProxies("a,a")]).toEqual(["a"]);
  });
});

describe("applyDeclaredProxy", () => {
  function agentsStore(): Database {
    const dir = mkdtempSync(join(tmpdir(), "hub-declared-"));
    dirs.push(dir);
    const store = openAt(join(dir, "agents.db"), { create: true });
    agentsSchema.migrate(store);
    return store;
  }

  const insert = (store: Database, identity: string) =>
    store
      .prepare("INSERT INTO agents (identity, description, last_seen, created_at) VALUES (?, '', datetime('now'), datetime('now'))")
      .run(identity);

  const canProxy = (store: Database, identity: string) =>
    (store.prepare("SELECT can_proxy FROM agents WHERE identity = ?").get(identity) as { can_proxy: number } | null)
      ?.can_proxy ?? null;

  test("grants the declared identity", () => {
    const store = agentsStore();
    const identity = uniq("proxy");
    insert(store, identity);

    applyDeclaredProxy(identity, new Set([identity]), store);

    expect(canProxy(store, identity)).toBe(1);
  });

  test("an identity the deployment did not declare is left alone", () => {
    const store = agentsStore();
    const declared = uniq("proxy");
    const other = uniq("other");
    insert(store, declared);
    insert(store, other);

    applyDeclaredProxy(other, new Set([declared]), store);

    expect(canProxy(store, other)).toBe(0);
  });

  test("declaring an identity that has not registered yet is not an error", () => {
    const store = agentsStore();
    const identity = uniq("unregistered");

    expect(() => applyDeclaredProxy(identity, new Set([identity]), store)).not.toThrow();
    expect(canProxy(store, identity)).toBeNull();
  });

  test("granting twice leaves it granted", () => {
    const store = agentsStore();
    const identity = uniq("proxy");
    insert(store, identity);

    applyDeclaredProxy(identity, new Set([identity]), store);
    applyDeclaredProxy(identity, new Set([identity]), store);

    expect(canProxy(store, identity)).toBe(1);
  });
});

describe("srDb", () => {
  test("opens the scheduler's store on first use and hands back the same handle after", () => {
    const first = srDb();

    expect(srDb()).toBe(first);
  });

  test("migrates on the way, so a reminder can be written to a directory the daemon never touched", () => {
    const table = srDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'")
      .get() as { name: string } | null;

    expect(table?.name).toBe("reminders");
  });
});

describe("hubStores", () => {
  test("names the handles this module owns", () => {
    const opened = srDb();

    expect(hubStores()).toEqual({ routing: db, agents: agentsDb, audit: auditDb, selfReminder: opened });
  });
});

describe("closeDatabases", () => {
  function stores(): { stores: HubStores; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "hub-shutdown-"));
    dirs.push(dir);
    const routing = openAt(join(dir, "hub.db"), { create: true });
    const agents = openAt(join(dir, "agents.db"), { create: true });
    const audit = openAt(join(dir, "audit.db"), { create: true });
    const selfReminder = openAt(join(dir, "self-reminder.db"), { create: true });
    hubSchema.migrate(routing);
    agentsSchema.migrate(agents);
    auditSchema.migrate(audit);
    selfReminderSchema.migrate(selfReminder);
    return { stores: { routing, agents, audit, selfReminder }, dir };
  }

  const wal = (dir: string, name: string) =>
    existsSync(join(dir, `${name}-wal`)) ? statSync(join(dir, `${name}-wal`)).size : 0;

  /** Enough rows that SQLite has a log to fold, in every store the hub owns. */
  function fill(handles: HubStores): void {
    const payload = "x".repeat(4000);
    const message = handles.routing.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content) VALUES (?, 'a', 'b', ?)",
    );
    const agent = handles.agents.prepare(
      "INSERT INTO agents (identity, description, last_seen, created_at) VALUES (?, ?, datetime('now'), datetime('now'))",
    );
    const event = handles.audit.prepare(
      `INSERT INTO audit_events (event_id, schema_version, event_type, occurred_at,
                                 identity, recorded_by_kind, payload, payload_digest)
       VALUES (?, 1, 'test.event', datetime('now'), 'a', 'hub', ?, 'sha256:0')`,
    );
    for (let i = 0; i < 200; i++) {
      message.run(`m${i}`, payload);
      agent.run(`a${i}`, payload);
      event.run(`e${i}`, payload);
    }
  }

  test("folds every log it owns, including the store it does not close", () => {
    const { stores: handles, dir } = stores();
    fill(handles);
    for (const name of ["hub.db", "agents.db", "audit.db"]) {
      expect({ name, wrote: wal(dir, name) > 0 }).toEqual({ name, wrote: true });
    }

    closeDatabases(handles);

    for (const name of ["hub.db", "agents.db", "audit.db"]) {
      expect({ name, wal: wal(dir, name) }).toEqual({ name, wal: 0 });
    }
  });

  test("stops further use of the routing and identity stores", () => {
    const { stores: handles } = stores();

    closeDatabases(handles);

    expect(() => handles.routing.prepare("SELECT 1 AS one").get()).toThrow();
    expect(() => handles.agents.prepare("SELECT 1 AS one").get()).toThrow();
  });

  test("leaves audit open, because § 8.9 writes are still on the shutdown path", () => {
    const { stores: handles } = stores();

    closeDatabases(handles);

    expect(handles.audit.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });

  test("closes the scheduler's store when it was opened", () => {
    const { stores: handles } = stores();

    closeDatabases(handles);

    expect(() => handles.selfReminder!.prepare("SELECT 1 AS one").get()).toThrow();
  });

  test("a deployment that never scheduled a reminder shuts down the same way", () => {
    const { stores: handles, dir } = stores();
    handles.selfReminder!.close();
    const without: HubStores = { ...handles, selfReminder: null };
    fill(without);

    expect(() => closeDatabases(without)).not.toThrow();
    expect(wal(dir, "hub.db")).toBe(0);
  });

  test("closing another caller's stores does not take this module's lazy handle with it", () => {
    const opened = srDb();
    const { stores: handles } = stores();

    closeDatabases(handles);

    expect(srDb()).toBe(opened);
    expect(srDb().prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });
});

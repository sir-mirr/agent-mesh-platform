import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAt, stateDir, STORE_FILES } from "./open";
import * as keys from "./keys";
import * as agentsSchema from "./schema/agents";
import * as hubSchema from "./schema/hub";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-store-"));
  return openAt(join(dir, "test.db"), { create: true });
}

function columns(db: ReturnType<typeof tempDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
}

describe("state dir", () => {
  test("prefers the environment over the built-in default", () => {
    expect(stateDir({ AGENT_MESH_STATE_DIR: "/custom" })).toBe("/custom");
    expect(stateDir({})).toBe("/srv/agent-mesh-lab/state/shared");
  });

  test("names every store", () => {
    expect(Object.values(STORE_FILES)).toEqual([
      "agents.db",
      "hub.db",
      "audit.db",
      "self-reminder.db",
    ]);
  });
});

describe("agents schema", () => {
  test("creates the table SPEC § 3.1 requires", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    expect(columns(db, "agents")).toEqual([
      "can_proxy", "created_at", "deleted_at", "description", "identity", "last_seen", "type",
    ]);
  });

  test("adds can_proxy to a database written before entitlement existed, defaulting to none", () => {
    const db = tempDb();
    db.exec(`CREATE TABLE agents (identity TEXT PRIMARY KEY, description TEXT, last_seen DATETIME)`);
    db.prepare(`INSERT INTO agents (identity) VALUES ('incumbent')`).run();

    agentsSchema.migrate(db);

    // 0 is the safe direction for a column arriving under an existing
    // deployment: an identity nobody has granted this to cannot speak for
    // anyone (SPEC § 8.2).
    expect(db.prepare(`SELECT can_proxy FROM agents WHERE identity = 'incumbent'`).get())
      .toEqual({ can_proxy: 0 });
  });

  test("adds deleted_at to a database written before soft delete existed", () => {
    const db = tempDb();
    db.exec(`CREATE TABLE agents (identity TEXT PRIMARY KEY, description TEXT, last_seen DATETIME)`);
    agentsSchema.migrate(db);
    expect(columns(db, "agents")).toContain("deleted_at");
  });

  test("seeds the type registry, marking AI runtimes as needing a key", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    const types = agentsSchema.listTypes(db);
    expect(types.map((t) => t.type).sort())
      .toEqual(["ai-antigravity", "ai-claude", "ai-codex", "human", "service"]);
    expect(agentsSchema.getType(db, "ai-antigravity")?.requires_key).toBe(1);
    // Baseline services predate keys; a deployment wanting them authenticated
    // raises this flag rather than changing code.
    expect(agentsSchema.getType(db, "service")?.requires_key).toBe(0);
    // A person is authenticated by session token at the web surface and holds
    // no key; requiring one would require a browser to hold it.
    expect(agentsSchema.getType(db, "human")?.requires_key).toBe(0);
    expect(agentsSchema.getType(db, "nonesuch")).toBeNull();
  });

  test("seeding twice neither duplicates nor overwrites a local edit", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    db.prepare(`UPDATE agent_types SET requires_key = 1 WHERE type = 'service'`).run();

    agentsSchema.migrate(db);

    expect(agentsSchema.listTypes(db)).toHaveLength(5);
    // INSERT OR IGNORE: a deployment that tightened a seeded row keeps it.
    expect(agentsSchema.getType(db, "service")?.requires_key).toBe(1);
  });

  test("permits at most one approved and one pending key per identity", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    const insert = db.prepare(
      `INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run("a", "agent", "k1", "approved");
    expect(() => insert.run("b", "agent", "k2", "approved")).toThrow();
    expect(() => insert.run("c", "agent", "k3", "pending")).not.toThrow();
    expect(() => insert.run("d", "agent", "k4", "pending")).toThrow();
    // Terminal states are unconstrained: an identity accumulates them over time.
    expect(() => insert.run("e", "agent", "k5", "revoked")).not.toThrow();
    expect(() => insert.run("f", "agent", "k6", "revoked")).not.toThrow();
  });

  test("approvedKey finds the approved one and ignores the rest", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    const insert = db.prepare(
      `INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run("old", "agent", "k-old", "revoked");
    insert.run("new", "agent", "k-new", "approved");
    insert.run("next", "agent", "k-next", "pending");

    expect(agentsSchema.approvedKey(db, "agent")).toMatchObject({
      fingerprint: "new", public_key: "k-new",
    });
    expect(agentsSchema.approvedKey(db, "unknown-agent")).toBeNull();
  });

  test("adds type and created_at to a database written before they existed", () => {
    const db = tempDb();
    db.exec(`CREATE TABLE agents (identity TEXT PRIMARY KEY, description TEXT, last_seen DATETIME)`);
    db.prepare(`INSERT INTO agents (identity, last_seen) VALUES (?, ?)`).run("old", "2026-01-01 00:00:00");

    agentsSchema.migrate(db);

    expect(columns(db, "agents")).toContain("type");
    expect(columns(db, "agents")).toContain("created_at");
    // Backfilled from last_seen: there was no better source, and SPEC § 10.1
    // calls the result best-effort rather than authoritative.
    expect(db.prepare(`SELECT created_at FROM agents WHERE identity = 'old'`).get())
      .toEqual({ created_at: "2026-01-01 00:00:00" });
  });

  test("falls back to now() for a row that never connected", () => {
    const db = tempDb();
    db.exec(`CREATE TABLE agents (identity TEXT PRIMARY KEY, description TEXT, last_seen DATETIME)`);
    db.prepare(`INSERT INTO agents (identity) VALUES (?)`).run("never-seen");

    agentsSchema.migrate(db);

    const row = db.prepare(`SELECT created_at FROM agents WHERE identity = 'never-seen'`).get() as
      { created_at: string | null };
    expect(row.created_at).not.toBeNull();
  });

  test("is idempotent", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    const before = columns(db, "agents");
    expect(() => agentsSchema.migrate(db)).not.toThrow();
    expect(columns(db, "agents")).toEqual(before);
  });
});

describe("hub schema", () => {
  test("creates the messages table", () => {
    const db = tempDb();
    hubSchema.migrate(db);
    expect(columns(db, "messages")).toEqual([
      "content", "from_agent", "id", "leased_until", "reply_to", "sent_by",
      "status", "to_agent", "ts",
    ]);
  });

  test("adds leased_until to a database written before at-least-once delivery", () => {
    const db = tempDb();
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      content TEXT NOT NULL, reply_to TEXT, status TEXT, ts DATETIME
    )`);
    db.prepare(`INSERT INTO messages (id, from_agent, to_agent, content) VALUES (?, ?, ?, ?)`)
      .run("old", "a", "b", "queued before leases existed");

    hubSchema.migrate(db);

    // NULL means never leased, which is what an existing pending row is: it is
    // available to the next caller that asks, rather than invisible until some
    // lease nobody took happens to lapse.
    expect(db.prepare(`SELECT leased_until FROM messages WHERE id = 'old'`).get())
      .toEqual({ leased_until: null });
  });

  test("carries the send idempotency table", () => {
    const db = tempDb();
    hubSchema.migrate(db);
    // Keyed on the sending identity as well as the client's id, so two callers
    // choosing the same key by chance do not collide.
    const info = db.prepare(`PRAGMA table_info(send_idempotency)`).all() as Array<{ name: string; pk: number }>;
    expect(info.filter((c) => c.pk > 0).map((c) => c.name).sort())
      .toEqual(["client_message_id", "sent_by"]);
  });

  test("adds sent_by to a database written before the transmitter was recorded", () => {
    const db = tempDb();
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      content TEXT NOT NULL, reply_to TEXT, status TEXT, ts DATETIME
    )`);
    db.prepare(`INSERT INTO messages (id, from_agent, to_agent, content) VALUES (?, ?, ?, ?)`)
      .run("old", "web-user", "codex", "sent before sent_by existed");

    hubSchema.migrate(db);

    expect(columns(db, "messages")).toContain("sent_by");
    // Deliberately not backfilled from from_agent. Copying it would assert the
    // message was not proxied, which is the one thing these rows cannot say.
    expect(db.prepare(`SELECT sent_by FROM messages WHERE id = 'old'`).get())
      .toEqual({ sent_by: null });
  });

  test("is idempotent", () => {
    const db = tempDb();
    hubSchema.migrate(db);
    expect(() => hubSchema.migrate(db)).not.toThrow();
  });

  test("coexists with the agents schema in one file, as it does at 0.1", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    hubSchema.migrate(db);
    expect(columns(db, "agents").length).toBeGreaterThan(0);
    expect(columns(db, "messages").length).toBeGreaterThan(0);
  });
});

describe("open", () => {
  test("sets WAL on a writable handle", () => {
    const db = tempDb();
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  test("a read-only handle still sees committed writes from another connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-mesh-store-"));
    const path = join(dir, "shared.db");

    const writer = openAt(path, { create: true });
    hubSchema.migrate(writer);
    writer.prepare(`INSERT INTO messages (id, from_agent, to_agent, content) VALUES (?, ?, ?, ?)`)
      .run("m1", "a", "b", "hello");

    const reader = openAt(path, { readonly: true });
    expect(reader.prepare(`SELECT content FROM messages WHERE id = 'm1'`).get())
      .toEqual({ content: "hello" });
  });
});

describe("open, without create", () => {
  test("opens an existing file read-write", () => {
    // http holds agents.db this way: the hub owns the DDL and creates the file,
    // this side only writes decisions into it. Passing neither flag made
    // bun:sqlite refuse the open, and no caller had exercised it before.
    const dir = mkdtempSync(join(tmpdir(), "agent-mesh-store-"));
    const path = join(dir, "existing.db");
    const creator = openAt(path, { create: true });
    agentsSchema.migrate(creator);
    creator.close();

    const writer = openAt(path);
    expect(() =>
      writer.prepare(`INSERT INTO agent_types (type, requires_key) VALUES ('probe', 0)`).run(),
    ).not.toThrow();
  });
});

describe("openStore and openAt agree", () => {
  test("openStore opens an existing file with neither flag set", () => {
    // This is how the hub reaches self-reminder.db, and it threw "flags must
    // include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE" — every reminder
    // RPC returned -32000. openAt had the same hole and was fixed; openStore
    // carried its own copy of the same three lines and was not.
    const dir = mkdtempSync(join(tmpdir(), "agent-mesh-store-"));
    const path = join(dir, "self-reminder.db");
    openAt(path, { create: true }).close();

    const opened = openAt(path);
    expect(() => opened.exec("CREATE TABLE probe (x INTEGER)")).not.toThrow();
  });

  test("openStore is openAt, not a second implementation of it", () => {
    // The duplication is what let one be fixed and the other not, so the test
    // is that there is only one implementation to fix.
    const source = readFileSync(join(import.meta.dir, "open.ts"), "utf8");
    const openStoreBody = source.slice(source.indexOf("export function openStore"));
    expect(openStoreBody).toContain("openAt(");
    expect(openStoreBody.slice(0, openStoreBody.indexOf("\n}"))).not.toContain("new Database");
  });
});

/**
 * `agent_keys` is keyed on the fingerprint alone, so "this key is on record"
 * and "this key is on record **for you**" are different questions. Answering
 * the first when asked the second reported another holder's ruling and
 * inserted nothing (SPEC § 10.1).
 *
 * The route refuses before it writes; this is the backstop under it, so a
 * future caller that skips that check cannot reintroduce the defect quietly.
 */
describe("proposing a key that is already someone else's", () => {
  function seeded() {
    const db = tempDb();
    agentsSchema.migrate(db);
    db.prepare(`INSERT INTO agents (identity, type) VALUES ('owner', 'ai-claude')`).run();
    db.prepare(`INSERT INTO agents (identity, type) VALUES ('thief', 'ai-claude')`).run();
    return db;
  }
  // 43 base64url chars, which is all `PUBLIC_KEY_RE` asks of it. The fingerprint
  // is over the string, so no real key material is needed to test ownership.
  const KEY = "A".repeat(43);

  test("throws rather than reporting the other identity's status", () => {
    const db = seeded();
    const first = keys.proposeKey(db, "owner", KEY, "test");
    expect(first.created).toBe(true);
    expect(() => keys.proposeKey(db, "thief", KEY, "test")).toThrow(keys.KeyOwnershipError);
    db.close();
  });

  test("and records nothing for the caller that was refused", () => {
    // Note what this on its own cannot prove. **Nothing is recorded either
    // way** — that is the defect. A test asserting only the empty result
    // passes against the broken version too, so the refusal is asserted here
    // as well and the row state is the second half of one claim.
    const db = seeded();
    keys.proposeKey(db, "owner", KEY, "test");
    expect(() => keys.proposeKey(db, "thief", KEY, "test")).toThrow(keys.KeyOwnershipError);
    const rows = db.prepare(`SELECT identity FROM agent_keys`).all() as Array<{ identity: string }>;
    expect(rows).toEqual([{ identity: "owner" }]);
    const events = db.prepare(`SELECT identity FROM agent_key_events`).all() as Array<{ identity: string }>;
    expect(events.every((e) => e.identity === "owner")).toBe(true);
    db.close();
  });

  test("the error does not carry the holder's name", () => {
    // § 10.2 keeps fingerprint-to-identity closed, and an exception message
    // reaches logs and, if a handler is careless, responses.
    //
    // The error is captured rather than asserted inside a `try` whose `catch`
    // would swallow the "it did not throw" failure and pass — which is what
    // the first draft of this test did.
    const db = seeded();
    keys.proposeKey(db, "owner", KEY, "test");
    let caught: unknown = null;
    try {
      keys.proposeKey(db, "thief", KEY, "test");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(keys.KeyOwnershipError);
    expect(String(caught)).not.toContain("owner");
    expect((caught as keys.KeyOwnershipError).fingerprint).toBeTruthy();
    db.close();
  });

  test("the same identity re-proposing is still the no-op it was", () => {
    const db = seeded();
    keys.proposeKey(db, "owner", KEY, "test");
    const again = keys.proposeKey(db, "owner", KEY, "test");
    expect(again.created).toBe(false);
    expect(again.status).toBe("pending");
    db.close();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAt, stateDir, STORE_FILES } from "./open";
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
      "created_at", "deleted_at", "description", "identity", "last_seen", "type",
    ]);
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
      .toEqual(["ai-claude", "ai-codex", "ai-gemini", "service"]);
    expect(agentsSchema.getType(db, "ai-gemini")?.requires_key).toBe(1);
    // Baseline services predate keys; a deployment wanting them authenticated
    // raises this flag rather than changing code.
    expect(agentsSchema.getType(db, "service")?.requires_key).toBe(0);
    expect(agentsSchema.getType(db, "nonesuch")).toBeNull();
  });

  test("seeding twice neither duplicates nor overwrites a local edit", () => {
    const db = tempDb();
    agentsSchema.migrate(db);
    db.prepare(`UPDATE agent_types SET requires_key = 1 WHERE type = 'service'`).run();

    agentsSchema.migrate(db);

    expect(agentsSchema.listTypes(db)).toHaveLength(4);
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
      "content", "from_agent", "id", "reply_to", "status", "to_agent", "ts",
    ]);
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

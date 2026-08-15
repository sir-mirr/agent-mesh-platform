import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ensureAgentRegistrySchema, importLegacyRegistry } from "./db";

function testDb(): Database {
  const db = new Database(":memory:");
  ensureAgentRegistrySchema(db);
  return db;
}

function writeRegistry(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-registry-"));
  const path = join(dir, "registry.json");
  writeFileSync(path, contents);
  return path;
}

type Row = {
  id: string;
  name: string;
  description: string | null;
  channel: string;
  type: string;
  approved: number;
};

function rows(db: Database): Row[] {
  return db.prepare("SELECT id, name, description, channel, type, approved FROM agent_registry ORDER BY id").all() as Row[];
}

describe("registry.json -> agent_registry import", () => {
  test("applies the same defaults the old file loader applied on read", () => {
    const db = testDb();
    const path = writeRegistry(JSON.stringify({
      agents: {
        // Only `name` — channel/type/approved must fall back to native/agent/approved.
        "bare-agent": { name: "Bare Agent" },
        "full-agent": { name: "Full", description: "d", channel: "discord", type: "agent", approved: true },
        "denied-user": { name: "Denied", channel: "web", type: "user", approved: false },
      },
    }));

    importLegacyRegistry(db, path);

    expect(rows(db)).toEqual([
      { id: "bare-agent", name: "Bare Agent", description: null, channel: "native", type: "agent", approved: 1 },
      { id: "denied-user", name: "Denied", description: null, channel: "web", type: "user", approved: 0 },
      { id: "full-agent", name: "Full", description: "d", channel: "discord", type: "agent", approved: 1 },
    ]);
  });

  test("falls back to the key when an entry carries no name", () => {
    const db = testDb();
    const path = writeRegistry(JSON.stringify({ agents: { "no-name": {} } }));

    importLegacyRegistry(db, path);

    expect(rows(db)[0]).toMatchObject({ id: "no-name", name: "no-name" });
  });

  test("does not re-import once the table holds rows", () => {
    const db = testDb();
    const path = writeRegistry(JSON.stringify({ agents: { a: { name: "A" } } }));
    importLegacyRegistry(db, path);

    // Table is now the source of truth: a later edit to the file is ignored, and
    // a local change is not overwritten.
    db.prepare("UPDATE agent_registry SET approved = 0 WHERE id = 'a'").run();
    writeFileSync(path, JSON.stringify({ agents: { a: { name: "A" }, b: { name: "B" } } }));
    importLegacyRegistry(db, path);

    expect(rows(db)).toEqual([
      { id: "a", name: "A", description: null, channel: "native", type: "agent", approved: 0 },
    ]);
  });

  test("is a no-op when the file is absent, empty, or unparseable", () => {
    for (const path of [
      join(tmpdir(), "agent-mesh-registry-does-not-exist", "registry.json"),
      writeRegistry(JSON.stringify({ agents: {} })),
      writeRegistry("{ not json"),
      writeRegistry(JSON.stringify({})),
    ]) {
      const db = testDb();
      expect(() => importLegacyRegistry(db, path)).not.toThrow();
      expect(rows(db)).toEqual([]);
    }
  });
});

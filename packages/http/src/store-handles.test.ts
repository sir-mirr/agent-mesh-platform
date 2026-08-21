/**
 * Three modules hold a lazy handle on a store, and each exports the close for
 * it. The closes had never been called by anything a coverage run can see:
 * `test/` reaches them through a process it then kills, which proves the
 * shutdown wiring and instruments none of it.
 *
 * What is asserted here is the pair of properties a lazy handle has to have —
 * the log is folded on the way out, and the next caller gets a working handle
 * rather than a closed one. `closeAuditAccessLog` is the one that matters
 * most: it is a second read-write connection on `audit.db`, and it went out
 * unfolded for as long as nothing called it.
 *
 * **Nothing is left behind in either store.** Both are shared with every other
 * file in the run, and one of them is read back by a route that pages the
 * newest fifty events — so the log is grown by churning a single row rather
 * than by writing hundreds, and every row this file writes is removed again.
 *
 * This file owns the `sh-` prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { agentsSchema, auditSchema, openStore, stateDir, STORE_FILES } from "@agent-mesh/store";

import { closeAuditDb, listEvents } from "./audit-query";
import { closeAuditAccessLog, recordContentRead } from "./audit-access-log";
import { agentsDb, closeAgentsDb } from "./keys-admin";

/** Both stores are opened `create: false` by their owners, so they must exist. */
const audit = openStore("audit", { create: true });
auditSchema.migrate(audit);
const agents = openStore("agents", { create: true });
agentsSchema.migrate(agents);

let n = 0;
const uniq = (p: string) => `sh-${p}-${++n}-${process.pid}`;

const wal = (file: string) =>
  existsSync(join(stateDir(), `${file}-wal`)) ? statSync(join(stateDir(), `${file}-wal`)).size : 0;

/** One row, rewritten until the log has something in it, then deleted below. */
const CHURN = `sh-churn-${process.pid}`;

function churn(db: Database, insert: string, insertParams: unknown[], rewrite: string): void {
  db.prepare(insert).run(...(insertParams as any[]));
  const update = db.prepare(rewrite);
  for (let i = 0; i < 40; i++) update.run("y".repeat(8000), CHURN);
}

afterEach(() => {
  audit.prepare("DELETE FROM audit_events WHERE identity LIKE 'sh-%' OR event_id LIKE 'sh-%'").run();
  agents.prepare("DELETE FROM agents WHERE identity LIKE 'sh-%'").run();
});

describe("closeAuditAccessLog", () => {
  test("folds the log the § 8.9 access record was written to", () => {
    recordContentRead({ actor: uniq("actor"), target: "list", query: {} });
    churn(
      audit,
      `INSERT INTO audit_events (event_id, schema_version, event_type, occurred_at, identity, recorded_by_kind, payload, payload_digest)
       VALUES (?, 1, 'sh.churn', datetime('now'), ?, 'http', 'x', 'sha256:0')`,
      [CHURN, CHURN],
      "UPDATE audit_events SET payload = ? WHERE event_id = ?",
    );
    expect(wal(STORE_FILES.audit)).toBeGreaterThan(0);

    closeAuditAccessLog();

    expect(wal(STORE_FILES.audit)).toBe(0);
  });

  test("the next read is recorded, on a handle opened again", () => {
    const actor = uniq("actor");
    closeAuditAccessLog();

    recordContentRead({ actor, target: "evt_1", query: {} });

    const row = audit
      .prepare("SELECT COUNT(*) AS cnt FROM audit_events WHERE identity = ?")
      .get(actor) as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  test("closing a handle nothing opened is not an error", () => {
    closeAuditAccessLog();

    expect(() => closeAuditAccessLog()).not.toThrow();
  });
});

describe("closeAuditDb", () => {
  test("the query handle is reopened for the next caller", () => {
    expect(listEvents({}, false).status).toBe(200);

    closeAuditDb();

    expect(listEvents({}, false).status).toBe(200);
  });

  test("closing twice is not an error", () => {
    closeAuditDb();

    expect(() => closeAuditDb()).not.toThrow();
  });
});

describe("closeAgentsDb", () => {
  test("hands out a new handle rather than the closed one", () => {
    const before = agentsDb();

    closeAgentsDb();

    expect(agentsDb()).not.toBe(before);
  });

  test("folds the identity store's log", () => {
    agentsDb();
    churn(
      agents,
      "INSERT INTO agents (identity, description, last_seen, created_at) VALUES (?, ?, datetime('now'), datetime('now'))",
      [CHURN, "x"],
      "UPDATE agents SET description = ? WHERE identity = ?",
    );
    expect(wal(STORE_FILES.agents)).toBeGreaterThan(0);

    closeAgentsDb();

    expect(wal(STORE_FILES.agents)).toBe(0);
  });

  test("closing a handle nothing opened is not an error", () => {
    closeAgentsDb();

    expect(() => closeAgentsDb()).not.toThrow();
  });
});

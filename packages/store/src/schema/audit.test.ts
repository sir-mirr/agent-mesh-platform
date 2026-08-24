/**
 * The shape of `audit.db`, asked of the schema rather than of a caller.
 *
 * Every guard here is one a caller cannot supply. An event id that repeats is
 * refused by the table or it is not refused at all — the insert in `db.ts` is a
 * plain `INSERT`, and the check that precedes it is a separate statement, so
 * the constraint is what stands between a retry landing twice and a record with
 * two events under one id. The paging index is the same kind of fact: § 9.1
 * pages by `(stored_at, event_id)` ascending, and an index that does not match
 * that ordering skips or repeats rows when something is appended mid-page.
 *
 * Planted before this file existed: taking `PRIMARY KEY` off `event_id` passed
 * all 2138 package tests and both audit suites in `test/`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "./audit";

const migrated = (): Database => {
  const db = new Database(":memory:");
  migrate(db);
  return db;
};

const append = (db: Database, eventId: string) =>
  db
    .prepare(
      `INSERT INTO audit_events (
         event_id, schema_version, event_type, occurred_at, identity,
         recorded_by_kind, payload, payload_digest
       ) VALUES (?, 1, 'mesh.message.sent', '2026-08-24T00:00:00Z', 'agent-one', 'agent', '{}', 'sha256:0')`,
    )
    .run(eventId);

describe("the audit table", () => {
  test("refuses a second event under an id it already holds", () => {
    const db = migrated();
    append(db, "evt-1");
    // The retry a client makes when it did not see the first answer. Without
    // the constraint this is two events, and the record says something
    // happened twice that happened once.
    expect(() => append(db, "evt-1")).toThrow(/UNIQUE|PRIMARY|constraint/i);
    expect(db.prepare(`SELECT count(*) AS n FROM audit_events`).get()).toEqual({ n: 1 });
  });

  test("takes two different events", () => {
    // The other direction, so the test above cannot pass by refusing
    // everything.
    const db = migrated();
    append(db, "evt-1");
    append(db, "evt-2");
    expect(db.prepare(`SELECT count(*) AS n FROM audit_events`).get()).toEqual({ n: 2 });
  });

  test("pages on an index in the order the query API reads", () => {
    const db = migrated();
    const columns = db
      .prepare(`SELECT name FROM pragma_index_info('idx_audit_events_stored') ORDER BY seqno`)
      .all() as Array<{ name: string }>;
    // Order matters: an index on (event_id, stored_at) answers the same
    // queries and paginates differently.
    expect(columns.map((c) => c.name)).toEqual(["stored_at", "event_id"]);
  });

  test("keeps every column the record is written with", () => {
    // A migration that drops a column does not fail — it fails later, at the
    // insert, in whichever process happens to be writing.
    const db = migrated();
    const columns = (db.prepare(`SELECT name FROM pragma_table_info('audit_events')`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(columns).toEqual([
      "event_id",
      "schema_version",
      "event_type",
      "occurred_at",
      "correlation_id",
      "causation_event_id",
      "producer_id",
      "identity",
      "recorded_by_kind",
      "recorded_by_id",
      "payload",
      "payload_digest",
      "attestation",
      "stored_at",
    ]);
  });
});

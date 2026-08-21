/**
 * What the § 10.2.1 poll does when the read it depends on fails.
 *
 * The first version swallowed it, under a comment saying silence is the
 * failure this file exists to prevent — a broken query then left the stream
 * looking perfectly healthy while it pushed nothing. So the tick reports and
 * survives: throwing out of a `setInterval` callback takes the interval down,
 * and an operator whose dashboard has quietly stopped receiving proposals is
 * back where the file started.
 *
 * This file owns the `kpr-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { agentsSchema } from "@agent-mesh/store";

import { pendingSince, watchProposals } from "./key-proposals";

let n = 0;
const uniq = (p: string) => `kpr-${p}-${++n}-${process.pid}`;

function store(): Database {
  const db = new Database(":memory:");
  agentsSchema.migrate(db);
  return db;
}

function propose(db: Database, identity = uniq("agent")): string {
  const fingerprint = `${uniq("fp")}`.padEnd(64, "0");
  db.prepare("INSERT INTO agents (identity, description, last_seen, created_at) VALUES (?, '', datetime('now'), datetime('now'))")
    .run(identity);
  db.prepare("INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, 'pk', 'pending')")
    .run(fingerprint, identity);
  return fingerprint;
}

/** The tick is on an interval; this waits for it rather than guessing. */
async function until(predicate: () => boolean, ms = 1_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(2);
  }
  return predicate();
}

describe("watchProposals", () => {
  test("reports a proposal that arrives, once", async () => {
    const db = store();
    const seen: string[] = [];
    const stop = watchProposals(db, (p) => seen.push(p.fingerprint), 1);
    try {
      const fingerprint = propose(db);

      expect(await until(() => seen.length > 0)).toBe(true);
      await Bun.sleep(10);
      expect(seen).toEqual([fingerprint]);
    } finally {
      stop();
    }
  });

  test("what is already pending is not announced as new", async () => {
    const db = store();
    propose(db);
    const seen: string[] = [];
    const stop = watchProposals(db, (p) => seen.push(p.fingerprint), 1);
    try {
      await Bun.sleep(20);

      expect(seen).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a read that fails is reported and does not take the poll down", async () => {
    const db = store();
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    const seen: string[] = [];
    const stop = watchProposals(db, (p) => seen.push(p.fingerprint), 1);
    try {
      db.exec("ALTER TABLE agent_keys RENAME TO agent_keys_moved");
      expect(await until(() => errors.length > 0)).toBe(true);
      expect(errors[0]).toContain("key-proposal poll failed");

      // Still polling: the table comes back and so does the reporting.
      db.exec("ALTER TABLE agent_keys_moved RENAME TO agent_keys");
      const fingerprint = propose(db);

      expect(await until(() => seen.length > 0)).toBe(true);
      expect(seen).toEqual([fingerprint]);
    } finally {
      console.error = realError;
      stop();
    }
  });

  test("stopping ends the poll", async () => {
    const db = store();
    const seen: string[] = [];
    const stop = watchProposals(db, (p) => seen.push(p.fingerprint), 1);
    stop();

    propose(db);
    await Bun.sleep(20);

    expect(seen).toEqual([]);
  });

  test("pendingSince answers oldest first and only what is pending", () => {
    const db = store();
    const first = propose(db);
    const second = propose(db);
    db.prepare("UPDATE agent_keys SET status = 'approved' WHERE fingerprint = ?").run(second);

    expect(pendingSince(db).map((p) => p.fingerprint)).toEqual([first]);
  });
});

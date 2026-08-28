/**
 * The held-slot reader and the decision writer, driven in this process.
 *
 * `test/reminder-overdue.test.ts` drives the same code through the two admin
 * routes, which is the check that matters for the contract — and it proves
 * nothing about coverage, because the service runs in a spawned process and
 * the instrumentation only sees this one. That is not a technicality: it is
 * how a module with 143 lines sat at 10% while its behaviour was covered.
 *
 * What is here that a route cannot reach:
 *
 * - **The hold-key parse, on keys a scheduler would not write.** The first
 *   version cut on `lastIndexOf(':')` and landed inside `HH:MM:SS`, so the
 *   reminder id came back with half the date attached and the slot read as the
 *   year 2000. Nothing threw. A route test cannot plant a malformed key.
 * - **The absent store.** `self-reminder.db` does not exist until something is
 *   scheduled, and only absence answers empty.
 *
 * This file owns the `ro-` prefix.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, selfReminderSchema } from "@agent-mesh/store";

import {
  closeReminderOverdue,
  listHeldOverdue,
  listOverdueDecisions,
  recordOverdueDecision,
} from "./reminder-overdue";

const store = openStore("selfReminder", { create: true });
selfReminderSchema.migrate(store);

let n = 0;
const uniq = (p: string) => `ro-${p}-${++n}-${process.pid}`;

const HOLD = "overdue_hold:";

/** Plant a hold the way `ReminderScheduler` plants one. */
function hold(reminderId: string, slot: string, heldAt: string): void {
  store
    .prepare(`INSERT INTO scheduler_health (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(`${HOLD}${reminderId}:${slot}`, heldAt, heldAt);
}

function reminder(id: string, agentId: string, status: string): void {
  store
    .prepare(
      `INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, status, created_at, created_by)
       VALUES (?, ?, 'once', '2026-07-14T09:00:00Z', '{}', ?, '2026-07-14 08:00:00', 'ops')`,
    )
    .run(id, agentId, status);
}

/** Only this file's rows. Every other suite's holds are somebody else's fixture. */
const mine =
  (ids: string[]) =>
  <T extends { reminder_id: string }>(rows: T[]): T[] =>
    rows.filter((r) => ids.includes(r.reminder_id));

afterAll(() => {
  closeReminderOverdue();
});

describe("what the scheduler is holding", () => {
  test("a held slot is listed with how late it already was", () => {
    const id = uniq("late");
    reminder(id, "agent-a", "active");
    hold(id, "2026-07-14 09:00:00", "2026-07-14 11:30:00");

    const [row] = mine([id])(listHeldOverdue());
    expect(row).toEqual({
      reminder_id: id,
      agent_id: "agent-a",
      scheduled_at: "2026-07-14T09:00:00.000Z",
      held_since: "2026-07-14T11:30:00.000Z",
      overdue_ms: 2.5 * 60 * 60 * 1000,
      status: "active",
    });
  });

  test("a reminder id containing a colon survives the parse", () => {
    // The case `lastIndexOf` was reaching for, and the case it got wrong in the
    // other direction: the id keeps its colon and the slot keeps its clock.
    const id = `${uniq("ns")}:sub`;
    reminder(id, "agent-b", "active");
    hold(id, "2026-07-14 09:00:00", "2026-07-14 09:30:00");

    const [row] = mine([id])(listHeldOverdue());
    expect({ id: row?.reminder_id, slot: row?.scheduled_at }).toEqual({
      id,
      slot: "2026-07-14T09:00:00.000Z",
    });
  });

  test("a key whose tail is not a slot is skipped rather than guessed at", () => {
    const id = uniq("junk");
    store
      .prepare(`INSERT INTO scheduler_health (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(`${HOLD}${id}:not-a-time`, "2026-07-14 09:30:00", "2026-07-14 09:30:00");

    expect(listHeldOverdue().filter((r) => r.reminder_id.startsWith(id))).toEqual([]);
  });

  test("a hold whose reminder row is gone is still listed", () => {
    // The case an operator most needs to see. Dropping it would answer
    // "nothing held" for a mesh that is holding something.
    const id = uniq("orphan");
    hold(id, "2026-07-14 09:00:00", "2026-07-14 09:30:00");

    const [row] = mine([id])(listHeldOverdue());
    expect({ agent: row?.agent_id, status: row?.status }).toEqual({ agent: "", status: null });
  });

  test("a hold the scheduler wrote without a usable time reports no lateness", () => {
    const id = uniq("nowhen");
    hold(id, "2026-07-14 09:00:00", "whenever");

    const [row] = mine([id])(listHeldOverdue());
    expect({ overdue: row?.overdue_ms, held: row?.held_since }).toEqual({
      overdue: null,
      held: "whenever",
    });
  });

  test("a decided slot leaves the list, because it is no longer a question", () => {
    const id = uniq("answered");
    reminder(id, "agent-c", "active");
    hold(id, "2026-07-14 09:00:00", "2026-07-14 09:30:00");
    expect(mine([id])(listHeldOverdue()).length).toBe(1);

    const done = recordOverdueDecision(id, "2026-07-14 09:00:00", "skip", "APPROVED:ops-1", "alice");
    expect(done.ok).toBe(true);
    expect(mine([id])(listHeldOverdue())).toEqual([]);
  });
});

describe("recording a decision", () => {
  test("the slot the list published is a slot this accepts, and stores as the scheduler will read it", () => {
    // **The round trip, taking the value from the list rather than from this
    // test.** Every other case here hands `recordOverdueDecision` the SQLite
    // shape, which is the shape the scheduler wrote — so they agreed with the
    // implementation by construction and said nothing about the screen.
    //
    // The screen has only one sensible source for `scheduled_at`: the row the
    // operator clicked. That row carries ISO-8601, because § 9.1 puts ISO on
    // the wire. Fed back, it built a hold key that matched nothing, and every
    // held reminder answered `404 NO_SUCH_HOLD`.
    const id = uniq("roundtrip");
    reminder(id, "agent-e", "active");
    hold(id, "2026-07-14 09:00:00", "2026-07-14 09:30:00");

    const [listed] = mine([id])(listHeldOverdue());
    expect(listed?.scheduled_at, "the list stopped publishing an instant").toBe("2026-07-14T09:00:00.000Z");

    const decided = recordOverdueDecision(id, listed!.scheduled_at, "replay", "APPROVED:ops-rt", "alice");
    expect(decided, `the list's own value was refused: ${JSON.stringify(decided)}`).toMatchObject({ ok: true });

    // And the other side of the boundary. The scheduler finds its decision with
    // `WHERE scheduled_at = ?` over `reminders.next_fire_at`, which is this
    // column's shape — so a row stored in any other shape is a decision the
    // route reported and the daemon will never see.
    const stored = store
      .prepare(`SELECT scheduled_at FROM overdue_decisions WHERE reminder_id = ?`)
      .get(id) as { scheduled_at: string };
    const key = store
      .prepare(`SELECT key FROM scheduler_health WHERE key LIKE ?`)
      .get(`${HOLD}${id}:%`) as { key: string };
    expect(
      stored.scheduled_at,
      "the row the route wrote and the slot the scheduler is holding are different strings",
    ).toBe(key.key.slice(`${HOLD}${id}:`.length));
  });

  test("a decision outside the two is refused", () => {
    const r = recordOverdueDecision(uniq("bad"), "2026-07-14 09:00:00", "maybe" as never, "APPROVED:x", "alice");
    expect({ ok: r.ok, code: (r as { code?: string }).code }).toEqual({
      ok: false,
      code: "INVALID_DECISION",
    });
  });

  test("an approval reference without the prefix is refused", () => {
    const r = recordOverdueDecision(uniq("noprefix"), "2026-07-14 09:00:00", "replay", "ops-2", "alice");
    expect({ ok: r.ok, code: (r as { code?: string }).code }).toEqual({
      ok: false,
      code: "EMPTY_APPROVAL_REF",
    });
  });

  test("an approval reference with nothing after the prefix is refused", () => {
    // The one that reads as an answer and is not: `APPROVED:` alone is a
    // decision whose justification nobody can read back.
    const r = recordOverdueDecision(uniq("empty"), "2026-07-14 09:00:00", "replay", "APPROVED:   ", "alice");
    expect({ ok: r.ok, code: (r as { code?: string }).code }).toEqual({
      ok: false,
      code: "EMPTY_APPROVAL_REF",
    });
  });

  test("deciding a slot nobody is holding is refused rather than recorded", () => {
    const id = uniq("nohold");
    const r = recordOverdueDecision(id, "2026-07-14 09:00:00", "replay", "APPROVED:ops-3", "alice");
    expect({ ok: r.ok, code: (r as { code?: string }).code }).toEqual({
      ok: false,
      code: "NO_SUCH_HOLD",
    });
    // And nothing was written, which is the half a status code does not say.
    expect(listOverdueDecisions().filter((d) => d.reminder_id === id)).toEqual([]);
  });

  test("a decision is recorded with its decider, and a second one replaces it", () => {
    const id = uniq("twice");
    reminder(id, "agent-d", "active");
    hold(id, "2026-07-14 09:00:00", "2026-07-14 09:30:00");

    const first = recordOverdueDecision(id, "2026-07-14 09:00:00", "replay", "APPROVED:ops-4", "alice");
    expect(first).toMatchObject({
      ok: true,
      reminder_id: id,
      scheduled_at: "2026-07-14T09:00:00.000Z",
      decision: "replay",
      approval_ref: "APPROVED:ops-4",
      decided_by: "alice",
    });

    // Keyed on the slot, so the operator who changes their mind overwrites one
    // row rather than leaving two answers to one fire.
    recordOverdueDecision(id, "2026-07-14 09:00:00", "skip", "APPROVED:ops-5", "bob");
    const rows = listOverdueDecisions().filter((d) => d.reminder_id === id);
    expect(rows.length).toBe(1);
    expect({ decision: rows[0]!.decision, by: rows[0]!.decided_by, ref: rows[0]!.approval_ref }).toEqual({
      decision: "skip",
      by: "bob",
      ref: "APPROVED:ops-5",
    });
  });

  test("a row written before the decider column reads as null, not as somebody", () => {
    // Not backfilled: naming anybody would put a person against a decision they
    // did not make.
    const id = uniq("legacy");
    store
      .prepare(
        `INSERT INTO overdue_decisions (reminder_id, scheduled_at, decision, approval_ref, decided_at)
         VALUES (?, '2026-07-14 09:00:00', 'replay', 'APPROVED:ops-6', '2026-07-14 10:00:00')`,
      )
      .run(id);

    const [row] = listOverdueDecisions().filter((d) => d.reminder_id === id);
    expect({ by: row?.decided_by, at: row?.decided_at }).toEqual({
      by: null,
      at: "2026-07-14T10:00:00.000Z",
    });
  });

  test("the listing stops at its limit", () => {
    expect(listOverdueDecisions(1).length).toBe(1);
  });
});

describe("a state directory the scheduler has never touched", () => {
  test("answers empty, because nothing scheduled does mean nothing held", () => {
    // `create: false` threw `SQLITE_CANTOPEN` here, which the route turned into
    // a 500 on the one screen whose job is to say whether anything is waiting.
    // Narrow on purpose: only absence answers empty, and a file that exists and
    // cannot be read still throws.
    const empty = mkdtempSync(join(tmpdir(), "ro-nostore-"));
    const was = process.env.AGENT_MESH_STATE_DIR;
    process.env.AGENT_MESH_STATE_DIR = empty;
    try {
      expect({ held: listHeldOverdue(), decided: listOverdueDecisions() }).toEqual({
        held: [],
        decided: [],
      });
      const r = recordOverdueDecision("r-1", "2026-07-14 09:00:00", "replay", "APPROVED:ops-7", "alice");
      expect((r as { code?: string }).code).toBe("NO_SUCH_HOLD");
    } finally {
      if (was === undefined) delete process.env.AGENT_MESH_STATE_DIR;
      else process.env.AGENT_MESH_STATE_DIR = was;
    }
  });
});

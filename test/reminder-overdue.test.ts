/**
 * The overdue decision, end to end (SPEC § 3.3, D-810).
 *
 * `ReminderScheduler` has held overdue `once` reminders since the hold landed,
 * and `recordOverdueDecision` has been able to release them for just as long.
 * Nothing called it: the daemon has no HTTP surface, so a held reminder waited
 * with no way to release it short of editing SQLite — and a held reminder is
 * silent, so "nothing is held" and "something is held and nobody can see it"
 * were one view.
 *
 * **The hold key's format is read out of the scheduler's source, not repeated
 * here.** The route reports what the daemon recorded, keyed on
 * `overdue_hold:<id>:<slot>` in `scheduler_health`. This file seeds that row
 * rather than driving `ReminderScheduler` — `test/tsconfig.json` says why:
 * listing a file that imports from `packages/` costs this project everything
 * that file imports, one `TS6307` at a time.
 *
 * So the fixture is a second copy of a format, which is the shape that has been
 * wrong four times today. The first test pins it against the source that writes
 * it, so the copy cannot drift in silence; what the scheduler *does* with a
 * decision — replay fires once, skip never does — is covered where the
 * scheduler lives, in `packages/self-reminder/src/scheduler.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { connectRpc, loginAsAdmin, newKeyPair, openTestDb, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let admin: string;
const LANE = "lane-a";
let lane: ReturnType<typeof newKeyPair>;

const dbPath = () => join(mesh.stateDir, "self-reminder.db");

const HOLD_PREFIX = "overdue_hold:";

/**
 * Make the hub create and migrate `self-reminder.db`.
 *
 * The file does not exist until somebody schedules something — the hub opens
 * and migrates it on the first `mesh.schedule_reminder` — so a test that writes
 * to it directly has to bring it into being the way production does. Building
 * the tables here instead would be a fourth copy of a schema that has already
 * drifted twice today.
 */
const ensureStore = async (): Promise<void> => {
  const rpc = await connectRpc(mesh.hub, { kid: lane.fingerprint, privateKey: lane.privateKey });
  const connected = await rpc.call("mesh.connect", { identity: LANE });
  expect(connected.error, `connect refused: ${JSON.stringify(connected.error)}`).toBeUndefined();
  const res = await rpc.call("mesh.schedule_reminder", {
    id: `boot-${Bun.randomUUIDv7().slice(0, 8)}`,
    type: "once",
    schedule_spec: JSON.stringify({ at: "2030-01-01T00:00:00.000Z" }),
    payload: "store bootstrap",
    next_fire_at: "2030-01-01 00:00:00",
  });
  rpc.close();
  expect(res.error, `scheduling refused: ${JSON.stringify(res.error)}`).toBeUndefined();
};

/** A held slot, written the way the scheduler writes one. */
const holdIt = (id: string, slot: string, payload: string, heldAt: string): void => {
  const db = openTestDb(dbPath(), { readwrite: true });
  db.prepare(
    `INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, status, next_fire_at, created_by)
     VALUES (?, 'lane-a', 'once', '{}', ?, 'active', ?, 'lane-a')`,
  ).run(id, payload, slot);
  db.prepare(
    `INSERT INTO scheduler_health (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`${HOLD_PREFIX}${id}:${slot}`, heldAt, heldAt);
  db.close();
};

const held = async (): Promise<{ reminders: any[]; decisions: any[] }> => {
  const res = await fetch(`${mesh.http.url}/api/v1/admin/reminders/overdue`, { headers: { cookie: admin } });
  expect(res.status, `the held list was refused: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as { reminders: any[]; decisions: any[] };
};

const decide = (id: string, body: Record<string, unknown>) =>
  fetch(`${mesh.http.url}/api/v1/admin/reminders/overdue/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  mesh = await startMesh();
  admin = await loginAsAdmin(mesh.http);
  lane = newKeyPair();
  await provision(mesh.hub, LANE, "ai-claude", null, lane.publicKey);
  await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin },
    body: JSON.stringify({ fingerprint: lane.fingerprint }),
  });
});

afterAll(async () => {
  await mesh?.stop();
});

describe("what an operator can do about a held reminder", () => {
  test("[T-053] a deployment that has scheduled nothing answers empty, not an error", async () => {
    // **Before anything creates the store.** The hub makes
    // `self-reminder.db` on the first `mesh.schedule_reminder`, so on a fresh
    // deployment the file is absent — and *nothing has ever been scheduled*
    // does mean *nothing is held*. Opening `create: false` threw
    // `SQLITE_CANTOPEN`, which the route would have served as a 500 on the one
    // screen whose job is to say whether anything is waiting.
    //
    // This test runs first on purpose: once any other test schedules, the file
    // exists and this case is unreachable for the rest of the file.
    const { reminders, decisions } = await held();
    expect(reminders, "a fresh deployment reported something held").toEqual([]);
    expect(decisions).toEqual([]);
  });

  test("[T-053] the hold key this file writes is the one the scheduler writes", async () => {
    // **The seam.** The route parses `overdue_hold:<id>:<slot>` and the
    // scheduler composes it; between them sits this fixture, which composes it
    // a third time. A format agreed on by two copies and checked against
    // neither is how a screen shows an empty list while the mesh is holding
    // something.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../packages/self-reminder/src/scheduler.ts", import.meta.url).pathname,
      "utf8",
    );
    // The template the scheduler builds, verbatim.
    expect(
      source.includes("`overdue_hold:${reminder.id}:${reminder.next_fire_at}`"),
      "the scheduler composes the hold key differently now, so this file's fixture is wrong",
    ).toBe(true);
    expect(source, "the hold is no longer recorded in scheduler_health").toContain("this.putState(holdKey");
  });

  test("[T-053] ⓐ a held slot is visible, and it was silent before", async () => {
    await ensureStore();
    const slot = "2026-07-14 09:00:00";
    holdIt("r-visible", slot, "the original body", "2026-07-14 10:00:00");

    const { reminders } = await held();
    const row = reminders.find((r) => r.reminder_id === "r-visible");
    expect(row, `the held slot is not listed: ${JSON.stringify(reminders)}`).toBeDefined();
    expect(row.scheduled_at, "the slot is not ISO-8601").toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.agent_id, "the listing does not say whose reminder it is").toBe("lane-a");
    // An hour late, which is what the operator is deciding about.
    expect(row.overdue_ms, "how late it was is not reported").toBe(3_600_000);
    console.log(`[T-053] held: ${row.reminder_id} @ ${row.scheduled_at} · overdue_ms=${row.overdue_ms}`);
  });

  test("[T-053] ⓓ an approval reference with nothing in it is refused", async () => {
    await ensureStore();
    const slot = "2026-07-14 09:00:00";
    holdIt("r-refuse", slot, "body", "2026-07-14 10:00:00");

    // D-810: substance required, format free. `APPROVED:x` is valid — the value
    // is in the string being drawn beside the decision forever, not its shape.
    for (const ref of ["APPROVED:", "APPROVED:   ", "ops-12"]) {
      const res = await decide("r-refuse", { scheduled_at: slot, decision: "skip", approval_ref: ref });
      expect(res.status, `"${ref}" was accepted`).toBe(400);
    }
    const ok = await decide("r-refuse", { scheduled_at: slot, decision: "skip", approval_ref: "APPROVED:x" });
    expect(ok.status, "a short but real reference was refused").toBe(200);
  });

  test("[T-053] a decision on a slot nobody is holding is refused, not recorded", async () => {
    // Answering `ok` here would tell an operator a reminder was released when
    // the scheduler will never read the row.
    const res = await decide("r-visible", {
      scheduled_at: "2026-01-01T00:00:00.000Z",
      decision: "replay",
      approval_ref: "APPROVED:ops-1",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("NO_SUCH_HOLD");
  });

  test("[T-053] ⓑⓒ a decision is recorded with its reference and its decider", async () => {
    // What the route owns. That `replay` then fires once and `skip` never does
    // is the scheduler's behaviour and is asserted where the scheduler lives —
    // splitting it keeps this file from re-testing `advanceDue` through a copy
    // of its own fixtures.
    for (const [id, decision] of [
      ["r-replay", "replay"],
      ["r-skip", "skip"],
    ] as const) {
      await ensureStore();
      const slot = "2026-07-14 09:00:00";
      holdIt(id, slot, "the body as it was written", "2026-07-14 10:00:00");

      const res = await decide(id, { scheduled_at: slot, decision, approval_ref: `APPROVED:ops-${id}` });
      expect(res.status, `the ${decision} was refused: ${await res.clone().text()}`).toBe(200);
      const recorded = (await res.json()) as any;
      expect(recorded.decision).toBe(decision);
      // D-810: who decided is answered by the record, not left to a log.
      expect(recorded.decided_by, "the record does not say who decided").toBeTruthy();
      expect(recorded.decided_at, "the record does not say when").toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    const { reminders, decisions } = await held();
    for (const id of ["r-replay", "r-skip"]) {
      // ⓔ, both halves. An answered slot leaves the waiting list and its answer
      // stays visible; without both, a screen cannot tell "nobody has decided"
      // from "somebody decided and it is gone".
      expect(reminders.map((r) => r.reminder_id), `${id} is still listed as waiting`).not.toContain(id);
      const kept = decisions.find((d) => d.reminder_id === id);
      expect(kept, `${id}'s decision was not persisted`).toBeDefined();
      expect(kept.approval_ref).toBe(`APPROVED:ops-${id}`);
      expect(kept.decided_by, "the persisted decision has no decider").toBeTruthy();
    }
    console.log(`[T-053] decisions recorded: ${decisions.length}`);
  });
});

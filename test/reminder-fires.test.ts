/**
 * A reminder scheduled over the wire, fired by the real daemon, delivered to
 * its owner's socket.
 *
 * **Both sides of this seam were already green and nothing crossed it.**
 * `packages/self-reminder/src/scheduler.test.ts` drives the real scheduler with
 * an injected clock and a sender stubbed to `{status:"delivered"}` — no hub, no
 * socket. `test/reminders.test.ts`'s "a fired reminder reaches its owner"
 * schedules nothing and runs no scheduler: it connects as `self-reminder` and
 * hand-sends one message, checking the hub accepts the shape a daemon would
 * send.
 *
 * ```
 * schedule → fire     real scheduler, fake sender
 * fire → deliver      real hub, fake fire
 * ```
 *
 * The second describe's own comment names that arrangement as the reason it
 * exists — "a whole feature broken end to end, with green tests on both sides
 * of the seam" — and the fix at the time added the second side rather than
 * crossing it. agent-mesh-local-pm found this by reading both files after
 * measuring the path by hand, and after I had reported the seam closed.
 *
 * **Interval, not `once`.** A `once` reminder more than `overdueHoldMs` late is
 * held for an operator by design (`scheduler.ts:284`), so a test that let one
 * go overdue would be measuring the hold and reporting it as a failure to fire.
 */

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { connectRpc, provision, startMesh, type Mesh, type RpcClient } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

let mesh: Mesh | null = null;
let owner: RpcClient | null = null;
let daemon: ReturnType<typeof spawn> | null = null;

afterAll(() => {
  daemon?.kill();
  owner?.close();
  mesh?.stop();
});

test("a scheduled reminder is fired by the daemon and reaches its owner", async () => {
  mesh = await startMesh({ withHttp: false });
  await provision(mesh.hub, "self-reminder", "service");
  await provision(mesh.hub, "fire-owner", "service");

  owner = await connectRpc(mesh.hub);
  await owner.call("mesh.connect", { identity: "fire-owner" });

  // Due immediately and repeating, so the daemon has something to do on its
  // first scan and the hold path is not involved.
  const scheduled = await owner.call("mesh.schedule_reminder", {
    id: `rem_${"f".repeat(16)}`,
    type: "interval",
    schedule_spec: JSON.stringify({ every: "1s" }),
    payload: "the seam is crossed",
    // **ISO-8601, as § 8.5 states it.** The form that did not work: the hub
    // stored it verbatim and the scheduler compares against
    // `YYYY-MM-DD HH:MM:SS`, so it never sorted as due.
    next_fire_at: new Date(Date.now() - 1_000).toISOString(),
  });
  expect(scheduled.error).toBeUndefined();

  // Nothing has fired yet: the daemon is not running. Asserted so a push from
  // some other source cannot be read as the daemon working.
  expect({ before: owner.notifications().length }).toEqual({ before: 0 });

  daemon = spawn("bun", [join(REPO_ROOT, "packages/self-reminder/src/main.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_MESH_STATE_DIR: mesh.stateDir,
      HUB_URL: `ws://127.0.0.1:${mesh.hub.port}/ws`,
      SELF_REMINDER_POLL_MS: "200",
    },
    stdio: "pipe",
  });
  // **Read what it says.** A daemon that cannot connect, or that opened a
  // different store, prints the reason — and a test that pipes its output and
  // never looks reports "nothing arrived" instead.
  const said: string[] = [];
  daemon.stdout?.on("data", (b) => said.push(String(b)));
  daemon.stderr?.on("data", (b) => said.push(String(b)));

  const deadline = Date.now() + 30_000;
  let delivered: any;
  while (Date.now() < deadline) {
    delivered = owner
      .notifications()
      .find((n) => JSON.stringify(n).includes("the seam is crossed"));
    if (delivered) break;
    await Bun.sleep(100);
  }

  expect({ arrived: Boolean(delivered), said: said.join("").slice(-1200) })
    .toMatchObject({ arrived: true });
  // From the daemon's own identity, not from the owner: § 8.2 refuses proxying
  // an identity that holds its own key, and a fired reminder is sent *by* the
  // scheduler rather than on the owner's behalf.
  expect(JSON.stringify(delivered)).toContain("self-reminder");
}, 120_000);

/**
 * A reminder waiting on a person, told apart from one waiting on its time.
 *
 * A `once` reminder more than `overdueHoldMs` late is held for an operator
 * decision and **its row stays `active`**, with `next_fire_at` receding further
 * into the past on every scan. So `mesh.list_reminders` showed the same thing
 * for one about to fire and one that never will, and the caller had no way to
 * ask — the shape this repository has spent the week taking out of screens,
 * living in an RPC response.
 *
 * agent-mesh-local-pm asked for both directions, and the reverse is the half
 * that matters: a field that always says *held* passes the first assertion.
 */
test("list_reminders tells a held reminder from a scheduled one", async () => {
  const own = await startMesh({ withHttp: false });
  let client: RpcClient | null = null;
  let proc: ReturnType<typeof spawn> | null = null;
  try {
    await provision(own.hub, "self-reminder", "service");
    await provision(own.hub, "hold-owner", "service");
    client = await connectRpc(own.hub);
    await client.call("mesh.connect", { identity: "hold-owner" });

    // Late enough to be overdue once the hold is a millisecond.
    await client.call("mesh.schedule_reminder", {
      id: `rem_${"a".repeat(16)}`,
      type: "once",
      schedule_spec: JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString() }),
      payload: "waiting on a person",
      next_fire_at: new Date(Date.now() - 60_000).toISOString(),
    });
    // Repeating, so it is never held — the other side of the comparison.
    await client.call("mesh.schedule_reminder", {
      id: `rem_${"b".repeat(16)}`,
      type: "interval",
      schedule_spec: JSON.stringify({ every: "1h" }),
      payload: "waiting on its time",
      next_fire_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    proc = spawn("bun", [join(REPO_ROOT, "packages/self-reminder/src/main.ts")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AGENT_MESH_STATE_DIR: own.stateDir,
        HUB_URL: `ws://127.0.0.1:${own.hub.port}/ws`,
        SELF_REMINDER_POLL_MS: "200",
        SELF_REMINDER_OVERDUE_HOLD_MS: "1",
      },
      stdio: "pipe",
    });
    const said: string[] = [];
    proc.stdout?.on("data", (b) => said.push(String(b)));
    proc.stderr?.on("data", (b) => said.push(String(b)));

    const deadline = Date.now() + 30_000;
    let rows: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      rows = (await client.call("mesh.list_reminders", { status: "all" })).result.rows;
      if (rows.some((r) => r.held_since)) break;
      await Bun.sleep(150);
    }

    const held = rows.find((r) => r.payload === "waiting on a person");
    const scheduled = rows.find((r) => r.payload === "waiting on its time");
    expect({ found: Boolean(held && scheduled), said: said.join("").slice(-800) })
      .toMatchObject({ found: true });

    expect({ heldMarked: typeof held!.held_since === "string" }).toEqual({ heldMarked: true });
    // Both are still `active`; without the field they are indistinguishable.
    expect({ status: held!.status }).toEqual({ status: "active" });
    expect({ scheduledMarked: "held_since" in scheduled! }).toEqual({ scheduledMarked: false });
  } finally {
    proc?.kill();
    client?.close();
    own.stop();
  }
}, 120_000);

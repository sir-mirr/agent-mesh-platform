/**
 * The three complaints, rehearsed against a stack that was just started
 * (T-022 § 3).
 *
 * A drill run as a unit test proves the line is written. It does not prove the
 * thing § 3 asks for, which is that **somebody holding only a complaint and a
 * journal reaches the cause that was actually planted** — no reproduction, no
 * questions back to the person. That needs a real hub and a real http server,
 * a cause planted in one of them, and an answer read out of what they printed.
 *
 * So each drill below plants exactly one cause and then reads the services'
 * output the way an operator reads `journalctl`: grep for the id, take the
 * JSON tail, and see which `event` and `reason` come back. The assertion is
 * that the reason named in the log is the reason that was planted — and, where
 * two causes produce the same complaint, that the log tells them apart.
 *
 * Run it on its own, and read it:
 *
 *     bun scripts/gate.ts "logging drills" -- bun test test/logging-drills.test.ts
 *
 * It prints each complaint, the grep, the line found, and the answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { join } from "node:path";

import { connectRpc, loginAsAdmin, openTestDb, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;

beforeAll(async () => {
  // A fresh stack, and deliberately no VAPID keys — complaint C's first cause
  // is a deployment that holds none, which is the state of a stack nobody has
  // configured for push.
  mesh = await startMesh();
});

afterAll(() => mesh?.stop());

/** The JSON tails of every line about one thing, newest last. */
function events(output: string, needle: string): Array<Record<string, any>> {
  return output
    .split("\n")
    .filter((line) => line.includes(needle) && line.includes(' {"ts":"'))
    .map((line) => JSON.parse(line.slice(line.lastIndexOf(' {"ts":"') + 1)));
}

/** What an operator would write down after reading the line. */
function answer(complaint: string, grep: string, found: Record<string, any> | undefined): string {
  const said = found
    ? `${found.event}${found.reason ? ` · ${found.reason}` : ""}`
    : "nothing — this service never saw it";
  console.log(`\n  complaint: ${complaint}\n  grep:      ${grep}\n  answer:    ${said}`);
  return said;
}

describe("complaint A — my message was never delivered", () => {
  /**
   * Two plants that produce the same complaint: the recipient was not
   * connected, and the recipient was. Telling them apart is the whole job —
   * the first is *it is waiting for them*, the second is *it reached them and
   * their client lost it*, and those are different conversations.
   */
  test("names the recipient being offline, and does not say that when they are not", async () => {
    await provision(mesh.hub, "drill-sender");
    await provision(mesh.hub, "drill-away");
    await provision(mesh.hub, "drill-here");

    const sender = await connectRpc(mesh.hub);
    await sender.call("mesh.connect", { identity: "drill-sender" });

    const queued = await sender.call("mesh.send", { to: "drill-away", content: "are you there" });
    const queuedId = queued.result.id;

    const recipient = await connectRpc(mesh.hub);
    await recipient.call("mesh.connect", { identity: "drill-here" });
    const delivered = await sender.call("mesh.send", { to: "drill-here", content: "and you" });
    const deliveredId = delivered.result.id;

    sender.close();
    recipient.close();

    const [away] = events(mesh.hub.output(), `"id":"${queuedId}"`);
    const [here] = events(mesh.hub.output(), `"id":"${deliveredId}"`);

    expect(answer("the message to drill-away never arrived", `grep '"id":"${queuedId}"'`, away))
      .toBe("send_queued · recipient_offline");
    expect(answer("the message to drill-here never arrived", `grep '"id":"${deliveredId}"'`, here))
      .toBe("send_delivered");

    // The planted cause, stated as the assertion rather than left implied.
    expect({ planted: "recipient_offline", read: away!.reason }).toEqual({
      planted: "recipient_offline",
      read: "recipient_offline",
    });
    expect(away!.actor).toBe("drill-sender");
  });
});

describe("complaint B — I cannot sign in", () => {
  /**
   * Three plants, three repairs. Before T-022 this route wrote nothing on any
   * of them, so all three answered "there is no line" and the only way on was
   * to ask the person to try again while somebody watched.
   */
  const signIn = (body: Record<string, unknown>) =>
    fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });

  test("tells a wrong password from a malformed request from a locked account", async () => {
    const before = mesh.http.output().length;

    await signIn({ username: "admin" });                       // planted: no password
    await signIn({ username: "admin", password: "wrong" });     // planted: wrong password

    // Planted: an account that has not changed its seeded password. The
    // session is real; every other route refuses it until the password moves.
    //
    // Written in rather than arrived at, because the harness clears the flag
    // at boot on purpose — every other suite would otherwise have to change
    // `admin`/`admin` itself, and then the harness would be deciding what a
    // test's first request is. So the drill puts the flag back for its own
    // question and takes it off again.
    const cookie = await loginAsAdmin(mesh.http);
    const db = openTestDb(join(mesh.stateDir, "agent-mesh.db"));
    try {
      db.prepare(`UPDATE local_users SET must_change_password = 1 WHERE username = 'admin'`).run();
      const refused = await fetch(`${mesh.http.url}/api/v1/admin/pending`, { headers: { cookie } });
      expect({ status: refused.status }).toEqual({ status: 403 });
    } finally {
      db.prepare(`UPDATE local_users SET must_change_password = 0 WHERE username = 'admin'`).run();
      db.close();
    }

    const refusals = events(mesh.http.output().slice(before), '"event":"sign_in_refused"');
    const reasons = refusals.map((e) => e.reason);

    console.log(`\n  complaint: three people cannot sign in\n  grep:      grep '"event":"sign_in_refused"'`);
    for (const r of refusals) console.log(`  answer:    ${r.actor} · ${r.reason}`);

    expect(reasons).toEqual(["missing_fields", "bad_credentials", "must_change_password"]);
    // Every one of them names who, which is what makes three lines three
    // people rather than three attempts by nobody in particular.
    expect(refusals.every((e) => typeof e.actor === "string" && e.actor.length > 0)).toBe(true);
    expect(refusals.every((e) => e.level === "warn")).toBe(true);
  });

  test("a sign-in that works leaves no refusal behind it", async () => {
    const before = mesh.http.output().length;
    const cookie = await loginAsAdmin(mesh.http);
    expect(cookie).toContain("mesh_token=");
    expect(events(mesh.http.output().slice(before), '"event":"sign_in_refused"')).toEqual([]);
  });
});

describe("complaint C — I got no notification", () => {
  /**
   * The planted cause is the one a fresh deployment has: no VAPID keys, so
   * nothing can be sent to anybody. It is indistinguishable from every other
   * reason a notification did not arrive — a person already reading the
   * conversation, nobody with a device registered, a push service refusing —
   * unless the line says which, and until T-022 three of those four said
   * nothing at all.
   */
  test("names the deployment holding no push keys", async () => {
    const before = mesh.http.output().length;

    await provision(mesh.hub, "drill-notifier");
    const notifier = await connectRpc(mesh.hub);
    await notifier.call("mesh.connect", { identity: "drill-notifier" });
    // `admin` is a person: the http server provisions its web users as mesh
    // identities at boot and proxies for them, so this lands on its socket and
    // runs the notification path.
    const sent = await notifier.call("mesh.send", { to: "admin", content: "a message for a person" });
    notifier.close();

    // The frame has to cross a process boundary before the push path runs.
    const deadline = Date.now() + 5_000;
    let skipped: Array<Record<string, any>> = [];
    while (Date.now() < deadline) {
      skipped = events(mesh.http.output().slice(before), '"event":"push_skipped"');
      if (skipped.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(
      answer(
        `admin got no notification for ${sent.result.id}`,
        `grep '"event":"push_skipped"'`,
        skipped[0],
      ),
    ).toBe("push_skipped · not_configured");
    expect({ planted: "not_configured", read: skipped[0]?.reason }).toEqual({
      planted: "not_configured",
      read: "not_configured",
    });
    expect(skipped[0]!.actor).toBe("admin");
  }, 20_000);
});

describe("what the drill rests on", () => {
  /**
   * Both services carry the counters into the same journal, so *has this ever
   * happened* is answerable without any of the greps above. A drill that
   * proved the lines and not this would leave the question the counters exist
   * for — was the path quiet, or was nobody looking — unanswered.
   */
  test("each service stamped its counters at boot", () => {
    for (const [name, service] of [["hub", mesh.hub], ["http", mesh.http]] as const) {
      const [snapshot] = events(service.output(), '"event":"counter_snapshot"');
      expect({ name, stamped: snapshot !== undefined }).toEqual({ name, stamped: true });
      expect({ name, since: typeof snapshot!.since }).toEqual({ name, since: "string" });
      expect({ name, counts: Array.isArray(snapshot!.counts) }).toEqual({ name, counts: true });
    }
  });
});

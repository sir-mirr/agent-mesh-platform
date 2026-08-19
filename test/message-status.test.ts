/**
 * What the database says about a message the hub refused.
 *
 * **The response was honest and the record was not.** `POST /api/v1/messages`
 * writes the row before asking the hub — deliberately, because a message that
 * reaches storage and fails to route is recoverable and one that routes without
 * being stored is not — and then corrected `status` to `failed` on the
 * in-memory object it answers from. Nothing wrote that back. There was no
 * `UPDATE` of this table anywhere in the package, so the row stayed `pending`
 * for ever and the two disagreed from the moment the request returned.
 *
 * The disagreement is not cosmetic, because the record is what everything later
 * reads: the history route, the conversation view and search all serve the
 * stored value. A message that never left this machine was reported, for the
 * rest of its life, as one still waiting for its recipient.
 *
 * It is the mirror of the two delivery defects fixed alongside it. There the
 * record was more generous than the truth — `delivered` for a frame that was
 * dropped. Here the screen is more generous than the record. Both are the same
 * unanswered question, which `mailbox.test.ts` answers for the § 8.10 path:
 * what is written down is what actually happened, not what was attempted.
 *
 * Its own file and its own mesh, because the only way to make the hub refuse is
 * to take the hub away, and a suite that shares one cannot do that without
 * ending every test after it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { loginAsAdmin, openTestDb, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
});

afterAll(() => mesh?.stop());

/**
 * The web surface only offers identities its own registry lists (§ 9.1), so a
 * recipient has to exist there as well as on the mesh.
 */
function addToWebRegistry(id: string) {
  const db = openTestDb(join(mesh.stateDir, "agent-mesh.db"));
  db.prepare(
    `INSERT OR IGNORE INTO agent_registry (id, name, type, approved) VALUES (?, ?, 'agent', 1)`,
  ).run(id, id);
  db.close();
}

const send = async (to: string, text: string) => {
  const res = await fetch(`${mesh.http.url}/api/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ to, text }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** The row as stored, read straight from the file rather than through a route. */
function storedStatus(id: string): string | null {
  const db = openTestDb(join(mesh.stateDir, "agent-mesh.db"), { readonly: true });
  const row = db.prepare(`SELECT status FROM messages WHERE id = ?`).get(id) as { status: string } | null;
  db.close();
  return row?.status ?? null;
}

describe("a message the hub takes", () => {
  // **First, because the test below takes the hub away for good.**
  //
  // Without this half, a handler that wrote `failed` for every message would
  // pass the one below and be wrong about all of them. The two words have to
  // mean different things for either to mean anything, and this is the one that
  // says `pending` is still reachable.
  //
  // It also pins the vocabulary a screen is built from. A comment here claimed
  // the opposite — that a refused message stayed `pending` — for long enough
  // that agent-mesh-local-pm asked which to believe before labelling the
  // console from it. Prose can invert; this cannot.
  test("is recorded as pending, which is what makes `failed` mean something", async () => {
    expect((await provision(mesh.hub, "status-accepted", "service")).status).toBe(201);
    addToWebRegistry("status-accepted");

    const sent = await send("status-accepted", "on its way");
    expect(sent.body?.message?.status, "the hub refused a send this test needs accepted").toBe("pending");

    const id = sent.body.message.id as string;
    expect(storedStatus(id), "the row disagrees with the response it just returned").toBe("pending");

    const history = (await (
      await fetch(`${mesh.http.url}/api/v1/messages/status-accepted`, { headers: { cookie } })
    ).json()) as { messages: Array<{ id: string; status: string }> };
    expect(history.messages.find((m) => m.id === id)?.status, "the history route served something else").toBe("pending");
  }, 20_000);
});

describe("a message the hub would not take", () => {
  test("is recorded as failed, not left pending for ever", async () => {
    addToWebRegistry("status-target");

    // Taking the hub away is the only way to make `sendViaHub` refuse without
    // reaching inside the process. `stop()` is the orderly exit, so the harness
    // stays quiet about it.
    mesh.hub.stop();

    // The http server learns the socket is gone asynchronously. Poll rather
    // than sleep a guessed interval — a fixed wait is either flaky or slow, and
    // this one would be both on a loaded runner.
    let sent: Awaited<ReturnType<typeof send>> | undefined;
    for (let i = 0; i < 100; i++) {
      sent = await send("status-target", `attempt ${i}`);
      if (sent.body?.message?.status === "failed") break;
      await Bun.sleep(50);
    }

    expect(sent?.body?.message?.status, "the hub never stopped accepting, so this proves nothing")
      .toBe("failed");

    const id = sent!.body.message.id as string;
    expect(storedStatus(id), "the response said failed and the row still says otherwise")
      .toBe("failed");

    // Through the route a client actually reads, because a corrected row that
    // no reader returns is a correction nobody receives.
    const history = await (
      await fetch(`${mesh.http.url}/api/v1/messages/status-target`, { headers: { cookie } })
    ).json() as { messages: Array<{ id: string; status: string }> };
    const seen = history.messages.find((m) => m.id === id);
    expect(seen?.status, "the history route served the stale status").toBe("failed");
  }, 20_000);
});

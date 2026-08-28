/**
 * Which table answers "is this identity a thing" (T-054).
 *
 * There are two, on one namespace. `agent_registry` is the http server's own
 * list — who the console may address — and the hub's `agents` is where the mesh
 * records provisioning, presence and teardown. `GET /api/v1/agents` drives its
 * rows from the first and joins the second for `last_seen_at`, `tenant` and
 * `fingerprint`.
 *
 * **Written before deciding which is canonical, and that is the order.** Naming
 * a canon first would make this file a restatement of the decision; written
 * first, it can contradict it. Every test below asserts what the routes do
 * today, and each says plainly whether what it pins is a property worth keeping
 * or a disagreement worth deciding — because a test that pins a defect without
 * saying so is how a defect becomes a requirement.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loginAsAdmin, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let admin: string;

const listed = async (): Promise<Map<string, Record<string, any>>> => {
  const res = await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie: admin } });
  expect(res.status, `listing refused: ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as { agents?: Record<string, any>[] } | Record<string, any>[];
  const rows = Array.isArray(body) ? body : (body.agents ?? []);
  return new Map(rows.map((row) => [String(row.id), row]));
};

/** The hub's own answer about an identity, which is a different table. */
const onHub = async (identity: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${mesh.hub.url}/api/v1/agents/${encodeURIComponent(identity)}/keys`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

const approveKey = async (fingerprint: string) =>
  fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin },
    body: JSON.stringify({ fingerprint }),
  });

const teardown = async (identity: string) =>
  fetch(`${mesh.http.url}/api/v1/admin/agents/${encodeURIComponent(identity)}`, {
    method: "DELETE",
    headers: { cookie: admin },
  });

beforeAll(async () => {
  mesh = await startMesh();
  admin = await loginAsAdmin(mesh.http);
});

afterAll(async () => {
  await mesh?.stop();
});

describe("the two registries, on one namespace", () => {
  test("provisioning on the hub alone does not put a row in the console's list", async () => {
    // **A property, not a defect.** § 9.1 is explicit that which rows exist is
    // `agent_registry`'s answer: the console decides who its users may address,
    // and an identity the mesh knows about is not automatically one of them.
    // Pinned because it is the half that makes the *next* test meaningful.
    const identity = `canon-hub-only-${Bun.randomUUIDv7().slice(0, 8)}`;
    const created = await provision(mesh.hub, identity, "ai-claude");
    expect(created.status, `provisioning refused: ${await created.clone().text()}`).toBe(201);

    expect((await onHub(identity)).status, "the hub does not know the identity it just created").toBe(200);
    expect([...(await listed()).keys()], "a hub-only identity reached the console list").not.toContain(identity);
  });

  test("approving its key admits it, so the two agree from then on", async () => {
    // D-747. The operator compared a fingerprint and decided this identity is
    // one the console deals with, and that decision is what writes the row.
    const identity = `canon-admitted-${Bun.randomUUIDv7().slice(0, 8)}`;
    const created = await provision(mesh.hub, identity, "ai-claude");
    expect(created.status).toBe(201);

    const keys = (await onHub(identity)).body as { keys?: Array<{ fingerprint: string }> };
    const fingerprint = keys?.keys?.[0]?.fingerprint;
    expect(fingerprint, `the hub holds no key to approve: ${JSON.stringify(keys)}`).toBeTruthy();

    const approved = await approveKey(fingerprint!);
    expect(approved.status, `approval refused: ${await approved.clone().text()}`).toBe(200);

    const row = (await listed()).get(identity);
    expect(row, "approving the key did not admit the identity").toBeDefined();
    expect(row!.fingerprint, "the approved fingerprint did not join").toBe(fingerprint);

    // **[T-054] `last_seen_at` is not a sighting.** This identity has never
    // opened a socket, and the route reports a timestamp for it — because
    // `stmtInsertAgentIfAbsent` writes `last_seen = datetime('now')` at
    // provisioning (`packages/hub/src/db.ts:190`). So a non-null value here
    // means "the row exists", not "the mesh saw it".
    //
    // That is I-062 in a new field. The console drew every agent as `ONLINE`
    // until this route started carrying presence; a screen reading this value
    // now draws a never-connected agent as seen seconds ago, which is the same
    // false liveness arriving through the field that was meant to end it.
    // § 9.1 and the contract both fix what `null` means and neither says what a
    // value means, so nothing was contradicted — it was never stated.
    //
    // Pinned as it is, and named as a defect rather than a property, so the
    // decision moves it deliberately.
    console.log(`[T-054] never-connected identity reports last_seen_at=${JSON.stringify(row!.last_seen_at)}`);
    expect(row!.last_seen_at, "a never-connected identity reported no presence — the defect is fixed").not.toBeNull();
  });

  test("[T-054] and the timestamp it reports is not the format the others are", async () => {
    // The same value again, on a second axis. `last_seen` is a SQLite
    // `datetime('now')` string — `YYYY-MM-DD HH:MM:SS`, a space and no zone —
    // while every other timestamp this API sends is ISO-8601 with `T` and `Z`.
    // `new Date("2026-08-28 11:53:05")` is not portable: engines differ on
    // whether it parses at all, and the ones that do read it as local time, so
    // the same row renders hours apart in two browsers.
    const identity = `canon-stamp-${Bun.randomUUIDv7().slice(0, 8)}`;
    await provision(mesh.hub, identity, "ai-claude");
    const keys = (await onHub(identity)).body as { keys?: Array<{ fingerprint: string }> };
    await approveKey(keys!.keys![0]!.fingerprint);

    const row = (await listed()).get(identity)!;
    expect(row, "the identity was not admitted, so no timestamp was read").toBeDefined();
    const stamp = String(row.last_seen_at);
    console.log(`[T-054] last_seen_at=${JSON.stringify(stamp)} · created_at=${JSON.stringify(row.created_at)}`);

    // Today's shape, pinned. Both halves asserted: the value is a timestamp
    // (so this is not passing on an empty string) and it is not ISO-8601.
    expect(stamp, "not a timestamp at all").toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(stamp.includes("T"), "`last_seen_at` became ISO-8601 — the defect is fixed").toBe(false);
  });

  test("[T-054] what teardown leaves behind, in each of the two", async () => {
    // **The disagreement this task exists to settle.** § 9.3 is irreversible:
    // the hub soft-deletes and the name is never usable again. What the console
    // list does with the row it already has is the open half — and whichever way
    // it goes, the two tables now answer differently about the same identity.
    //
    // Measured rather than asserted, and the numbers are printed, because the
    // decision is about which of these two answers is the one an operator is
    // owed.
    const identity = `canon-torn-${Bun.randomUUIDv7().slice(0, 8)}`;
    const created = await provision(mesh.hub, identity, "ai-claude");
    expect(created.status).toBe(201);
    const keys = (await onHub(identity)).body as { keys?: Array<{ fingerprint: string }> };
    await approveKey(keys!.keys![0]!.fingerprint);
    expect([...(await listed()).keys()], "the identity was never admitted, so teardown proves nothing")
      .toContain(identity);

    const gone = await teardown(identity);
    expect(gone.status, `teardown refused: ${await gone.clone().text()}`).toBe(200);
    const answer = (await gone.json()) as { ok: boolean; action: string };
    expect(answer.action).toBe("soft-deleted");

    const after = (await listed()).get(identity);
    console.log(
      `[T-054] after teardown — console list: ${after ? "still listed" : "gone"}` +
        (after ? ` (last_seen_at=${JSON.stringify(after.last_seen_at)}, fingerprint=${JSON.stringify(after.fingerprint)})` : ""),
    );

    // Today's answer, pinned so the decision moves it deliberately. A row that
    // survives teardown is not merely stale: the presence join excludes
    // soft-deleted identities, so it comes back with `last_seen_at: null` — the
    // same shape as a healthy identity that has never connected. The console
    // cannot tell a torn-down agent from a new one by looking.
    expect(after, "teardown left no row — the list and the hub agree").toBeDefined();
    expect(after!.last_seen_at, "a torn-down identity is drawn as never-seen, not as deleted").toBeNull();
    expect(
      "deleted" in after! || "deleted_at" in after!,
      "the row carries nothing that says it was torn down",
    ).toBe(false);
  });

  test("[T-054] and the hub says the name is taken, so the two cannot both be right", async () => {
    // The other side of the same identity. § 9.3 refuses re-provisioning with
    // `409 IDENTITY_DELETED`, so the hub's answer is "this name is spent" while
    // the console's list still offers it as an addressee. One of the two is what
    // an operator acts on, and this is the pair of facts the decision picks
    // between.
    const identity = `canon-retake-${Bun.randomUUIDv7().slice(0, 8)}`;
    await provision(mesh.hub, identity, "ai-claude");
    const keys = (await onHub(identity)).body as { keys?: Array<{ fingerprint: string }> };
    await approveKey(keys!.keys![0]!.fingerprint);
    await teardown(identity);

    const again = await provision(mesh.hub, identity, "ai-claude");
    const body = await again.text();
    console.log(`[T-054] re-provisioning a torn-down name: ${again.status} ${body.slice(0, 120)}`);
    expect(again.status, "a torn-down name was handed out again").toBe(409);

    expect([...(await listed()).keys()], "the console offers a name the hub will never issue again")
      .toContain(identity);
  });
});

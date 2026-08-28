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

import { connectRpc, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh } from "./harness";

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

    // **[T-054/D-809] `last_seen_at` is a sighting now, and only that.** It
    // used to be stamped at provisioning (`stmtUpsertAgentTyped`), so this
    // identity — which has never opened a socket — came back with a timestamp
    // equal to its `created_at` to the second. That was I-062 arriving through
    // the field added to end it: the console drew every agent ONLINE until this
    // route carried presence, and then drew a never-connected agent as seen
    // moments ago.
    //
    // Nothing had been contradicted. § 9.1 and the contract both fixed what
    // `null` means and neither said what a value means, so the meaning was
    // never stated — which is why D-809's prescription is a sentence in SPEC as
    // well as a change here.
    console.log(`[T-054] never-connected identity reports last_seen_at=${JSON.stringify(row!.last_seen_at)}`);
    expect(row!.last_seen_at, "a never-connected identity reported a sighting").toBeNull();
  });

  test("[T-054] a sighting is still recorded once the identity connects", async () => {
    // **The other direction, and the whole reason the test above is not enough.**
    // A route that answered `null` for everybody would satisfy it, and would be
    // a worse defect than the one being fixed: `null` would then mean nothing
    // at all rather than "not seen". Provisioning stopped stamping; connecting
    // must still stamp.
    const identity = `canon-seen-${Bun.randomUUIDv7().slice(0, 8)}`;
    const pair = newKeyPair();
    const created = await provision(mesh.hub, identity, "ai-claude", null, pair.publicKey);
    expect(created.status).toBe(201);
    await approveKey(pair.fingerprint);

    expect((await listed()).get(identity)!.last_seen_at, "seen before connecting").toBeNull();

    const rpc = await connectRpc(mesh.hub, { kid: pair.fingerprint, privateKey: pair.privateKey });
    const res = await rpc.call("mesh.connect", { identity });
    expect(res.error, `connect refused: ${JSON.stringify(res.error)}`).toBeUndefined();
    rpc.close();

    const seen = (await listed()).get(identity)!.last_seen_at;
    console.log(`[T-054] after connecting, last_seen_at=${JSON.stringify(seen)}`);
    expect(seen, "connecting did not record a sighting").not.toBeNull();
    expect(String(seen), "the sighting is not ISO-8601").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("[T-054] the timestamps it reports are ISO-8601", async () => {
    // `last_seen` and `created_at` are SQLite `datetime('now')` strings —
    // `YYYY-MM-DD HH:MM:SS`, a space and no zone — and this route used to pass
    // them through. `new Date("2026-08-28 11:53:05")` is not portable: engines
    // differ on whether it parses, and the ones that accept it read it as local
    // time, so one row rendered hours apart in two browsers.
    //
    // The column keeps its format. A storage format is not a wire format, which
    // is the rule `recorded_by` settled under.
    const identity = `canon-stamp-${Bun.randomUUIDv7().slice(0, 8)}`;
    await provision(mesh.hub, identity, "ai-claude");
    const keys = (await onHub(identity)).body as { keys?: Array<{ fingerprint: string }> };
    await approveKey(keys!.keys![0]!.fingerprint);

    const row = (await listed()).get(identity)!;
    expect(row, "the identity was not admitted, so no timestamp was read").toBeDefined();
    const stamp = String(row.created_at);
    console.log(`[T-054] created_at=${JSON.stringify(row.created_at)} · last_seen_at=${JSON.stringify(row.last_seen_at)}`);

    // Both halves: it is a timestamp at all, and it is ISO. Asserting only the
    // pattern would pass on an empty string under a looser regexp.
    expect(stamp, "not a timestamp at all").toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(stamp, "created_at is not ISO-8601").toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(new Date(stamp).getTime()), "the value does not parse as a date").toBe(false);
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
        (after
          ? ` (deleted_at=${JSON.stringify(after.deleted_at)}, last_seen_at=${JSON.stringify(after.last_seen_at)})`
          : ""),
    );

    // **D-809: the row stays and says so.** A row that vanished would leave a
    // later reader unable to tell a teardown from a name that never existed —
    // the same reason § 9.2c keeps a deactivated account. What was wrong was
    // not that it stayed: it was that it stayed *silent*, coming back with
    // `last_seen_at: null` and nothing else, the same shape as a healthy
    // identity that has never connected.
    //
    // Which screen shows it is a separate question, and deliberately not this
    // route's: one answering *who can I address* drops these rows, one
    // answering *what happened to this name* keeps them. The route's job is to
    // make both answerable, which means saying it rather than implying it.
    expect(after, "teardown removed the row, so nothing can say it was torn down").toBeDefined();
    expect(after!.deleted_at, "a torn-down identity carries no deleted_at").not.toBeNull();
    expect(String(after!.deleted_at), "deleted_at is not ISO-8601")
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    // Still null, and now that is unambiguous: the mesh is not seeing it.
    expect(after!.last_seen_at, "a torn-down identity reported a sighting").toBeNull();
  });

  test("[T-054] a live identity says it is not torn down, so the field is read and not assumed", async () => {
    // The negative half. `deleted_at` that were always non-null would satisfy
    // the assertion above, and a consumer branching on it would mark every
    // agent deleted. Asserted on a fresh identity rather than on whatever the
    // list happens to hold.
    const identity = `canon-live-${Bun.randomUUIDv7().slice(0, 8)}`;
    await provision(mesh.hub, identity, "ai-claude");
    const keys = (await onHub(identity)).body as { keys?: Array<{ fingerprint: string }> };
    await approveKey(keys!.keys![0]!.fingerprint);

    const row = (await listed()).get(identity)!;
    expect(row, "the identity was not admitted").toBeDefined();
    expect("deleted_at" in row, "the field is absent, so a reader cannot tell absence from live").toBe(true);
    expect(row.deleted_at, "a live identity is marked torn down").toBeNull();
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

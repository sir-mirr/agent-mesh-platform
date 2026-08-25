/**
 * The fixture every front-end scenario trusts, checked against the routes.
 *
 * `scripts/fixtures/fe-screens.ts` seeds two screens that cannot be judged on
 * an empty mesh and writes what they must show to a file. Everything that
 * checks a screen reads that file, which makes it the one place in this
 * repository where being wrong is invisible: a checker compares a screen
 * against the fixture's own claim, so a fixture that reports what it *intended*
 * to create passes every scenario built on it.
 *
 * So nothing here reads that file for its own sake. The numbers in it are
 * compared against what the admin routes answer, from a session this test
 * obtained itself, on a mesh seeded with one extra pending key the fixture did
 * not create — which is what separates "read the backend" from "reported its
 * own variable".
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loginAsAdmin, newKeyPair, provision, SEED_ADMIN, startMesh, type Mesh } from "./harness";

const FIXTURE = resolve(import.meta.dir, "..", "scripts", "fixtures", "fe-screens.ts");

let mesh: Mesh;
let cookie: string;
let scratch: string;

/** A ready file of the shape the fixture documents, for the mesh above. */
function readyFile(): string {
  const path = join(scratch, "ready.json");
  writeFileSync(
    path,
    JSON.stringify({
      base_url: mesh.http.url,
      api_http: mesh.hub.url,
      state_dir: mesh.stateDir,
      admin_test_handle: {
        login_url: `${mesh.http.url}/auth/local`,
        method: "POST",
        content_type: "application/x-www-form-urlencoded",
        body: `username=${encodeURIComponent(SEED_ADMIN)}&password=admin`,
        login_expect_status: 302,
      },
    }),
  );
  return path;
}

interface Emitted {
  run: string;
  identities: { sender: string; recipient: string };
  expect: {
    pendingKeys: { atLeast: number; mine: number };
    queuedFor: { identity: string; exactly: number };
    tenants: { atLeast: number; includes: string };
  };
  observed: { pendingTotal: number; queuedForRecipient: number | null; tenants: unknown[] };
}

/** Runs the fixture once and returns what it wrote. */
async function seed(label: string): Promise<Emitted> {
  const emit = join(scratch, `expect-${label}.json`);
  const proc = Bun.spawn(["bun", FIXTURE, "--ready-file", readyFile(), "--emit", emit], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`the fixture exited ${code}\n${out}\n${err}`);
  return JSON.parse(readFileSync(emit, "utf8")) as Emitted;
}

const adminJson = async (path: string) =>
  (await fetch(`${mesh.http.url}${path}`, { headers: { cookie } })).json() as Promise<any>;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "fe-screens-"));
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);

  // A pending key of this test's own, so the fixture's share and the screen's
  // total are different numbers. Where they are equal, a fixture reporting its
  // own variable as the total is indistinguishable from one reading the route.
  await provision(mesh.hub, "outsider-pending", "ai-claude", null, newKeyPair().publicKey);
}, 60_000);

afterAll(() => mesh?.stop());

describe("what the fixture emits", () => {
  test("is what the routes say, not what it meant to create", async () => {
    const emitted = await seed("first");
    const [pending, mailbox, tenants] = await Promise.all([
      adminJson("/api/v1/admin/keys/pending"),
      adminJson("/api/v1/admin/mailbox"),
      adminJson("/api/v1/admin/tenants"),
    ]);

    // `keys`, not `pending` — D-689 renamed this body so the key queue and the
    // admission queue could be told apart. Reading the old name answers an
    // honest empty array, which is how the fixture came to certify nothing.
    const total = (pending.keys ?? []).length;
    const queued = (mailbox.mailboxes ?? []).find(
      (m: any) => (m.identity ?? m.agent) === emitted.identities.recipient,
    );
    const depth = queued?.pending ?? queued?.depth ?? null;

    expect({
      pendingTotal: emitted.observed.pendingTotal,
      queuedForRecipient: emitted.observed.queuedForRecipient,
      tenants: emitted.observed.tenants,
    }).toEqual({
      pendingTotal: total,
      queuedForRecipient: depth,
      tenants: tenants.tenants ?? [],
    });

    // The fixture's own share is smaller than the screen's total, because of
    // the key seeded above. A file whose `mine` and `pendingTotal` agree on
    // this mesh is reporting a variable.
    expect(emitted.expect.pendingKeys.mine).toBeLessThan(emitted.observed.pendingTotal);
    expect(emitted.expect.queuedFor.exactly).toBe(depth);
  }, 120_000);

  test("counts land in the range that no placeholder reaches for", async () => {
    // 0, 1, 2, 3, 5, 10, 24 and 100 are all plausible constants, so the fixture
    // stays outside them. A screen matching a number from here is not matching
    // a number somebody typed.
    const emitted = await seed("range");
    expect(emitted.expect.pendingKeys.mine).toBeGreaterThanOrEqual(6);
    expect(emitted.expect.pendingKeys.mine).toBeLessThanOrEqual(17);
    expect(emitted.expect.queuedFor.exactly).toBeGreaterThanOrEqual(11);
    expect(emitted.expect.queuedFor.exactly).toBeLessThanOrEqual(23);
  }, 120_000);

  test("a second run seeds a fresh set rather than colliding with the first", async () => {
    // The whole argument for random counts is that a screen matching them
    // twice is reading the backend. That requires two runs to differ — a fixed
    // tag would re-provision the same identities and the second run's numbers
    // would be the first run's rows.
    const first = await seed("a");
    const second = await seed("b");
    expect(second.run).not.toBe(first.run);
    expect(second.identities).not.toEqual(first.identities);
    // And the totals grow, because nothing here removes what the last run made.
    expect(second.observed.pendingTotal).toBeGreaterThan(first.observed.pendingTotal);
  }, 180_000);
});

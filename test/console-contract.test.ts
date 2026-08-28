/**
 * The recorded answers, against the routes that answer.
 *
 * `@agent-mesh/contracts` names what the console's eight read routes send, and
 * its own tests can only check that its route table and its fixtures agree —
 * that package has no server. This is the half that needs one: it boots the
 * mesh, calls each path, and compares the live body's field names against the
 * fixture's.
 *
 * **A key-set comparison, not a value comparison.** The values in a fixture are
 * invented; the field names are not. What drifts is a route dropping a field,
 * renaming one, or adding one nobody typed — and all three are visible in the
 * names alone.
 *
 * **Empty lists are counted, not tolerated.** A route that answers `[]` on a
 * fresh mesh compares no row, and a check that silently compares nothing is the
 * defect this repository has swept five times. Every route whose list came back
 * empty is named in the failure message, and a floor keeps the number of
 * comparisons from quietly falling to zero.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CONSOLE_RESPONSE_FIXTURES } from "@agent-mesh/contracts/fixtures";

import { join } from "node:path";

import { loginAsAdmin, openTestDb, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let admin: string;

/**
 * Give three of the eight something to answer with.
 *
 * A fresh mesh answers `[]` on four of the six lists, and a comparison over
 * zero rows is the shape this suite keeps finding: green, and about nothing.
 * Two of the four can be filled cheaply.
 *
 * `keys/pending` is filled through the real path — provisioning an `ai-` type
 * carries a public key, and an unapproved key is a pending proposal.
 *
 * The mailbox is filled by writing the row, because the route reads the hub's
 * `messages` table and `POST /api/v1/messages` writes the http server's own —
 * two tables of the same name in two files. Seeding through the wrong one
 * would leave this route empty while looking seeded, which is worse than
 * writing the row and saying so.
 *
 * `admin/pending` stays empty on purpose: its only writer is the GitHub
 * callback, so a deployment without GitHub credentials cannot produce one. The
 * marker below names it every run rather than leaving the gap to be inferred.
 */
async function seed(): Promise<void> {
  const proposed = await provision(mesh.hub, "lane-key-pending", "ai-claude");
  expect(proposed.status, `provisioning left no key proposal: ${await proposed.clone().text()}`).toBe(201);

  const hub = openTestDb(join(mesh.stateDir, "hub.db"), { readwrite: true });
  try {
    hub
      .prepare(
        `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
         VALUES ('m-console-contract', 'lane-a', 'lane-b', 'queued', 'pending', datetime('now'))
           ON CONFLICT(id) DO NOTHING`,
      )
      .run();
  } finally {
    hub.close();
  }
}

beforeAll(async () => {
  mesh = await startMesh();
  admin = await loginAsAdmin(mesh.http);
  await seed();
});

afterAll(() => {
  mesh?.stop();
});

/**
 * How many of the eight must actually compare something.
 *
 * Set from a measured run, not chosen: the number is whatever a fresh mesh can
 * be made to answer with a row in it. Raising it is a decision to seed more;
 * lowering it is a decision to check less, and the failure message names which
 * routes came back empty so that decision is made with the list in hand.
 */
const FLOOR = 7;

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === "object" ? Object.keys(value as object).sort() : [];

describe("what the console reads is what the server sends", () => {
  test("every fixture's field names match the live answer's", async () => {
    const rowless: string[] = [];
    let compared = 0;

    for (const fixture of CONSOLE_RESPONSE_FIXTURES) {
      const res = await fetch(`${mesh.http.url}${fixture.path}`, { headers: { cookie: admin } });
      expect(res.status, `${fixture.path} refused: ${await res.clone().text()}`).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(keysOf(body), `${fixture.path} top-level fields`).toEqual(keysOf(fixture.body));

      for (const field of fixture.neverSent) {
        expect(field in body, `${fixture.path} now sends '${field}'`).toBe(false);
      }

      if (fixture.listKey === null) {
        compared += 1;
        continue;
      }
      const live = body[fixture.listKey] as unknown[];
      expect(Array.isArray(live), `${fixture.path}.${fixture.listKey} is not an array`).toBe(true);
      if (live.length === 0) {
        rowless.push(fixture.path);
        continue;
      }
      const expected = keysOf((fixture.body[fixture.listKey] as unknown[])[0]);
      expect(keysOf(live[0]), `${fixture.path} row fields`).toEqual(expected);
      for (const field of fixture.neverSent) {
        expect(field in (live[0] as object), `a ${fixture.path} row now carries '${field}'`).toBe(false);
      }
      compared += 1;
    }

    // Printed on every run, pass or fail, in the same shape as this suite's
    // other inventory markers. A green run that says nothing is how a check
    // reaches zero comparisons without anybody noticing.
    console.log(
      `[T-051] ${compared} of ${CONSOLE_RESPONSE_FIXTURES.length} routes compared a row` +
        (rowless.length ? ` · empty: ${rowless.join(" ")}` : ""),
    );

    // The floor is what this test is worth. Below it, the run compared
    // envelopes and nothing else, and said so.
    expect(
      compared,
      `only ${compared} of ${CONSOLE_RESPONSE_FIXTURES.length} routes had anything to compare` +
        (rowless.length ? ` — empty on ${rowless.join(", ")}` : ""),
    ).toBeGreaterThanOrEqual(FLOOR);

    // **Which one is empty, not just how many.** A count alone passes when a
    // route that used to carry rows stops and another starts — and it passes
    // when the counter is moved above the empty-list check, so the floor is
    // met by routes that compared nothing. This names the one route a fresh
    // mesh cannot fill, and a second one appearing here is a seeding step that
    // stopped working rather than a smaller number to accept.
    expect(rowless).toEqual(["/api/v1/admin/pending"]);
  });
});

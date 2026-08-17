/**
 * A running instance says which checkout it is (SPEC § 7.1).
 *
 * Two investigations days apart began with "this route returns 404" and ended at
 * the same cause — a long-running hub serving a branch ninety-three commits
 * behind `main`. Neither could be diagnosed from outside; both first diagnoses
 * were wrong. This is the field that makes the question answerable in one line.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMesh, type Mesh } from "./harness";

let mesh: Mesh;
beforeAll(async () => {
  mesh = await startMesh();
});
afterAll(() => mesh?.stop());

describe("capabilities", () => {
  test("says which commit it is", async () => {
    const body = await (await fetch(`${mesh.hub.url}/api/v1/capabilities`)).json();
    expect(body.platform, "capabilities carries no provenance").toBeDefined();
    // Either a real commit or an honest `unknown` — a tarball deployment has no
    // repository to ask, and saying so is more than the nothing this replaces.
    expect(typeof body.platform.commit).toBe("string");
    expect(body.platform.commit.length).toBeGreaterThan(0);
  });

  test("is unauthenticated, like the rest of capabilities", async () => {
    // § 9.2.1 puts these values where a caller that cannot yet sign can read
    // them. Provenance is the same kind of value: most useful to somebody who
    // cannot get in and is trying to work out why.
    expect((await fetch(`${mesh.hub.url}/api/v1/capabilities`)).status).toBe(200);
  });
});

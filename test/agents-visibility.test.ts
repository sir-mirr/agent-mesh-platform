/**
 * Who `GET /api/v1/agents` shows to whom (§ 12).
 *
 * The route listed the whole registry to anyone approved — 44 identities to an
 * account holding no capabilities, the same 44 the administrator saw, measured
 * by `agent-mesh-local-pm` on the standing stack. The boundary the owner chose
 * is what you own, who shares your group, and who your agents have talked to.
 *
 * **The falsification here is two-sided, and that is the point.** The first
 * version of it was "cut the connection and the row disappears", which cannot
 * hold: `messages` is a record of what was exchanged, so a past correspondent
 * stays a past correspondent and the check would have been permanently red
 * against a correct implementation. The replacement asks both directions:
 *
 *   a stranger must not appear      — otherwise nothing is scoped
 *   a correspondent must appear     — otherwise everything is scoped, which
 *                                     also passes a one-sided check
 *
 * A check that only asserts the first is satisfied by a route that returns an
 * empty list to everybody.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { capabilityViewer, loginAsAdmin, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let admin: string;

const ids = async (cookie: string): Promise<string[]> => {
  const res = await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie } });
  expect(res.status, `listing refused: ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as { agents?: Array<{ id: string }> } | Array<{ id: string }>;
  const rows = Array.isArray(body) ? body : (body.agents ?? []);
  return rows.map((row) => row.id).sort();
};

const admit = (username: string) =>
  fetch(`${mesh.http.url}/api/v1/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin },
    body: JSON.stringify({ username, role: "member" }),
  });

beforeAll(async () => {
  mesh = await startMesh();
  admin = await loginAsAdmin(mesh.http);
});

afterAll(async () => {
  await mesh?.stop();
});

describe("the agent listing is scoped to the session", () => {
  test("a stranger is absent and a correspondent is present", async () => {
    for (const username of ["seen-by-nobody", "spoke-with-me"]) {
      const created = await admit(username);
      expect(created.status, await created.text()).toBe(201);
    }
    const viewer = await capabilityViewer(mesh);

    // Before any exchange, neither is visible — including the one about to be
    // messaged. Without this line the assertion after it could be satisfied by
    // a route that shows every admitted account.
    const before = await ids(viewer);
    expect(before, "an account was visible before anything connected it").not.toContain("spoke-with-me");
    expect(before, "a stranger is visible").not.toContain("seen-by-nobody");

    const sent = await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: viewer },
      body: JSON.stringify({ to: "spoke-with-me", text: "hello" }),
    });
    expect(sent.status, `the message the whole test depends on was not sent: ${await sent.text()}`).toBe(201);

    const after = await ids(viewer);
    expect(after, "a correspondent is missing, so the listing is scoped to nothing").toContain("spoke-with-me");
    expect(after, "a stranger appeared once an unrelated message was sent").not.toContain("seen-by-nobody");
  }, 60_000);

  test("a group puts its members in each other's list", async () => {
    const viewer = await capabilityViewer(mesh);
    const me = ((await (await fetch(`${mesh.http.url}/auth/me`, { headers: { cookie: viewer } })).json()) as {
      github_login: string;
    }).github_login;

    const created = await admit("shares-my-group");
    expect(created.status, await created.text()).toBe(201);
    expect(await ids(viewer), "they were visible before the group existed").not.toContain("shares-my-group");

    const group = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ group_id: "shared-room", description: "for the visibility check" }),
    });
    expect(group.status, await group.text()).toBeLessThan(300);
    for (const identity of [me, "shares-my-group"]) {
      const added = await fetch(`${mesh.http.url}/api/v1/admin/groups/shared-room/members`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: admin },
        body: JSON.stringify({ identity }),
      });
      expect(added.status, `adding ${identity}: ${await added.text()}`).toBeLessThan(300);
    }

    expect(await ids(viewer), "a group member is missing from the list").toContain("shares-my-group");
  }, 60_000);

  test("the administrator still sees more than a member does", async () => {
    // The scoping is only worth having if it does not scope the console away.
    // `role === 'admin'` is the temporary stand-in for a capability the
    // vocabulary does not have yet; this is what would go red the day it is
    // replaced by something that scopes administrators too.
    const viewer = await capabilityViewer(mesh);
    const mine = await ids(viewer);
    const theirs = await ids(admin);

    expect(theirs.length, "the administrator sees no more than a capability-less member").toBeGreaterThan(mine.length);
    expect(theirs, "an identity a member can see is missing from the administrator's list").toEqual(
      expect.arrayContaining(mine),
    );
  }, 60_000);
});

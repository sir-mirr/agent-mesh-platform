/**
 * `POST /api/v1/admin/groups` refuses a field it does not implement (SPEC § 12).
 *
 * This exists because of a four-month silence. The front-end fixture created
 * its groups with `{group_id, name, members}`; the route reads `group_id` and
 * `description`, so two of those three went nowhere and the caller was told
 * `201` each time. The groups were empty, the topology screen drew every live
 * agent into them to compensate, and the two defects hid each other — removing
 * either one is what made the other visible.
 *
 * So the assertion is not "the field is ignored correctly". It is that a body
 * asking for something this route cannot do is answered with a refusal that
 * names the route that can, and that nothing is created in the meantime: a
 * half-applied create is the same silence one step later.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loginAsAdmin, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let adminCookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  adminCookie = await loginAsAdmin(mesh.http);
});

afterAll(() => mesh?.stop());

const createGroup = (body: unknown) =>
  fetch(`${mesh.http.url}/api/v1/admin/groups`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(body),
  });

const listGroups = async () => {
  const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, { headers: { Cookie: adminCookie } });
  const body = (await res.json()) as { groups?: Array<{ group_id: string; members?: string[] }> };
  return body.groups ?? [];
};

describe("creating a group with a field the route does not implement", () => {
  test("refuses `members`, and says where membership is written instead", async () => {
    const res = await createGroup({ group_id: "refused-members", members: ["agent-alpha"] });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("members");
    // The refusal has to carry the way forward. "unsupported field" alone
    // leaves the caller exactly as stuck as the silence did.
    expect(body.error).toContain("/api/v1/admin/groups/{group_id}/members");
  });

  test("refuses `name`, which is the same defect one field over", async () => {
    const res = await createGroup({ group_id: "refused-name", name: "Engineering Division" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("name");
    expect(body.error).toContain("description");
  });

  test("creates nothing when it refuses", async () => {
    await createGroup({ group_id: "not-created", members: ["agent-alpha"], description: "d" });
    const ids = (await listGroups()).map((g) => g.group_id);
    expect(ids).not.toContain("not-created");
  });

  test("still creates a group whose body says only what the route implements", async () => {
    const res = await createGroup({ group_id: "accepted", description: "the supported shape" });
    expect(res.status).toBe(201);
    expect((await listGroups()).map((g) => g.group_id)).toContain("accepted");
  });

  test("the route the refusal names is one that works", async () => {
    // Without this the guard could be satisfied by a 400 pointing anywhere.
    await createGroup({ group_id: "destination", description: null });
    const res = await fetch(`${mesh.http.url}/api/v1/admin/groups/destination/members`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ identity: "agent-alpha" }),
    });
    expect(res.status).toBe(200);

    const destination = (await listGroups()).find((g) => g.group_id === "destination");
    expect(destination?.members).toContain("agent-alpha");
  });
});

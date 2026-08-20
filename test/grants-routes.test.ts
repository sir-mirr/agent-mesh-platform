/**
 * Who holds which capability, over HTTP (SPEC § 11).
 *
 * The front end was calling `/api/v1/admin/pending` for this screen, which is a
 * different question — that approves a person's *access to the web surface*,
 * and this is what a signed-in person may do once they are here. § 11 replaced
 * the admin role with capabilities precisely because "is an admin" answered too
 * many questions at once, and a screen that conflates them offers one switch
 * where there are two.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loginAsAdmin, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
let cookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  cookie = await loginAsAdmin(mesh.http);
});
afterAll(() => mesh?.stop());

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${mesh.http.url}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("reading grants", () => {
  test("the whole map carries the vocabulary with it", async () => {
    const body = await (await call("GET", "/api/v1/admin/grants")).json();
    expect(body.ok).toBe(true);
    // A matrix screen needs the columns as much as the cells. Without this the
    // front end compiles its own copy of the capability list, and a capability
    // added here never appears there.
    expect(body.capabilities).toContain("role.grant");
    expect(body.grants.some((g: any) => g.subject === "admin")).toBe(true);
  });

  test("filters by subject and by capability", async () => {
    const bySubject = await (await call("GET", "/api/v1/admin/grants?subject=admin")).json();
    expect(bySubject.grants.every((g: any) => g.subject === undefined || g.subject === "admin")).toBe(true);

    const byCap = await (await call("GET", "/api/v1/admin/grants?capability=key.approve")).json();
    expect(byCap.subjects.some((s: any) => s.subject === "admin")).toBe(true);
  });

  test("an unknown capability is refused, and says what the real ones are", async () => {
    const res = await call("GET", "/api/v1/admin/grants?capability=not.a.capability");
    expect(res.status).toBe(400);
    expect((await res.json()).capabilities).toContain("role.grant");
  });
});

describe("granting and revoking", () => {
  test("a grant round-trips", async () => {
    expect((await call("POST", "/api/v1/admin/grants", {
      subject: "grants-probe", capability: "key.approve",
    })).status).toBe(201);

    const body = await (await call("GET", "/api/v1/admin/grants?subject=grants-probe")).json();
    expect(body.grants.some((g: any) => g.capability === "key.approve")).toBe(true);

    expect((await (await call("DELETE", "/api/v1/admin/grants", {
      subject: "grants-probe", capability: "key.approve",
    })).json()).action).toBe("deleted");

    const after = await (await call("GET", "/api/v1/admin/grants?subject=grants-probe")).json();
    expect(after.grants.length).toBe(0);
  });

  test("the author is the session, not what the caller claims", async () => {
    // **Send the claim.** Without it, a route reading `grantedBy` from the body
    // behaves identically and the guard is a no-op — which is exactly what the
    // first version of this file did, and the mutation went uncaught.
    //
    // A grant whose author is self-reported records whatever the author wanted
    // recorded, and then the trail agrees with anybody who can write to it.
    // dropped-fields: sent on purpose — `test/dropped-fields.test.ts` forbids
    // sending a field no route reads, and this test's whole point is to send
    // one. Without the marker the two guards cancel: one demands the claim be
    // made, the other demands it never be.
    await call("POST", "/api/v1/admin/grants", {
      subject: "author-probe",
      capability: "key.approve",
      grantedBy: "somebody-else",
    });

    const body = await (await call("GET", "/api/v1/admin/grants?subject=author-probe")).json();
    const row = body.grants.find((g: any) => g.capability === "key.approve");
    expect(row?.granted_by, "the caller's claim was recorded as the author").toBe("admin");
  });

  test("revoking what is not there is not an error", async () => {
    // An operator revoking twice, or racing another, wanted the same end state
    // and has it.
    const res = await call("DELETE", "/api/v1/admin/grants", {
      subject: "never-granted", capability: "key.approve",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe("not-found");
  });

  test("an unknown capability cannot be granted", async () => {
    // The store refuses it too, but a 500 from a caught throw tells an operator
    // nothing about which capabilities exist.
    const res = await call("POST", "/api/v1/admin/grants", {
      subject: "grants-probe", capability: "invented.capability",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).capabilities).toContain("role.grant");
  });
});

describe("the gate", () => {
  test("no session is refused", async () => {
    // Reading the map is itself sensitive: it is who can do what, which is the
    // first thing worth knowing before trying anything.
    expect((await fetch(`${mesh.http.url}/api/v1/admin/grants`)).status).toBe(401);
  });
});

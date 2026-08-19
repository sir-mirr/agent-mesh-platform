/**
 * The viewer the harness builds is a member the product could have produced.
 *
 * **This is a test of the test harness**, which needs a reason. The reason is
 * that thirteen scenarios spent their lives on an empty page. `capabilityViewer`
 * wrote `local_users` directly — correct on the day it was written, when no
 * route created a local account — and `seedLocalUsers` approves every local
 * account it finds **at boot**. A row inserted while the server is already up
 * misses that loop forever, `isUserApproved` reads `agent_registry` and says no,
 * and `/api/v1/agents` answers 403. The table then holds no rows, and a check
 * counting rows passes against nothing.
 *
 * `agent-mesh-local-pm` measured it twice (mail #1104). I read the schema's
 * `users.approved DEFAULT 1` and argued back — a column that gate never reads.
 *
 * The helper now goes through the routes, and the point of this file is that
 * "goes through the routes" is a claim with a test rather than a comment. What
 * makes the shape dangerous is that it is invisible from the passing side: the
 * scenarios were green before the fix and green after it, and only a direct
 * question about the account tells the two apart.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { capabilityViewer, loginAsAdmin, startMesh, type Mesh } from "./harness";

let mesh: Mesh;

beforeAll(async () => {
  mesh = await startMesh();
});

afterAll(async () => {
  await mesh?.stop();
});

describe("the harness's viewer is an admitted member", () => {
  test("a route that gates on approval lets them in", async () => {
    const cookie = await capabilityViewer(mesh);

    // 403 here is the whole defect: it is what `/api/v1/agents` answered for
    // every viewer this harness built, and the screens above it then drew an
    // empty table rather than an error.
    const res = await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie } });
    expect(res.status, `an approval-gated route refused the harness's viewer: ${await res.text()}`).toBe(200);
  }, 30_000);

  test("they hold exactly what they were granted, and are not an admin in disguise", async () => {
    // The other half. Approving by making everyone an administrator would
    // satisfy the test above and destroy every capability assertion in the
    // suite — `isUserApproved` returns true for `role === 'admin'` before it
    // looks at anything else, so that is the cheap wrong fix.
    const cookie = await capabilityViewer(mesh, "audit.read.metadata");
    const me = (await (await fetch(`${mesh.http.url}/auth/me`, { headers: { cookie } })).json()) as {
      role: string;
      capabilities: string[];
      must_change_password?: boolean;
    };

    expect(me.role, "the viewer was admitted as an administrator").toBe("member");
    expect(me.capabilities).toEqual(["audit.read.metadata"]);
    expect(me.must_change_password, "the viewer is still sitting at the password gate").toBeFalsy();
  }, 30_000);

  test("an unapproved account is refused, so the check above can fail", async () => {
    // Without this, `200` above proves nothing about approval: a build in which
    // the gate never refused anybody would pass it. This writes the row the way
    // the helper used to — past the API, while the server is up — and that is
    // the one place in this file that is allowed to.
    const admin = await loginAsAdmin(mesh.http);
    const username = "viewer-never-admitted";
    const { openTestDb } = await import("./harness");
    const db = openTestDb(`${mesh.stateDir}/agent-mesh.db`, { readwrite: true });
    db.prepare(
      "INSERT OR IGNORE INTO local_users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'member')",
    ).run(username, await Bun.password.hash(username, { algorithm: "bcrypt" }), username);
    db.close();

    const login = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username, password: username }),
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie, "the account could not sign in at all, so this proves nothing about approval")
      .toStartWith("mesh_token=");

    const res = await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie } });
    expect(res.status, "an account that never went through admission was treated as approved").toBe(403);
    expect(admin).toStartWith("mesh_token=");
  }, 30_000);
});

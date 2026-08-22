/**
 * Local sign-in answers in the shape the caller asked for.
 *
 * The redirect this route has always sent is the right answer for the
 * server-rendered form and an unreadable one for `fetch`: a single-page client
 * gets a `302` it must be told not to follow, a body it cannot parse, and no way
 * to tell a missing field from a wrong password — both were `302` to a query
 * string meant for a page that renders it.
 *
 * The form's behaviour is asserted here too, because the whole point of
 * negotiating rather than adding a second route is that the old caller is
 * untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SEED_ADMIN, startMesh, type Mesh } from "./harness";

let mesh: Mesh;
beforeAll(async () => {
  mesh = await startMesh();
});
afterAll(() => mesh?.stop());

const asJson = (body: unknown) =>
  fetch(`${mesh.http.url}/auth/local`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });

const asForm = (body: string) =>
  fetch(`${mesh.http.url}/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });

describe("a JSON caller", () => {
  test("gets the session and the cookie", async () => {
    const res = await asJson({ username: SEED_ADMIN, password: "admin" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.github_login).toBe(SEED_ADMIN);
    expect(body.user.role).toBe("admin");

    // The cookie is what carries the session. It is set on this response
    // whichever shape was asked for.
    expect(res.headers.get("set-cookie")).toContain("mesh_token=");
  });

  test("is not handed the token in the body", async () => {
    // A caller holding the cookie does not need it, and a caller that keeps it
    // somewhere else has made it a thing to steal.
    const body = await (await asJson({ username: SEED_ADMIN, password: "admin" })).json();
    expect(JSON.stringify(body)).not.toContain("eyJ");
  });

  test("can tell a missing field from a wrong password", async () => {
    // The distinction the redirect could not carry, and the reason this exists.
    expect((await asJson({ username: SEED_ADMIN })).status).toBe(400);
    expect((await asJson({ username: SEED_ADMIN, password: "nope" })).status).toBe(401);
  });

  test("is not told which of the two was wrong", async () => {
    // Distinguishing "no such user" from "wrong password" turns sign-in into a
    // way to enumerate accounts.
    const missing = await (await asJson({ username: "nobody-here", password: "x" })).json();
    const wrong = await (await asJson({ username: SEED_ADMIN, password: "x" })).json();
    expect(missing.error).toBe(wrong.error);
  });
});

describe("a JSON caller that asked for nothing back", () => {
  /**
   * The shape `curl` produces by default, and the one the documented command
   * hides: a JSON body with no `accept` header.
   *
   * The route chose its body parser from `accept`, so this went to the form
   * parser, arrived with no fields, and failed as `missing` **before
   * authentication** — which made a correct password and a wrong one
   * indistinguishable. `agent-mesh-local-pm` met it on the first login of a
   * fresh clone and nearly reported that login was broken on new hosts.
   */
  const jsonBodyOnly = (body: unknown) =>
    fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  test("is let in with the right password", async () => {
    const res = await jsonBodyOnly({ username: SEED_ADMIN, password: "admin" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("set-cookie"), "signed in without a session").toContain("mesh_token=");
  });

  test("is refused with the wrong one, and told so differently", async () => {
    // Both halves. Reading the body by `accept` made every outcome `missing`;
    // reading it by `content-type` and stopping there would make every outcome
    // fine. The pair is what says authentication is being reached.
    const res = await jsonBodyOnly({ username: SEED_ADMIN, password: "not-it" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid");
  });
});

describe("the form", () => {
  test("still gets its redirect and cookie", async () => {
    const res = await asForm(`username=${SEED_ADMIN}&password=admin`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/chat");
    expect(res.headers.get("set-cookie")).toContain("mesh_token=");
  });

  test("still gets a redirect on a bad password", async () => {
    const res = await asForm(`username=${SEED_ADMIN}&password=nope`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid");
  });
});

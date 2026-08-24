/**
 * The admission queue, and the rename that had to land without a blind window.
 *
 * `/api/v1/admin/pending` answered `{ pending: [...] }` and moved to
 * `{ users: [...] }` under `D-689`, one path segment away from the key queue
 * that answers the same-shaped body about a different question. This function
 * reads `users` and tolerates a bare array; it does *not* read `pending`, and
 * that absence is the assertion — an alias would leave a reader unable to tell
 * which name the server sends.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { fetchLocalUsers, admitLocalUserApi, fetchPendingAdmissions } from "./users.ts";

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore would poison every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spyOn = (body: unknown) => {
  const spy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body));
  stub(spy);
  return spy;
};

afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchPendingAdmissions", () => {
  it("reads the queue under the name the route sends today", async () => {
    spyOn({ ok: true, users: [{ github_login: "asked-to-join" }] });
    expect((await fetchPendingAdmissions()).map((u) => u.github_login)).toEqual(["asked-to-join"]);
  });

  it("takes a bare array as well", async () => {
    spyOn([{ github_login: "older-shape" }]);
    expect((await fetchPendingAdmissions())).toHaveLength(1);
  });

  it("draws nothing rather than guessing when the body uses the old name", async () => {
    // Deliberate. `pending` is the name this route left behind; reading both
    // would be the alias D-689 refused, arriving by the back door.
    spyOn({ ok: true, pending: [{ github_login: "old-name" }] });
    expect(await fetchPendingAdmissions()).toEqual([]);
  });
});

describe("admitLocalUserApi", () => {
  it("omits the display name rather than sending an empty one", async () => {
    const spy = spyOn({ ok: true, user: {}, temporary_password: "x" });
    await admitLocalUserApi("newcomer", "");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ username: "newcomer" });
  });

  it("passes a display name when there is one", async () => {
    const spy = spyOn({ ok: true, user: {}, temporary_password: "x" });
    await admitLocalUserApi("newcomer", "New Comer");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).display_name).toBe("New Comer");
  });

  it("passes the selected tenant and does not derive one from the account name", async () => {
    const spy = spyOn({ ok: true, user: {}, temporary_password: "x" });
    await admitLocalUserApi("newcomer", "New Comer", "tenant-b");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({
      username: "newcomer",
      display_name: "New Comer",
      tenant: "tenant-b",
    });

    // **The half the title is about.** Passing a tenant and seeing it arrive
    // says nothing about deriving one; only the call that supplies none can.
    // Until this line existed the sentence above was unguarded, and a fallback
    // splitting the username would have passed.
    const bare = spyOn({ ok: true, user: {}, temporary_password: "x" });
    await admitLocalUserApi("acme-newcomer");
    expect(
      JSON.parse(String(bare.mock.calls[0]![1]!.body)),
      "a tenant was invented from the account name, which puts an isolation boundary in a string split",
    ).toEqual({ username: "acme-newcomer" });
  });

  it("carries the one-time password back to the caller", async () => {
    spyOn({ ok: true, user: { github_login: "newcomer" }, temporary_password: "shown-once" });
    expect((await admitLocalUserApi("newcomer")).temporary_password).toBe("shown-once");
  });
});

describe("fetchLocalUsers", () => {
  it("reads the roster", async () => {
    spyOn({ ok: true, users: [{ github_login: "admin", role: "admin" }] });
    expect((await fetchLocalUsers()).users).toHaveLength(1);
  });
});

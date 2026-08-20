/**
 * Who holds which capability, and the delete that answers `200` either way.
 *
 * `deleteGrantApi` reads `action`, not `removed` — SPEC § 9.2a, after four
 * deletion routes were found answering four different things. The scope
 * defaulting to `*` is the other thing worth pinning: a screen that omits it
 * must not silently revoke a narrower grant than the operator selected.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { fetchGrants, addGrantApi, deleteGrantApi } from "./grants.ts";

const realFetch = globalThis.fetch;
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };
const spyOn = (body: unknown) => {
  const spy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  stub(spy);
  return spy;
};
afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchGrants", () => {
  it("carries the vocabulary with the map", async () => {
    spyOn({ ok: true, capabilities: ["role.grant"], grants: [{ subject: "admin", capability: "role.grant" }] });
    const body = await fetchGrants();
    // A matrix screen needs the columns as much as the cells; without them the
    // front end compiles its own copy of the capability list.
    expect(body.capabilities).toContain("role.grant");
    expect(body.grants).toHaveLength(1);
  });
});

describe("addGrantApi", () => {
  it("defaults the scope to everything rather than leaving it out", async () => {
    const spy = spyOn({ ok: true });
    await addGrantApi("someone", "key.approve");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({
      subject: "someone", capability: "key.approve", scope: "*",
    });
  });

  it("sends the scope it was given", async () => {
    const spy = spyOn({ ok: true });
    await addGrantApi("someone", "group.manage", "lane-a");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).scope).toBe("lane-a");
  });
});

describe("deleteGrantApi", () => {
  it("reads `action`, the word SPEC § 9.2a settled on", async () => {
    spyOn({ ok: true, action: "not-found" });
    expect((await deleteGrantApi("nobody", "key.approve")).action).toBe("not-found");
  });

  it("sends a DELETE with the subject in the body, not the path", async () => {
    const spy = spyOn({ ok: true, action: "deleted" });
    await deleteGrantApi("someone", "key.approve", "lane-a");
    expect(spy.mock.calls[0]![1]!.method).toBe("DELETE");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).scope).toBe("lane-a");
  });
});

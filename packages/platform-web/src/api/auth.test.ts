/**
 * What the three auth calls actually put on the wire.
 *
 * `/auth/local` is form-encoded and the other two are JSON, which is not a
 * detail a screen can see: the route reads the body according to the
 * `content-type` header, and a login sent as JSON to a parser expecting a form
 * arrives as an empty username. That mismatch has been fixed on the server
 * side; nothing on this side asserted which of the two this function sends.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { loginLocalApi, fetchAuthMe, changePasswordApi } from "./auth.ts";

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

describe("loginLocalApi", () => {
  it("posts a form, not JSON, and says so in the header", async () => {
    const spy = spyOn({ ok: true });
    await loginLocalApi("admin", "p a s s&word");
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain("/auth/local");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    // Encoded, so a password with a space or an ampersand survives the trip.
    expect(String(init!.body)).toBe("username=admin&password=p+a+s+s%26word");
  });
});

describe("fetchAuthMe", () => {
  it("asks for JSON and reads the answer through", async () => {
    spyOn({ ok: true, user: { github_login: "admin" }, tenant: "acme" });
    const me = await fetchAuthMe();
    expect(me.tenant).toBe("acme");
  });
});

describe("changePasswordApi", () => {
  it("sends the current password as well as the next one", async () => {
    const spy = spyOn({ ok: true, must_change_password: false });
    await changePasswordApi("old-one", "new-one");
    const body = JSON.parse(String(spy.mock.calls[0]![1]!.body));
    // A cookie left on an unattended screen must not be enough to take the
    // account, which is only true while this field is actually sent.
    expect(body).toEqual({ current: "old-one", next: "new-one" });
  });
});

/**
 * **The document goes in; the network types do not come with it.**
 *
 * This is the guard for the defect that cost `packages/http` 275 failures on
 * every CI push for weeks. `GlobalRegistrator.register()` replaces every window
 * property on `globalThis`, including `Request`, `Response` and `Headers`, and
 * a browser's versions enforce rules a server's do not: `cookie` and
 * `Set-Cookie` are forbidden header names and are dropped, and header names
 * keep the case they were written in.
 *
 * The registration is process-wide, so which types the server suites saw came
 * down to which file bun loaded first — this package's tests ran after them
 * here and before them in CI, and the same commit passed on one machine and
 * failed 275 times on the other. Nothing in the product was different.
 */
import { describe, expect, test } from "bun:test";

import { registerDom } from "./register-dom";

registerDom();

describe("registering a document", () => {
  test("gives this process one", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("object");
  });

  test("and leaves the server's request type in place", () => {
    const req = new Request("http://probe.invalid/", { headers: { cookie: "mesh_token=probe" } });

    expect(
      req.headers.get("cookie"),
      "a browser's Request is installed globally, so every server suite after this file loses its session",
    ).toBe("mesh_token=probe");
  });

  test("and the server's response type", () => {
    const res = new Response("x", { headers: { "Set-Cookie": "mesh_token=probe" } });

    expect(
      { cookies: res.headers.getSetCookie(), names: [...res.headers.keys()] },
      "a browser's Response is installed globally, so every session this server issues is answered without one",
    ).toEqual({ cookies: ["mesh_token=probe"], names: ["set-cookie"] });
  });

  test("and the body types those two speak", async () => {
    // A `Blob` from the window is not one the server's `Request` accepts: the
    // body arrives as the string `[object Blob]`, which uploads then hash and
    // are refused for. Measured — this is what the first version of the fix
    // missed, and what nineteen upload cases failed on afterwards.
    const req = new Request("http://probe.invalid/", { method: "PUT", body: new Blob(["hello"]) });

    expect(
      await req.text(),
      "a body built here does not survive into a request, so every upload uploads the word `[object Blob]`",
    ).toBe("hello");
  });

  test("and a second call changes nothing", () => {
    // `register()` throws if it has already run, and every file in this package
    // calls this at its top level. The guard is the whole reason it is a
    // function rather than three lines copied thirty-nine times.
    expect(() => registerDom()).not.toThrow();
  });
});

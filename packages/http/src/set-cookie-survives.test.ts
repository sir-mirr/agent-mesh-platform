/**
 * **A session cookie has to survive the middleware in front of it.**
 *
 * `POST /auth/local` builds its answer as a raw `new Response(body, { headers:
 * { 'Set-Cookie': … } })`, and two middlewares run in front of every route: the
 * CORS one, and the correlation one, which calls `c.header('x-request-id', …)`
 * *before* the handler. Hono merges those prepared headers into whatever the
 * handler returned, and that merge is the only place between the route and the
 * browser where the cookie can be lost.
 *
 * It is lost there in CI. The same sign-in answers `200` with the user in the
 * body and no `Set-Cookie` on it — `getSetCookie()` returns `[]` — while on
 * this machine the header arrives. The header names come back in a different
 * shape too: lower-cased and sorted here, capitalised and insertion-ordered
 * there, which is two different objects answering, not two different values.
 *
 * So this is the shape, isolated: one middleware that prepares a header, one
 * route that answers with its own `Response`. If it fails anywhere, sign-in on
 * that platform hands out no session at all — the product failure, not the
 * suite's.
 */
import { describe, expect, test } from "bun:test";

import { Hono } from "hono";
import { cors } from "hono/cors";

/** The two middlewares main.ts installs, in the order it installs them. */
function shaped(): Hono {
  const app = new Hono();
  app.use("/*", cors({ origin: (origin) => (origin === "http://allowed" ? origin : null), credentials: true }));
  app.use("*", async (c, next) => {
    c.header("x-request-id", "probe-id");
    await next();
  });
  app.post("/sign-in", (c) =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": "mesh_token=probe; Path=/; Max-Age=60; SameSite=Lax" },
    }),
  );
  return app;
}

describe("the session cookie", () => {
  test("survives the middleware that prepares a header before the route", async () => {
    const res = await shaped().fetch(new Request("http://probe.invalid/sign-in", { method: "POST" }));

    expect(
      {
        status: res.status,
        cookies: res.headers.getSetCookie(),
        // What the correlation middleware added, so a failure says whether the
        // merge ran at all or only lost the cookie.
        correlated: res.headers.get("x-request-id"),
      },
      "the answer reached this line without its session cookie: a sign-in on this platform hands out no session",
    ).toEqual({
      status: 200,
      cookies: ["mesh_token=probe; Path=/; Max-Age=60; SameSite=Lax"],
      correlated: "probe-id",
    });
  });

  test("survives when the route answers through the context instead", async () => {
    // The other way to write the same route. If the raw-`Response` form loses
    // the cookie and this one does not, this is the repair.
    const app = new Hono();
    app.use("*", async (c, next) => { c.header("x-request-id", "probe-id"); await next(); });
    app.post("/sign-in", (c) => {
      c.header("Set-Cookie", "mesh_token=probe; Path=/; Max-Age=60; SameSite=Lax");
      return c.json({ ok: true });
    });

    const res = await app.fetch(new Request("http://probe.invalid/sign-in", { method: "POST" }));

    expect(res.headers.getSetCookie()).toEqual(["mesh_token=probe; Path=/; Max-Age=60; SameSite=Lax"]);
  });
});

/**
 * **Below Hono, below the app: the runtime itself.**
 *
 * Both shapes above lose the cookie on the platform CI runs — the raw
 * `Response` and the `c.header` + `c.json` one — which is one layer too low for
 * a framework-usage answer. These three ask the runtime directly: a `Headers`
 * built from a record, a `Response` built with one, and the same value
 * `append`ed. Whichever of them fails is the layer the cookie is lost at, and
 * if all three pass the loss is Hono's merge after all.
 */
describe("what this runtime does with Set-Cookie", () => {
  test("keeps it in a Headers built from a record", () => {
    expect(new Headers({ "Set-Cookie": "mesh_token=probe; Path=/" }).getSetCookie())
      .toEqual(["mesh_token=probe; Path=/"]);
  });

  test("keeps it in a Response built from a record", () => {
    expect(new Response("x", { headers: { "Set-Cookie": "mesh_token=probe; Path=/" } }).headers.getSetCookie())
      .toEqual(["mesh_token=probe; Path=/"]);
  });

  test("keeps it when appended to an existing response", () => {
    const res = new Response("x");
    res.headers.append("Set-Cookie", "mesh_token=probe; Path=/");
    expect(res.headers.getSetCookie()).toEqual(["mesh_token=probe; Path=/"]);
  });
});

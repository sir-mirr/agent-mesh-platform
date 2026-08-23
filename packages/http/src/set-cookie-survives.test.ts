/**
 * **A session cookie has to survive the way the answer is built.**
 *
 * `new Response(body, { headers: { 'Set-Cookie': … } })` loses the cookie on
 * Linux. Measured on bun 1.3.13 — the same build on both machines — through
 * three shapes: a `Headers` built from a record keeps it, appending to a
 * response that already exists keeps it, and the `Response` constructor's
 * header record drops it, on Linux and not on macOS.
 *
 * Every session this server handed out was built the third way. On the platform
 * it deploys to, signing in therefore answered `200` with the user in the body
 * and no session at all, and the next request came back `401` — which reads as
 * a wrong password. It cost the unit suite 276 failures on every push for
 * weeks, and it was invisible from here: the first green neighbour of that red
 * run was a laptop, and nobody read the red one.
 *
 * So the product appends, and these hold that: the two shapes it is allowed to
 * use, and a grep that keeps the third one out of the source.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";
import { cors } from "hono/cors";

const COOKIE = "mesh_token=probe; Path=/; Max-Age=60; SameSite=Lax";

describe("the session cookie", () => {
  test("survives the middleware in front of the route when the answer appends it", async () => {
    // The two middlewares main.ts installs, in the order it installs them: one
    // that prepares a header before the route runs, and CORS in front of both.
    const app = new Hono();
    app.use("/*", cors({ origin: (origin) => (origin === "http://allowed" ? origin : null), credentials: true }));
    app.use("*", async (c, next) => { c.header("x-request-id", "probe-id"); await next(); });
    app.post("/sign-in", () => {
      const res = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      res.headers.append("Set-Cookie", COOKIE);
      return res;
    });

    const res = await app.fetch(new Request("http://probe.invalid/sign-in", { method: "POST" }));

    expect(
      { status: res.status, cookies: res.headers.getSetCookie(), correlated: res.headers.get("x-request-id") },
      "the answer reached this line without its session cookie: a sign-in on this platform hands out no session",
    ).toEqual({ status: 200, cookies: [COOKIE], correlated: "probe-id" });
  });
});

describe("what this runtime does with Set-Cookie", () => {
  test("keeps it in a Headers built from a record", () => {
    expect(new Headers({ "Set-Cookie": COOKIE }).getSetCookie()).toEqual([COOKIE]);
  });

  test("keeps it when appended to an answer that already exists", () => {
    const res = new Response("x");
    res.headers.append("Set-Cookie", COOKIE);

    expect(res.headers.getSetCookie()).toEqual([COOKIE]);
  });
});

/**
 * The shape that loses it, kept out of the source rather than argued about.
 *
 * A runtime difference nobody can see from their own machine needs a check that
 * does not depend on which machine is running it. This one reads the files.
 */
describe("the source", () => {
  test("never hands Set-Cookie to the Response constructor", () => {
    const dir = import.meta.dir;
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      const source = readFileSync(join(dir, name), "utf8");
      for (const [i, l] of source.split("\n").entries()) {
        // `'Set-Cookie':` is only ever a key in a header record. Appending it
        // reads as `append('Set-Cookie', …)`, which has no colon after it.
        //
        // Comments are skipped, and not for tidiness: the sentence explaining
        // this rule quotes the shape it forbids, so a check that read comments
        // would fail on its own reason and be deleted by whoever met it next.
        const code = l.trimStart();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (/['"]Set-Cookie['"]\s*:/.test(l)) offenders.push(`${name}:${i + 1}`);
      }
    }

    expect(
      offenders,
      "a header record carries the session cookie again, which is the shape that drops it on Linux",
    ).toEqual([]);
  });
});

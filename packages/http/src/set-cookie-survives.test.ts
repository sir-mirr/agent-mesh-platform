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
  test("survives CORS when the cookie goes on after it", async () => {
    // main.ts's chain, in its order: the cookie middleware outermost, then
    // CORS, then the one that prepares the correlation header. The route hands
    // its cookie to the first and answers without one, so nothing downstream
    // has a cookie to lose.
    const app = new Hono<{ Variables: { sessionCookie?: string } }>();
    app.use("*", async (c, next) => {
      await next();
      const cookie = c.get("sessionCookie");
      if (cookie) c.res.headers.append("Set-Cookie", cookie);
    });
    app.use("/*", cors({ origin: (origin) => (origin === "http://allowed" ? origin : null), credentials: true }));
    app.use("*", async (c, next) => { c.header("x-request-id", "probe-id"); await next(); });
    app.post("/sign-in", (c) => {
      c.set("sessionCookie", COOKIE);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const res = await app.fetch(new Request("http://probe.invalid/sign-in", { method: "POST" }));

    expect(
      { status: res.status, cookies: res.headers.getSetCookie(), correlated: res.headers.get("x-request-id") },
      "the answer reached this line without its session cookie: a sign-in on this platform hands out no session",
    ).toEqual({ status: 200, cookies: [COOKIE], correlated: "probe-id" });
  });

  test("does not survive CORS when the route puts it on itself", async () => {
    // The shape this server used until now, and the one the source guard below
    // keeps out. On Linux the cookie is gone by the time it reaches this line;
    // on macOS it is not. Asserting *either* would fail on one of the two
    // platforms, so what is asserted is the part that holds everywhere: the
    // answer is otherwise identical, and the cookie is the only thing at risk.
    const app = new Hono();
    app.use("/*", cors({ origin: (origin) => (origin === "http://allowed" ? origin : null), credentials: true }));
    app.post("/sign-in", () => {
      const res = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      res.headers.append("Set-Cookie", COOKIE);
      return res;
    });

    const res = await app.fetch(new Request("http://probe.invalid/sign-in", { method: "POST" }));
    const kept = res.headers.getSetCookie();

    expect(
      { status: res.status, kept: kept.length === 0 || kept[0] === COOKIE },
      "the cookie came through changed rather than kept or dropped, which is neither platform's behaviour",
    ).toEqual({ status: 200, kept: true });
  });
});

/**
 * **Which layer eats it — three shapes, one variable.**
 *
 * Appending to a bare `Response` keeps the cookie on both platforms, and the
 * same append through Hono's chain loses it on Linux. So the loss is in what
 * Hono does to the answer on the way out, and the thing that makes Hono rebuild
 * the answer is a header prepared *before* the route runs. These three hold
 * that variable and nothing else: no middleware, a middleware that writes after
 * the route, and a middleware that prepares before it.
 */
describe("where the cookie is lost", () => {
  const answer = () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    res.headers.append("Set-Cookie", COOKIE);
    return res;
  };
  const ask = (app: Hono) => app.fetch(new Request("http://probe.invalid/sign-in", { method: "POST" }));

  test("with no middleware at all", async () => {
    const app = new Hono();
    app.post("/sign-in", answer);

    expect((await ask(app)).headers.getSetCookie(), "Hono loses it with nothing else in the way").toEqual([COOKIE]);
  });

  test("with a middleware that writes its header after the route", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { await next(); c.res.headers.set("x-request-id", "probe-id"); });
    app.post("/sign-in", answer);

    const res = await ask(app);
    expect(
      { cookies: res.headers.getSetCookie(), correlated: res.headers.get("x-request-id") },
      "writing the correlation header after the route is not the repair either",
    ).toEqual({ cookies: [COOKIE], correlated: "probe-id" });
  });

  test("with a middleware that prepares its header before the route", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.header("x-request-id", "probe-id"); await next(); });
    app.post("/sign-in", answer);

    expect((await ask(app)).headers.getSetCookie(), "a header prepared before the route costs the cookie").toEqual([COOKIE]);
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
  test("sets the session cookie in exactly one place", () => {
    // Not a style rule. Every other place is downstream of something that
    // rebuilds the answer, and rebuilding is what loses it — so "one place, and
    // it is the outermost middleware" is the property, not "tidy".
    const dir = import.meta.dir;
    const sites: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      for (const [i, l] of readFileSync(join(dir, name), "utf8").split("\n").entries()) {
        const code = l.trimStart();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (/['"]Set-Cookie['"]/.test(l)) sites.push(`${name}:${i + 1}`);
      }
    }

    expect(sites.length, `the session cookie is set in ${sites.length} places: ${sites.join(", ")}`).toBe(1);
  });

  test("appends the cookie outside CORS, not inside it", () => {
    // The order is the repair, and it is invisible from a Mac: both orders pass
    // every behavioural test here, and only one of them keeps the cookie on
    // Linux. So the check reads the file. `app.use` runs in registration order
    // going in and in reverse coming out, so the cookie middleware has to be
    // registered *before* CORS for its half after `next()` to run *after* it.
    const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8").split("\n");
    const cookieAt = source.findIndex((l) => l.includes("c.res.headers.append('Set-Cookie'"));
    const corsAt = source.findIndex((l) => l.trimStart().startsWith("cors({"));

    expect(
      { cookieFound: cookieAt >= 0, corsFound: corsAt >= 0, cookieFirst: cookieAt < corsAt },
      "the cookie is appended inside CORS's rebuild, where Linux loses it",
    ).toEqual({ cookieFound: true, corsFound: true, cookieFirst: true });
  });

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

/**
 * **What the in-process suites are allowed to depend on.**
 *
 * `cookie` is a forbidden header name. A `Request` built inside this process
 * keeps it here and loses it on the runtime CI runs — through a record, through
 * a `Headers`, through a tuple list and through a clone, all four measured
 * there. Asserting either behaviour would fail on one of the two machines, so
 * what is held instead is the thing that is true on both: `Authorization`
 * survives, and no suite in this package asks a `Request` to carry a session
 * cookie. The cookie path is exercised where a browser sends it, over a real
 * connection.
 */
describe("what an in-process request may carry", () => {
  test("an Authorization header, on any runtime", () => {
    const req = new Request("http://probe.invalid/", { headers: { authorization: "Bearer probe-token" } });

    expect(
      req.headers.get("authorization"),
      "the session cannot travel as a bearer token either, so in-process routes cannot be authenticated at all here",
    ).toBe("Bearer probe-token");
  });

  test("and no suite here authenticates with a cookie header", () => {
    // The header objects themselves, not the word: a parameter named `cookie`
    // carrying a bearer token is fine, and `res.headers.get("set-cookie")` on
    // an answer is a different thing entirely. So this reads each `headers: {…}`
    // literal and looks for a cookie *key* inside it.
    const keyInHeaders = (source: string): boolean => {
      for (let at = source.indexOf("headers:"); at >= 0; at = source.indexOf("headers:", at + 1)) {
        const open = source.indexOf("{", at);
        if (open < 0 || open > at + 12) continue;
        let depth = 0, i = open;
        for (; i < source.length; i++) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}" && --depth === 0) break;
        }
        if (/[{,]\s*cookie\s*[,}:]/.test(source.slice(open, i + 1))) return true;
      }
      return /headers\.set\(\s*["']cookie["']/.test(source);
    };

    const offenders = readdirSync(import.meta.dir)
      .filter((n) => n.endsWith(".test.ts") && n !== "set-cookie-survives.test.ts")
      .filter((n) => keyInHeaders(readFileSync(join(import.meta.dir, n), "utf8")));

    expect(
      offenders,
      "a suite carries its session in a cookie header, which arrives on one machine and not the other",
    ).toEqual([]);
  });
});

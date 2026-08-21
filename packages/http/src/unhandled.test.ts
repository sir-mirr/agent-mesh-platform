/**
 * What a caller is told when a handler throws, and what the operator is told.
 *
 * This is the last thing in front of the socket: every route catches what it
 * can fail on, so the only way here is a defect, and that is exactly why it was
 * never run. A handler nobody has run is a handler whose decisions nobody has
 * checked — and both of the decisions here are about what leaves the process.
 *
 * The two are deliberately not the same answer. An exception message is written
 * for whoever wrote the code: it can carry a path, a query, a row, a token that
 * arrived in one. It goes to the log, where the person who can fix it is
 * looking, and not to the caller, who gets *a 500 happened* and nothing else.
 */
import { describe, expect, test } from "bun:test";

import { Hono } from "hono";

import { captureConsole } from "@agent-mesh/log";

process.env.JWT_SECRET ||= "unhandled-probe";

const { answerUnhandled } = await import("./main.ts");

/** A route that throws whatever it is handed, answered by the real handler. */
function probe(thrown: unknown): Hono {
  const app = new Hono();
  app.all("/boom/:rest{.*}?", () => { throw thrown; });
  app.all("/boom", () => { throw thrown; });
  app.onError(answerUnhandled);
  return app;
}

const events = (lines: string[]) =>
  lines.filter((l) => l.includes(' {"ts":"'))
    .map((l) => JSON.parse(l.slice(l.lastIndexOf(' {"ts":"') + 1)));

async function throwing(thrown: unknown, path = "/boom"): Promise<{ res: Response; lines: string[] }> {
  const { lines, restore } = captureConsole();
  try {
    const res = await probe(thrown).fetch(new Request(`http://probe.invalid${path}`));
    return { res, lines };
  } finally {
    restore();
  }
}

describe("when a handler throws", () => {
  test("the caller is told a 500 happened, and nothing else", async () => {
    const { res } = await throwing(new Error("connect ECONNREFUSED 10.0.0.4:5432 as user cron_admin"));

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Internal server error" });
    // Not the message, not the host, not the account it was connecting as.
    expect(body).not.toContain("10.0.0.4");
    expect(body).not.toContain("cron_admin");
  });

  test("and the operator is told which route, and what it said", async () => {
    const { lines } = await throwing(new Error("connect ECONNREFUSED 10.0.0.4:5432"));

    const line = events(lines).find((e) => e.event === "unhandled_error");
    expect(line).toBeDefined();
    // `error`, not `warn`: nothing here worked as designed.
    expect(line.level).toBe("error");
    expect(line.reason).toBe("unhandled_exception");
    expect(line.route).toBe("/boom");
    expect(line.error).toContain("ECONNREFUSED");
  });

  /**
   * **The route, not the URL.** A query string is caller input and arrives in
   * the log verbatim — one of these is a session token in a link somebody
   * pasted. The pathname is the part that says which code threw, which is the
   * whole question this line answers.
   */
  test("the query string does not follow the route into the log", async () => {
    const { lines } = await throwing(new Error("kaboom"), "/boom?token=eyJhbGciOiJIUzI1NiJ9.secret");

    const line = events(lines).find((e) => e.event === "unhandled_error");
    expect(line.route).toBe("/boom");
    expect(lines.join("\n")).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  /**
   * **Something thrown that is not an `Error` never arrives here at all.**
   * Hono's `#handleError` re-throws it instead of calling the handler, so this
   * answers `Error`s and only `Error`s — and the `String(err)` guard that used
   * to sit in it was a branch that could not run, reading as though the case
   * were handled while a thrown string went straight past the framework.
   *
   * Held here rather than argued: if Hono ever starts wrapping, this fails and
   * the guard goes back.
   */
  test("something thrown that is not an Error never reaches it", async () => {
    const { lines, restore } = captureConsole();
    try {
      await expect(probe("kaboom, plainly").fetch(new Request("http://probe.invalid/boom")))
        .rejects.toBe("kaboom, plainly");
    } finally {
      restore();
    }

    // Nothing logged, because the handler was never called.
    expect(events(lines).filter((e) => e.event === "unhandled_error")).toEqual([]);
  });
});

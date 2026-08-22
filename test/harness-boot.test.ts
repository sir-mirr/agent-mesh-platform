/**
 * What the harness says when a boot does not work, and when it tries again.
 *
 * These are the sentences a person reads at the moment nothing else is
 * working — a suite gone red for a reason that is not the code — and they were
 * the least checked lines in the repository, because reading them means losing
 * a race on purpose. One of them had already been wrong in a way that mattered:
 * the boot failure appended the hub's output alone, so an http server that died
 * on startup was reported underneath the hub's healthy log, and the retry that
 * reads this same string could only ever see half the races it exists for.
 *
 * Nothing here boots a mesh. The retry takes its boot as a parameter and the
 * two message builders are functions, so the whole policy runs in this process.
 */
import { describe, expect, test } from "bun:test";

import {
  bootFailureMessage,
  bootRetryable,
  freePort,
  rpcAnswer,
  sessionCookie,
  startMesh,
  waitForHealth,
  type Mesh,
} from "./harness";

/**
 * The error a promise ended on, insisting that it ended on one. Without the
 * insistence, a `waitForHealth` that started succeeding would leave every
 * assertion below reading properties of `undefined`, which fails for a reason
 * that says nothing about the wait.
 */
async function failure(p: Promise<unknown>): Promise<Error> {
  let caught: Error | null = null;
  try {
    await p;
  } catch (err) {
    caught = err as Error;
  }
  if (!caught) throw new Error("expected this to fail, and it did not");
  return caught;
}

const capture = () => {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  return { lines, restore: () => { console.error = real; } };
};

describe("waiting for a port to answer", () => {
  test("returns as soon as it is healthy", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      await waitForHealth(`http://127.0.0.1:${server.port}/`, 2_000);
    } finally {
      server.stop(true);
    }
  });

  /**
   * **The last error, not just the timeout.** A bare *never became healthy*
   * says the wait ended and nothing about why, which is the difference between
   * *nothing is listening there* and *it is listening and refusing*.
   */
  test("says what the connection said when nothing is listening", async () => {
    const port = await freePort();

    const err = await failure(waitForHealth(`http://127.0.0.1:${port}/`, 150));
    expect(err.message).toContain(`service at http://127.0.0.1:${port}/ never became healthy:`);
    // Whatever the runtime called it — but not the placeholder, which would
    // mean no attempt was ever made inside the wait.
    expect(err.message).not.toContain("no attempt made");
  });

  test("and says the status when it is listening and unwell", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("not yet", { status: 503 }),
    });
    try {
      const err = await failure(waitForHealth(`http://127.0.0.1:${server.port}/`, 150));
      expect(err.message).toContain("never became healthy: status 503");
    } finally {
      server.stop(true);
    }
  });
});

describe("what a failed boot says on the way out", () => {
  test("carries both children, labelled", () => {
    const said = bootFailureMessage("service at http://x never became healthy: timed out", "hub up on 3100", "EADDRINUSE");

    expect(said).toContain("service at http://x never became healthy: timed out");
    expect(said).toContain("--- hub output ---\nhub up on 3100");
    expect(said).toContain("--- http output ---\nEADDRINUSE");
  });

  /**
   * A mesh that never started an http server is a different report from one
   * whose http server started and said nothing. An empty section reads as the
   * second, so there is no section.
   */
  test("and no http section when there was no http server", () => {
    const said = bootFailureMessage("hub never came up", "PORT_TAKEN", null);

    expect(said).toContain("--- hub output ---");
    expect(said).not.toContain("--- http output ---");
  });

  /**
   * **The two are read together.** `bootRetryable` is handed this string, so a
   * child's output that never reached the message is a race the retry cannot
   * see — which is exactly the defect the http half was added for.
   */
  test("and the retry can see what either child said", () => {
    const httpTookThePort = bootFailureMessage(
      "service at http://127.0.0.1:41234/ never became healthy: fetch failed",
      "hub listening",
      "EADDRINUSE: address already in use",
    );
    expect(bootRetryable(httpTookThePort)).toBe(true);

    // A refusal is an answer, not a race: retrying it would turn the checks
    // that assert the refusal green against a server that stopped refusing.
    const refused = bootFailureMessage(
      "service at http://127.0.0.1:41234/ never became healthy: fetch failed",
      "refusing to start: JWT_SECRET is not set",
      null,
    );
    expect(bootRetryable(refused)).toBe(false);

    // Silence from both is the case that is worth another port: a child that
    // said nothing never reached the point of having an opinion.
    const silent = bootFailureMessage(
      "service at http://127.0.0.1:41234/ never became healthy: fetch failed",
      "",
      "",
    );
    expect(bootRetryable(silent)).toBe(true);
  });
});

describe("taking another port", () => {
  const mesh = { hub: {}, http: {} } as unknown as Mesh;

  test("tries again on a silent boot, and says so each time", async () => {
    let attempts = 0;
    const boot = async () => {
      attempts++;
      if (attempts < 3) throw new Error("service at http://127.0.0.1:1/ never became healthy: fetch failed");
      return mesh;
    };

    const { lines, restore } = capture();
    try {
      expect(await startMesh({}, boot)).toBe(mesh);
    } finally {
      restore();
    }

    expect(attempts).toBe(3);
    // Printed rather than swallowed: the next person to meet this window should
    // not have to reconstruct what the boot said from its timing.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("attempt 1/3");
    expect(lines[1]).toContain("attempt 2/3");
  });

  /**
   * A service that refuses says why, and that is an answer. Retrying it would
   * hide the answer behind two more attempts and then report the same failure
   * three times as slowly.
   */
  test("does not try again when the boot said why", async () => {
    let attempts = 0;
    const boot = async (): Promise<Mesh> => {
      attempts++;
      throw new Error("refusing to start: JWT_SECRET is not set");
    };

    const { lines, restore } = capture();
    try {
      await expect(startMesh({}, boot)).rejects.toThrow("JWT_SECRET is not set");
    } finally {
      restore();
    }

    expect(attempts).toBe(1);
    expect(lines).toEqual([]);
  });

  /**
   * **The last error, not a new one.** Three lost races end in the same
   * sentence the third one wrote — a fresh *gave up after 3 attempts* would
   * drop the only description of what actually happened.
   */
  test("gives up after three, with what the third one said", async () => {
    let attempts = 0;
    const boot = async (): Promise<Mesh> => {
      attempts++;
      throw new Error(`service at http://127.0.0.1:${attempts}/ never became healthy: fetch failed`);
    };

    const { lines, restore } = capture();
    try {
      await expect(startMesh({}, boot)).rejects.toThrow("http://127.0.0.1:3/");
    } finally {
      restore();
    }

    expect(attempts).toBe(3);
    expect(lines).toHaveLength(3);
  });

  /**
   * A child that died mid-write can carry its whole log into the message. The
   * notice is a signpost, not the evidence — the evidence is in the error it is
   * about, which is thrown when the attempts run out.
   */
  test("and the notice does not reprint the whole child log", async () => {
    const boot = async (): Promise<Mesh> => {
      throw new Error(`service at http://x/ never became healthy: ${"noise ".repeat(500)}`);
    };

    const { lines, restore } = capture();
    try {
      await expect(startMesh({}, boot)).rejects.toThrow();
    } finally {
      restore();
    }

    expect(lines[0]!.length).toBeLessThan(600);
  });
});

/**
 * **A 302 is not a session.** Reading the redirect as success cost an hour of
 * somebody's night — the account did not exist, the route redirected anyway,
 * and every request after it went out with no cookie and came back 401 from
 * somewhere else entirely.
 *
 * There were four copies of this rule and they had drifted: `loginAsAdmin`
 * threw only when there was no `Set-Cookie` at all, so any cookie counted, and
 * the first sign-in inside `provision` checked nothing and let an empty string
 * travel on to fail the password change with a 401 naming neither cause.
 */
describe("whether a sign-in produced a session", () => {
  test("takes the cookie and drops its attributes", () => {
    expect(sessionCookie("ada", 200, "mesh_token=abc.def; Path=/; HttpOnly; SameSite=Lax"))
      .toBe("mesh_token=abc.def");
  });

  test("a redirect with no cookie is not a session", () => {
    expect(() => sessionCookie("ada", 302, null))
      .toThrow("ada could not sign in: 302, no mesh_token");
  });

  /**
   * The case the old admin copy let through: a header is present, and it is
   * not a session. A CSRF or a locale cookie set on the way to the login page
   * is enough to satisfy *there was a Set-Cookie*.
   */
  test("and neither is some other cookie", () => {
    expect(() => sessionCookie("ada", 302, "locale=en-GB; Path=/"))
      .toThrow("no mesh_token");
  });

  test("and the name has to be the whole name", () => {
    // `mesh_token_hint` starts with the same letters and is not the session.
    expect(() => sessionCookie("ada", 200, "mesh_token_hint=1; Path=/")).toThrow("no mesh_token");
  });
});

describe("a route that did not answer JSON", () => {
  test("hands back what parsed", () => {
    expect(rpcAnswer("mesh.send", 200, '{"result":{"id":"m-1"}}')).toEqual({
      status: 200,
      body: { result: { id: "m-1" } },
    });
  });

  /**
   * The failure names the route and the status, because `await res.json()` on
   * a plain-text body throws a bare `SyntaxError` — the right verdict reported
   * at the wrong address, which sends a reader to the harness instead of to
   * the route that moved out from under them.
   */
  test("and names the route, the status and what it did answer", () => {
    const err = (() => {
      try {
        rpcAnswer("mesh.send", 404, "<!doctype html><title>Not found</title>");
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(err).not.toBeNull();
    expect(err!.message).toContain("POST /api/v1/rpc (mesh.send) answered 404");
    expect(err!.message).toContain("with a body that is not JSON: <!doctype html>");
  });

  test("and does not paste a whole page into the failure", () => {
    const err = (() => {
      try {
        rpcAnswer("mesh.send", 500, "x".repeat(5_000));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(err!.message.length).toBeLessThan(400);
  });
});

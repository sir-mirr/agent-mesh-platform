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
  absentService,
  admissionOpened,
  bootFailureMessage,
  bootRetryable,
  connectRpc,
  freePort,
  leftThePasswordGate,
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

/**
 * The `http` a hub-only mesh carries.
 *
 * Built by every `withHttp: false` suite and called by none of them — an object
 * literal inside the boot, so its four answers were compiled, shipped and never
 * asked. What they promise is that a caller can treat it like a service that
 * has already stopped, and the one that matters is `exited`: a teardown that
 * orders cleanup behind the exits waits on it, and a pending promise there
 * hangs a suite that never started an http server in the first place.
 */
describe("a mesh with no http", () => {
  test("answers like a service that has already stopped", async () => {
    const absent = absentService();
    expect(
      { died: absent.died(), output: absent.output(), exited: await absent.exited, port: absent.port },
      "the placeholder claimed a death, a log, or a port it does not have",
    ).toEqual({ died: null, output: "", exited: 0, port: 0 });
    // Not a throw: `teardown` stops what a mesh holds without asking which
    // half of it was real.
    expect(() => absent.stop()).not.toThrow();
  });
});


/**
 * The socket half of the harness, and its two ways of giving up.
 *
 * Both are what a test reads when a run goes wrong at three in the morning —
 * one says the hub never accepted the connection, the other says it accepted
 * and answered nothing — and neither had ever run. Reaching the second through
 * a real hub means waiting out five seconds of silence, so the wait is a
 * parameter now and this hands it twenty milliseconds.
 */
describe("talking to a hub over the socket", () => {
  test("a socket that will not open is refused, not left hanging", async () => {
    // Bound and released, so nothing is listening there.
    const port = await freePort();

    await expect(connectRpc({ port })).rejects.toThrow("websocket failed to open");
  });

  test("a call nobody answers gives up, naming the method and the wait", async () => {
    const heard: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("not a socket", { status: 400 })),
      websocket: { message: (_ws, text) => { heard.push(String(text)); } },
    });

    try {
      const port = server.port;
      if (port == null) throw new Error("the stand-in hub bound no port");
      const rpc = await connectRpc({ port }, undefined, 20);

      await expect(rpc.call("mesh.silence", {})).rejects.toThrow("no response to mesh.silence within 20ms");
      // The frame did go out: giving up on a request nobody sent would be a
      // different defect wearing the same message.
      expect(heard.map((text) => JSON.parse(text).method)).toEqual(["mesh.silence"]);
    } finally {
      server.stop(true);
    }
  });
});


/**
 * Admitting an account, and the two ways a live route says no.
 *
 * `409` is the account already being there, which every second run of a file
 * produces and which the harness walks past. Anything else is a mesh that did
 * not admit and did not say so in the one way this expects — and the sentence
 * thrown there is the whole of what a person sees when the harness gives up. It
 * had never been produced: reaching it means a server answering something no
 * healthy one answers.
 */
describe("admitting the account a scenario needs", () => {
  const read = () => Promise.resolve("");

  test("an admission that opened is walked through the password gate", async () => {
    expect(await admissionOpened("viewer", { ok: true, status: 201 }, read)).toBe(true);
  });

  test("an account already there is walked past, not treated as a failure", async () => {
    expect(
      await admissionOpened("viewer", { ok: false, status: 409 }, read),
      "the second run of a file would fail on an account the first one made",
    ).toBe(false);
  });

  test("and anything else stops, naming the status and what the route said", async () => {
    await expect(
      admissionOpened("viewer", { ok: false, status: 403 }, () => Promise.resolve("no capability")),
    ).rejects.toThrow("admitting viewer answered 403: no capability");
  });

  test("the password gate is walked out of, or the run stops there", () => {
    expect(() => leftThePasswordGate("viewer", 200)).not.toThrow();
    expect(
      () => leftThePasswordGate("viewer", 401),
      "an account that cannot leave the gate goes on to fail at every later step, about a session it never had",
    ).toThrow("viewer could not leave the password gate: 401");
  });
});

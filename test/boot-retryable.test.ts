/**
 * What the harness treats as worth another port.
 *
 * This decides whether a failed boot is retried or reported, and it is the
 * only thing standing between a machine deep in swap and a red run that says
 * nothing about the code. It had exactly one recognised failure — a message
 * naming a port — and `freePort` is bind-then-release, so the race it exists
 * for is won by whoever binds first and *lost by whoever is slow*. A slow boot
 * says nothing about ports, so the retry never ran.
 *
 * Both directions are here because only one of them is safe to get wrong in
 * the direction of "retry more": `misconfigured-boot.test.ts` asserts that two
 * services refuse to start, and retrying a refusal would turn those green
 * against a server that had stopped refusing.
 */
import { describe, expect, test } from "bun:test";

import { bootRetryable } from "./harness";

describe("what is worth another port", () => {
  test("a boot that named a port is retried", () => {
    // Bun's own wording. The first version of this guard matched `EADDRINUSE`,
    // which no service in this tree prints, and shipped looking like a guard.
    expect(bootRetryable("error: Failed to start server. Is port 60147 in use?")).toBe(true);
    expect(bootRetryable("listen EADDRINUSE: address already in use 127.0.0.1:3000")).toBe(true);
  });

  test("a boot that said nothing at all is retried", () => {
    // The observed case: a 10 870 ms failure against a 200 x 50 ms wait, with
    // no port message anywhere. The child never reached the point of having an
    // opinion, and the run failed once, loudly, for the machine's reason.
    expect({ empty: bootRetryable(""), blank: bootRetryable("   \n\n  ") })
      .toEqual({ empty: true, blank: true });
  });

  /**
   * **These two shapes are not the ones it is handed.** `startMesh` calls this
   * with the message `bootFailureMessage` builds, which always carries at least
   * a `--- hub output ---` header — so a silence rule tested only against `""`
   * and blanks passed while the branch could not run in production. The
   * realistic shapes are in `harness-boot.test.ts`, against both builders at
   * once; these stay as the rule's own boundary cases.
   */
  test("the harness's own timeout sentence does not count as the child speaking", () => {
    // `waitForHealth` throws this, and it is the harness describing its own
    // wait rather than the service explaining itself. Counting it as speech
    // would make every slow boot look like a refusal.
    expect(bootRetryable("service at http://127.0.0.1:51423 never became healthy: TypeError: fetch failed"))
      .toBe(true);
  });

  test("a spawn the kernel refused is retried, and reads as the machine's answer", () => {
    // Observed on a CI runner: `Bun.spawn` threw before any child existed, and
    // the message is about a file descriptor. Every test in that file then
    // failed for a reason with nothing to do with the mesh — which is the
    // definition this guard is for, and the one shape it did not recognise.
    const said =
      "EBADF: bad file descriptor, epoll_ctl\n" +
      "      at spawnService (/home/runner/work/agent-mesh-platform/test/harness.ts:199:8)";
    expect(bootRetryable(said), "a spawn the OS refused was reported as the mesh's answer").toBe(true);
    // The neighbours, for the same reason: a run out of descriptors or memory
    // has not reached the point of anything having an opinion either.
    expect(["EMFILE: too many open files", "ENFILE: file table overflow", "ENOMEM: out of memory"].map(bootRetryable))
      .toEqual([true, true, true]);
  });

  test("a service that names one of those codes in a refusal is still a refusal", () => {
    // The word has to be the kernel's, not a sentence a service wrote. This is
    // the direction that is unsafe to widen: `misconfigured-boot.test.ts`
    // asserts services refuse, and a retry there would go green against a
    // server that had stopped refusing.
    expect(bootRetryable("[http-server] refusing to start: set EMFILEX_LIMIT first")).toBe(false);
  });

  test("a service that refused is the answer, not a race", () => {
    // These two are asserted by `misconfigured-boot.test.ts`. If either became
    // retryable, those checks would go green against a server that no longer
    // refuses — the failure they exist to catch.
    const refusals = [
      "[http-server] JWT_SECRET is not set. Refusing to start.",
      "unable to open database file",
      "error: AGENT_MESH_STATE_DIR is required",
    ];
    expect(refusals.map(bootRetryable)).toEqual([false, false, false]);
  });

  test("a refusal wrapped in the harness's timeout is still a refusal", () => {
    // The thrown error carries both: the harness's sentence and the child's
    // output underneath. Stripping the first must not swallow the second.
    const said =
      "service at http://127.0.0.1:51423 never became healthy: TypeError: fetch failed\n" +
      "--- http output ---\n[http-server] JWT_SECRET is not set. Refusing to start.";
    expect(bootRetryable(said)).toBe(false);
  });
});

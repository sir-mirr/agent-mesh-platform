/**
 * Which paths the hub hands to the mailbox module — and which it must not.
 *
 * The dispatcher in `main.ts` used to decide this a second time, with
 * `startsWith("/api/v1/mailbox")`, while `rest/mailbox.ts` matched its four
 * paths exactly. The two disagreed on every sibling name: `/api/v1/mailboxfoo`
 * entered the branch, was refused inside it, and came back `404`.
 *
 * **That disagreement is invisible from outside**, which is why this test is
 * here and not in `test/`. Measured on a hub booted for it before the change:
 * `/api/v1/mailboxfoo` answered `404 Not Found`, `text/plain;charset=utf-8`,
 * nine bytes — byte-for-byte an unrouted path's answer, with no log line. A
 * response-level test cannot tell the two apart and so cannot catch a revert;
 * the predicate can.
 *
 * What the loose match actually cost was never a leak. `isMailboxPath` refuses
 * before `authenticate` runs, so nothing signed, leased or stored was reachable.
 * It cost the request body read above that refusal, and — because the branch
 * `return`s rather than falling through — a standing claim on every future
 * route whose path begins with those letters.
 */
import { describe, expect, test } from "bun:test";

import { handleMailboxRoute, handlesPath, isMailboxPath } from "./rest/mailbox";

/** The four signed paths, plus the unsigned route dispatched beside them. */
const OWNED = [
  "/api/v1/mailbox/in",
  "/api/v1/mailbox/history",
  "/api/v1/mailbox/out",
  "/api/v1/mailbox/out/01J0000000000000000000000",
  "/api/v1/capabilities",
];

/**
 * Sibling names the word matches and the separator does not.
 *
 * `/api/v1/mailbox` is here deliberately: it is the bare noun, the likeliest
 * name for a listing route somebody adds later, and the one the old prefix
 * swallowed most quietly.
 */
const NOT_OWNED = [
  "/api/v1/mailboxfoo",
  "/api/v1/mailbox",
  // The same boundary one level down: `out` takes an id after a separator, so
  // the sibling word is not a recall of anything.
  "/api/v1/mailbox/outfoo",
  "/api/v1/mailboxes",
  "/api/v1/mailbox-admin",
  "/api/v1/capabilities/extra",
  "/api/v1/agents",
];

describe("what the hub hands to the mailbox module", () => {
  test.each(OWNED)("%s is handed over", (pathname) => {
    expect(handlesPath(pathname)).toBe(true);
  });

  test.each(NOT_OWNED)("%s is not", (pathname) => {
    expect(handlesPath(pathname)).toBe(false);
  });

  /**
   * The invariant the two-place version broke: nothing is handed over that the
   * module then refuses to answer. A `null` here is a path the dispatcher
   * claimed and nobody serves — which is exactly what `/api/v1/mailboxfoo` was.
   */
  test.each(OWNED)("%s is answered, not returned null", (pathname) => {
    const answer = handleMailboxRoute({
      method: pathname === "/api/v1/capabilities" ? "GET" : "POST",
      path: pathname,
      pathname,
      search: "",
      authorization: null,
      body: "",
    });
    expect(answer).not.toBeNull();
  });

  /**
   * `/api/v1/capabilities` is dispatched with the mailbox routes and is not one
   * of them: it answers before authentication on purpose (§ 9.2.1), so a
   * pending key can read the lease window it needs. Folding it into the signed
   * set would put it behind the signature it exists to precede.
   */
  test("capabilities is dispatched here but is not the signed surface", () => {
    expect(handlesPath("/api/v1/capabilities")).toBe(true);
    expect(isMailboxPath("/api/v1/capabilities")).toBe(false);
  });
});

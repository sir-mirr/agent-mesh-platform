/**
 * The replay window's housekeeping (SPEC § 8.1).
 *
 * A nonce is remembered so the same signed request cannot be sent twice. The
 * memory has to be bounded, and the two ways of bounding it are not alike:
 * sweeping on every check makes a busy identity pay for the whole map, while
 * sweeping on a timer lets an entry linger a few seconds past its window — a
 * map slot rather than a correctness problem, since a nonce outside the window
 * is refused on freshness anyway.
 *
 * This file owns the `nw-` prefix.
 */
import { describe, expect, test } from "bun:test";

import { NonceWindow } from "./verify";

const WINDOW = 120;

describe("sweeping expired nonces", () => {
  test("keeps what is still inside the window", () => {
    const w = new NonceWindow(WINDOW);
    expect(w.claim("nw-a", "nonce-1", 1_000)).toBe(true);
    w.sweep(1_000 + WINDOW - 1);
    expect(w.size()).toBe(1);
    // Still remembered, so the same request cannot be replayed.
    expect(w.claim("nw-a", "nonce-1", 1_000)).toBe(false);
  });

  test("drops what has left it", () => {
    const w = new NonceWindow(WINDOW);
    w.claim("nw-a", "nonce-1", 1_000);
    w.sweep(1_000 + WINDOW + 1);
    expect(w.size()).toBe(0);
  });

  /** An identity with nothing left is dropped too, or the map grows by name. */
  test("forgets an identity once its last nonce goes", () => {
    const w = new NonceWindow(WINDOW);
    w.claim("nw-a", "nonce-1", 1_000);
    w.claim("nw-b", "nonce-2", 5_000);
    w.sweep(1_000 + WINDOW + 1);

    expect(w.size()).toBe(1);
    // **Counted separately, because `size` cannot see it.** An identity whose
    // nonces are all swept and whose entry stays behind leaves `size` at the
    // right number while the map grows by name for ever.
    expect(w.identityCount()).toBe(1);
    // `nw-a` is gone entirely, so its nonce is claimable again — which is
    // correct: it is outside the freshness window and refused there instead.
    expect(w.claim("nw-a", "nonce-1", 1_000)).toBe(true);
  });

  test("sweeps each identity's entries by their own age", () => {
    const w = new NonceWindow(WINDOW);
    w.claim("nw-a", "old", 1_000);
    w.claim("nw-a", "new", 1_000 + WINDOW);
    w.sweep(1_000 + WINDOW + 1);

    expect(w.size()).toBe(1);
    expect(w.claim("nw-a", "new", 1_000 + WINDOW)).toBe(false);
    expect(w.claim("nw-a", "old", 1_000)).toBe(true);
  });

  test("does nothing on an empty window", () => {
    const w = new NonceWindow(WINDOW);
    expect(() => w.sweep(9_999)).not.toThrow();
    expect(w.size()).toBe(0);
  });
});

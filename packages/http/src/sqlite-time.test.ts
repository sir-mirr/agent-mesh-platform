/**
 * The one conversion between a storage format and a wire format (D-809).
 *
 * `test/registry-canon.test.ts` drives this through the agents listing and
 * asserts the shape that comes out, which is the check that matters for § 9.1.
 * What it cannot reach is the branch for a value this function does **not**
 * understand: every row a real mesh writes is `datetime('now')`, so the
 * pass-through never runs there.
 *
 * That branch is the one worth pinning, because getting it wrong is quiet.
 * Returning `null` for an unrecognised string would turn *a timestamp written
 * by something this comment does not cover* — the one-time `registry.json`
 * import wrote ISO directly, and `mesh.audit.append` carries client stamps —
 * into *no timestamp at all*, and a screen draws that as never-created rather
 * than as a value it should ask about. It is the same collapse this repository
 * keeps meeting: an absence and an unknown are not the same fact.
 */
import { describe, expect, test } from "bun:test";

import { isoOrNull } from "./sqlite-time";

describe("SQLite's datetime on the wire", () => {
  test("converts the shape the store writes", () => {
    // `datetime('now')` is UTC, which is why `Z` can be appended rather than
    // guessed at. Without the `T`, `new Date` reads the same string as local
    // time in the engines that accept it at all.
    expect(isoOrNull("2026-08-28 11:54:06")).toBe("2026-08-28T11:54:06Z");
  });

  test("keeps fractional seconds, because dropping them reorders a page", () => {
    // The listing sorts on these. Two rows written in the same second are
    // ordered by what is after the dot, and truncating makes that order
    // arbitrary rather than wrong-looking.
    expect(isoOrNull("2026-08-28 11:54:06.482")).toBe("2026-08-28T11:54:06.482Z");
  });

  test("says nothing about a row that has no timestamp", () => {
    expect({ nul: isoOrNull(null), undef: isoOrNull(undefined) }).toEqual({ nul: null, undef: null });
  });

  test("passes a value it does not understand through, rather than erasing it", () => {
    // **Both are timestamps that exist**, and neither is SQLite's shape: the
    // first is what the one-time registry import wrote, the second is a string
    // from somewhere this function's comment does not cover. Answering `null`
    // for either reports *no such time* for a row that has one.
    expect(isoOrNull("2026-08-28T11:54:06.000Z")).toBe("2026-08-28T11:54:06.000Z");
    expect(isoOrNull("last Tuesday")).toBe("last Tuesday");
  });

  test("refuses a near miss rather than repairing it", () => {
    // A value one character off the stored shape is not the stored shape, and
    // guessing at the missing piece is how a zone gets invented. It comes back
    // untouched, which is visible; a repaired one would not be.
    for (const near of ["2026-08-28  11:54:06", "2026-08-28T11:54:06", "2026-08-28 11:54"]) {
      expect(isoOrNull(near), `${near} was rewritten`).toBe(near);
    }
  });
});

/**
 * What happens when the correction has nothing to correct.
 *
 * A message the hub refuses is written locally as `failed`, and the write-back
 * is the whole point: the response and the SSE frames are built from an
 * in-memory object, while the history route, the conversation view and search
 * all serve the stored row. If the `UPDATE` matches nothing, the caller is told
 * the truth once and every later reader is told otherwise.
 *
 * The writer is a parameter so the miss is reachable. The alternative is
 * deleting the row out from under a live handler between its `INSERT` and its
 * `UPDATE`, which is a harsher thing to arrange than it is to observe.
 */
import { describe, expect, test } from "bun:test";
import { markSendFailed } from "./send-failure";

describe("marking a refused message failed", () => {
  test("writes the status against the id it was given", () => {
    const seen: Array<[string, string]> = [];
    expect(markSendFailed("msg_1", (id, status) => (seen.push([id, status]), true))).toBe(true);
    expect(seen).toEqual([["msg_1", "failed"]]);
  });

  test("says nothing when the row was there", () => {
    const realError = console.error;
    const said: string[] = [];
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    try {
      markSendFailed("msg_2", () => true);
    } finally {
      console.error = realError;
    }
    expect(said).toEqual([]);
  });

  /** A correction that applied to nothing is said out loud, and reported. */
  test("names the message when the correction matched no row", () => {
    const realError = console.error;
    const said: string[] = [];
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    let result: boolean;
    try {
      result = markSendFailed("msg_3", () => false);
    } finally {
      console.error = realError;
    }
    expect(result!).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("msg_3");
    expect(said[0]).toContain("no such row");
  });
});

/**
 * No state-changing call in the shipped UI ignores its answer.
 *
 * `packages/http/src/ui/` is 3,000-odd lines of browser JavaScript living
 * inside TypeScript template strings. Nothing under `test/` referenced it and
 * the mutation manifest had no entry for it, so it was the largest unchecked
 * region in the repository — and the first read of it found three writes whose
 * responses were discarded:
 *
 * ```
 * ui/admin.ts  approve / deny   gated on `user.admit`; a 403 re-rendered the
 *                               same pending list and said nothing, so a
 *                               refusal and a successful approval of somebody
 *                               who reappears looked identical
 * ui/chat.ts   push/subscribe   the browser keeps the subscription whatever
 *                               the server answered, so a failure leaves a
 *                               device that believes it is subscribed while
 *                               nothing on the server knows it exists
 * ```
 *
 * ## What this test does and does not prove
 *
 * It reads the shipped script text and asserts that every `await fetch(` for a
 * method other than GET binds its response. **That is a shape, not a
 * behaviour.** It cannot tell that the check which follows is correct, or that
 * the message reaches a person, and a determined author can satisfy it with a
 * variable nobody reads.
 *
 * It is worth having anyway, and worth being precise about: the defect it
 * catches is not a subtle one. All three sites were `await fetch(...)` as a
 * statement — no binding, no `.then`, nothing. That form cannot check anything,
 * so its absence is decidable from the text, and this file is the only thing
 * standing between the next one and a screen that lies about what it did.
 *
 * A DOM harness would prove the behaviour and is the honest next step; this is
 * what fits the shape the UI is written in today.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(import.meta.dir, "..", "packages", "http", "src", "ui");

const uiFiles = readdirSync(UI_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/**
 * `await fetch(` at the start of a statement — nothing bound, nothing chained.
 *
 * The negative lookbehind covers the two ways a response is kept: assigned to a
 * name (`const res = await fetch`) or returned (`return await fetch`). Both are
 * fine; this looks for the third form, which discards it.
 */
const DISCARDED = /(?<![=(]\s*)(?<!return\s)(?<!\breturn\s{1,10})^\s*await fetch\(/gm;

/** Lines with a method other than GET within a few lines of the call. */
function stateChanging(source: string, index: number): boolean {
  const window = source.slice(index, index + 400);
  return /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(window);
}

describe("shipped UI scripts", () => {
  test("there are UI files to check, so a pass means something", () => {
    // Without this, renaming the directory turns every assertion below into a
    // loop over nothing — the shape of green this repository keeps finding.
    expect(uiFiles.length).toBeGreaterThan(0);
    expect(uiFiles).toContain("admin.ts");
    expect(uiFiles).toContain("chat.ts");
  });

  test("no write discards its response", () => {
    const offenders: string[] = [];

    for (const file of uiFiles) {
      const source = readFileSync(join(UI_DIR, file), "utf8");
      for (const match of source.matchAll(DISCARDED)) {
        const at = match.index ?? 0;
        if (!stateChanging(source, at)) continue;
        const line = source.slice(0, at).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(
      offenders,
      "a POST/PUT/PATCH/DELETE whose response is thrown away cannot tell success from refusal",
    ).toEqual([]);
  });

  test("the check finds a discarded write when there is one", () => {
    // **Otherwise the assertion above passes because the regex matches
    // nothing.** A checker that has never fired is indistinguishable from a
    // codebase that is clean, and the difference is the whole value of it.
    const planted = `
      async function approve(login) {
        await fetch('/api/v1/admin/approve', { method: 'POST', headers, body: '{}' });
        loadPending();
      }
    `;
    const found = [...planted.matchAll(DISCARDED)].filter((m) => stateChanging(planted, m.index ?? 0));
    expect(found, "the pattern no longer recognises the defect it was written for").toHaveLength(1);
  });

  test("and leaves a checked write alone", () => {
    // The other direction: a fix must actually satisfy it, or the check is one
    // people route around.
    const fixed = `
      async function approve(login) {
        const res = await fetch('/api/v1/admin/approve', { method: 'POST', headers, body: '{}' });
        if (!res.ok) { alert('failed'); return; }
        loadPending();
      }
    `;
    const found = [...fixed.matchAll(DISCARDED)].filter((m) => stateChanging(fixed, m.index ?? 0));
    expect(found, "binding the response is the fix and the check rejects it").toHaveLength(0);
  });

  test("a plain GET is left alone, because reading nothing back is not the same defect", () => {
    // `await fetch(url)` with no method is a read whose result is unused, which
    // is odd but harmless. Flagging it would make the check noisy enough to be
    // disabled, which costs the writes it does catch.
    const read = `  await fetch('/api/v1/health');\n`;
    const found = [...read.matchAll(DISCARDED)].filter((m) => stateChanging(read, m.index ?? 0));
    expect(found).toHaveLength(0);
  });
});

/**
 * A function named as a question must not answer by writing.
 *
 * `NonceWindow.check` recorded the nonce it was asked about. Nothing failed:
 * every caller used it correctly, every test passed, and the name quietly
 * promised a caller it could ask twice — the second ask answering "replay"
 * against its own first. It was found by an audit, which means it survived
 * until someone thought to look.
 *
 * The client repository had the same split — `next()` beside `claimNext()` —
 * and had it by habit rather than by rule: transitions there are all named
 * `mark*`, so a function that wrote quietly would have looked out of place.
 * That works until the person with the habit is replaced. This is the same
 * rule with the habit removed.
 *
 * **It would not have caught `NonceWindow.check`, and that is worth stating.**
 * That method writes to a `Map` reached through a local alias
 * (`let forIdentity = this.seen.get(...)`, then `forIdentity.set(...)`), which
 * no name-and-body heuristic separates from a query building a local result.
 * Widening the rule to catch it flags every `list*` that pushes into an array.
 *
 * So this covers the tractable half: a query name sitting directly on a
 * durable write — SQL or the filesystem. Those are the ones that leave state
 * behind after the process exits, and they are the ones a reviewer is least
 * likely to notice, because the write is one call deep and reads like
 * bookkeeping. In-memory aliasing stays a review question.
 *
 * The rule was almost shipped claiming it caught the defect that prompted it.
 * Mutating `claim` back to `check` did not fail it — which is the only reason
 * the limitation is written down here rather than assumed away.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Prefixes that promise a caller the call is free of consequence.
 *
 * `issue`, `claim`, `ensure`, `record`, `mark` and the rest are absent on
 * purpose: they say a thing happens, which is the naming this test exists to
 * encourage. Anchored with `^` and followed by a word boundary or capital, so
 * `issueGrant` is not read as `is`.
 */
const QUERY_PREFIX =
  /^(check|verify|validate|is[A-Z_]|has[A-Z_]|get[A-Z_]|list|find|peek|read|lookup|resolve|count|inspect|select|fetch|query|exists)/;

const WRITES = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|writeFileSync|renameSync|unlinkSync|mkdirSync)\b/i;

interface Offender {
  file: string;
  line: number;
  name: string;
  wrote: string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(path);
  }
  return out;
}

/** The body of a function, from its declaration to its closing brace. */
function bodyOf(lines: string[], start: number): string {
  const body: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && i < start + 200; i++) {
    const line = lines[i]!;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    body.push(line);
    if (line.includes("{")) opened = true;
    if (opened && depth <= 0) break;
  }
  return body.join("\n");
}

function offenders(): Offender[] {
  const found: Offender[] = [];
  for (const file of sourceFiles(join(REPO_ROOT, "packages"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Exported functions and class methods alike.
      const m = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([a-zA-Z_$][\w$]*)\s*\(/.exec(lines[i]!);
      if (!m) continue;
      const name = m[1]!;
      if (!QUERY_PREFIX.test(name)) continue;
      // Skip control flow that happens to parse as a call.
      if (["if", "for", "while", "switch", "catch", "return"].includes(name)) continue;

      const body = bodyOf(lines, i);
      const wrote = WRITES.exec(body);
      if (wrote) {
        found.push({
          file: file.slice(REPO_ROOT.length),
          line: i + 1,
          name,
          wrote: wrote[0],
        });
      }
    }
  }
  return found;
}

describe("a query-named function does not write", () => {
  test("nothing in packages/ asks a question by changing an answer", () => {
    // Reported as a list rather than a count, so a failure names the function
    // instead of saying one exists.
    expect(offenders().map((o) => `${o.file}:${o.line} ${o.name} → ${o.wrote}`)).toEqual([]);
  });

  test("the check can actually see the violation it covers", () => {
    // A rule nobody has watched fail is a rule nobody knows is running.
    const lines = [
      "  check(identity: string, nonce: string): boolean {",
      "    db.prepare(`INSERT INTO seen (identity, nonce) VALUES (?, ?)`).run(identity, nonce);",
      "    return true;",
      "  }",
    ];
    expect(QUERY_PREFIX.test("check")).toBe(true);
    expect(WRITES.test(bodyOf(lines, 0))).toBe(true);

    // And the case it does not cover, stated so nobody assumes otherwise: the
    // real `NonceWindow` mutated a Map through a local alias.
    const aliased = [
      "  check(identity: string, nonce: string): boolean {",
      "    let forIdentity = this.seen.get(identity);",
      "    forIdentity.set(nonce, 1);",
      "    return true;",
      "  }",
    ];
    expect(WRITES.test(bodyOf(aliased, 0))).toBe(false);

    // And the names that say what they do are not caught by it.
    for (const name of ["claim", "issueGrant", "recordEvent", "markDeadLetter", "ensureKey"]) {
      expect(QUERY_PREFIX.test(name), `${name} is not a query name`).toBe(false);
    }
  });
});

/**
 * A function's name must not disagree with whether it writes.
 *
 * `NonceWindow.check` recorded the nonce it was asked about. Nothing failed:
 * every caller used it correctly, every test passed, and the name quietly
 * promised a caller it could ask twice — the second ask answering "replay"
 * against its own first. It survived until someone thought to look.
 *
 * Two rules, because they fail on different things.
 *
 * **A query name must not sit on a write.** `getFoo` that runs an `UPDATE`.
 * This one holds regardless of what the allowlist below says, so growing that
 * list cannot silence it.
 *
 * **A write must not have a name that says nothing.** `processRetry`,
 * `syncState`, `applyChange`. The client proposed this direction and it is the
 * better half: nobody names a mutation `get`, but `process*` arrives on its
 * own, and the first rule never sees it.
 *
 * ## What neither rule catches, verified by mutation rather than assumed
 *
 * Each was produced by editing the source, running, and recording the result.
 *
 *   claim → check                        NOT caught — `NonceWindow` mutates a
 *                                        `Map` through a local alias, which no
 *                                        name-and-body heuristic separates
 *                                        from a query building a local result
 *   issueGrant → getGrantForUpload       caught
 *   teardownIdentity → readIdentityState caught
 *   teardownIdentity → processIdentity   caught — the second rule; the first
 *                                        never sees a neutral name
 *   a write moved one call deeper        NOT caught — a wrapper with no
 *                                        statement of its own is invisible
 *
 * The third gap is deliberate rather than pending. Following calls would
 * require every *caller* of a writing function to have a writing name, and
 * that is false: a dispatcher legitimately calls a handler that legitimately
 * writes. So the rules cover the layer where the SQL and the filesystem
 * actually appear, and the layers above stay a review question.
 *
 * This file was one commit from shipping with a comment claiming it caught the
 * defect that prompted it. Running the mutation is the only reason that
 * sentence is not still here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Prefixes that promise the call is free of consequence. */
const QUERY_PREFIX =
  /^(check|verify|validate|is[A-Z_]|has[A-Z_]|get[A-Z_]|list|find|peek|read|lookup|resolve|count|inspect|select|fetch|query|exists)/;

/**
 * Verbs that say something happens.
 *
 * Every entry is a decision that this word tells a reader the call has an
 * effect — not a way to quiet the list. The client found three of its four
 * initial hits were gaps here rather than defects, which is the expected shape:
 * the check cannot judge whether a name says "write", only that somebody did.
 */
const WRITE_VERB =
  /^(insert|update|delete|remove|drop|write|save|store|record|mark|set|add|create|put|append|claim|reserve|issue|revoke|approve|deny|propose|teardown|migrate|seed|advance|schedule|cancel|clear|purge|collect|sweep|register|provision|upsert|touch|apply|commit|init|import|recall|withdraw|handle|on[A-Z])/i;

/** Durable writes — state that outlives the process. */
const WRITES =
  /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|writeFileSync|renameSync|unlinkSync)\b/i;

/**
 * A declaration, matched across the whole file so a multi-line signature is
 * not missed.
 *
 * Two mistakes were made getting here, both caught by mutation rather than by
 * reading. Matching any line that read as a call produced twenty hits,
 * nineteen of them `VALUES (?, ?)` and `WHERE id = ?` inside template
 * literals. Requiring the line to *end* with `{` fixed that and silently
 * dropped every function whose parameters span lines — which in this codebase
 * is most of them, so the rules matched almost nothing while still passing.
 *
 * Hence: the parameter list may contain newlines, and the body brace may be on
 * a later line, but a `{` must follow the signature. SQL fragments have no
 * such brace.
 */
const DECL =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:private\s+|public\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?(#?[a-zA-Z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*[^;{=]+)?\{/g;

const NOT_A_FUNCTION = new Set(["if", "for", "while", "switch", "catch", "constructor"]);

interface Finding {
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

/** Blank out template-literal lines so embedded SQL is not read as code. */
function maskTemplates(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    out.push(inside ? "" : line);
    if (line.split("`").length % 2 === 0) inside = !inside;
  }
  return out;
}

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

/** Every name the declaration matcher found, before any filtering. */
function parsedNames(): string[] {
  const names: string[] = [];
  for (const file of sourceFiles(join(REPO_ROOT, "packages"))) {
    const masked = maskTemplates(readFileSync(file, "utf8").split("\n")).join("\n");
    DECL.lastIndex = 0;
    for (let m = DECL.exec(masked); m; m = DECL.exec(masked)) {
      names.push(m[1]!.replace(/^#/, ""));
    }
  }
  return names;
}

function scan(disagrees: (name: string) => boolean): Finding[] {
  const found: Finding[] = [];
  for (const file of sourceFiles(join(REPO_ROOT, "packages"))) {
    const raw = readFileSync(file, "utf8").split("\n");
    const masked = maskTemplates(raw).join("\n");

    DECL.lastIndex = 0;
    for (let m = DECL.exec(masked); m; m = DECL.exec(masked)) {
      const name = m[1]!.replace(/^#/, "");
      if (NOT_A_FUNCTION.has(name)) continue;

      // Line of the declaration, so the body is read from the unmasked source.
      const line = masked.slice(0, m.index).split("\n").length;
      const wrote = WRITES.exec(bodyOf(raw, line - 1 + (m[0].startsWith("\n") ? 1 : 0)));
      if (wrote && disagrees(name)) {
        found.push({ file: file.slice(REPO_ROOT.length), line, name, wrote: wrote[0] });
      }
    }
  }
  return found;
}

const render = (f: Finding) => `${f.file}:${f.line} ${f.name} → ${f.wrote}`;

describe("a name agrees with whether the function writes", () => {
  test("no query-named function writes", () => {
    expect(scan((name) => QUERY_PREFIX.test(name)).map(render)).toEqual([]);
  });

  test("no write hides behind a name that says nothing", () => {
    // The broader direction, and the one that catches how new writes arrive.
    expect(scan((name) => !WRITE_VERB.test(name)).map(render)).toEqual([]);
  });

  test("both rules can see the violations they cover", () => {
    // A rule nobody has watched fail is a rule nobody knows is running.
    const writing = [
      "function example(): boolean {",
      "  db.prepare(`INSERT INTO seen (a) VALUES (?)`).run(1);",
      "  return true;",
      "}",
    ];
    expect(WRITES.test(bodyOf(writing, 0))).toBe(true);
    expect(QUERY_PREFIX.test("checkNonce")).toBe(true);
    expect(WRITE_VERB.test("processRetry")).toBe(false);
    expect(WRITE_VERB.test("syncState")).toBe(false);

    // Names that say what they do pass both.
    for (const name of ["claim", "issueGrant", "recordEvent", "markDeadLetter", "teardownIdentity"]) {
      expect(QUERY_PREFIX.test(name), `${name} reads as a query`).toBe(false);
      expect(WRITE_VERB.test(name), `${name} reads as a write`).toBe(true);
    }
  });

  test("the scanner is looking at functions, not at whatever parses", () => {
    // The client found 180 of its 389 "declarations" were `if` and `for`, and
    // its suite passed throughout: a checker pointed at the wrong list checks
    // that list consistently. Ours parses the same way — `if (x) {` is
    // indistinguishable from a method by shape — so the filter is load-bearing
    // and this pins that it is doing the work.
    const raw = parsedNames();
    expect(raw.length).toBeGreaterThan(200);

    // A proportion, not merely non-zero. `> 0` passes on a parser that has
    // narrowed to almost nothing — one surviving `if` would satisfy it while
    // every real function had been dropped. Control flow is the bulk of any
    // source file, so the share is stable in a way the count is not.
    const keywords = raw.filter((n) => NOT_A_FUNCTION.has(n));
    expect(keywords.length).toBeGreaterThan(50);
    expect(keywords.length / raw.length).toBeGreaterThan(0.2);

    const scanned = raw.filter((n) => !NOT_A_FUNCTION.has(n));
    for (const keyword of ["if", "for", "while", "switch", "do", "else", "return", "catch"]) {
      expect(scanned, `${keyword} reached the scanned set`).not.toContain(keyword);
    }
  });

  test("functions that write are actually reached", () => {
    // Canaries, and the check that was missing. Requiring the declaration to
    // end its line with `{` once dropped every multi-line signature — most of
    // this codebase — and every rule kept passing because it had nothing left
    // to judge. Any of these disappearing means the matcher narrowed again.
    const raw = new Set(parsedNames());
    for (const canary of [
      "teardownIdentity",   // export function, multi-line signature
      "issueGrant",         // export function, multi-line signature
      "addType",            // export function, multi-line signature
      "migrate",            // export function, single line
      "claim",              // class method
      "handleDeleteAgent",  // export function in a service
      "putBlob",            // exported async
    ]) {
      expect(raw, `${canary} is reached by the matcher`).toContain(canary);
    }
  });

  test("the declaration form excludes SQL inside template literals", () => {
    // Nineteen of the first twenty hits were `VALUES`, `WHERE` and `AND`
    // matching as function declarations. The trailing `{` is the whole fix.
    const probe = (text: string) => {
      DECL.lastIndex = 0;
      return DECL.test(text);
    };
    for (const fragment of ["  VALUES (?, ?)", "  WHERE identity = ?", "  AND status = 'x'"]) {
      expect(probe(fragment), fragment).toBe(false);
    }
    expect(probe("export function realOne(db: Database): void {")).toBe(true);
    // And a multi-line signature, which the first fix silently excluded.
    expect(probe("export function realTwo(\n  db: Database,\n  id: string,\n): void {")).toBe(true);
  });
});

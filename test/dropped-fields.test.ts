/**
 * A body field no route reads is a field the caller was told it applied.
 *
 * `POST /api/v1/admin/groups` accepted `{group_id, name, members}` and read two
 * of the three. The fixture that sent it never looked at the response, so the
 * groups came up empty for four months and the topology screen filled them in
 * by inventing members — each defect standing on the other. The route now
 * refuses what it does not implement; this is the guard for the rest of the
 * surface, because the only thing protecting the other sixteen write routes is
 * that nobody has happened to send them an extra field yet. No symptom is not
 * the same as no defect.
 *
 * **Both sides are derived.** The fields a route reads come from the server
 * source, and the fields a caller sends come from the caller. A hand-kept table
 * of either would be a second declaration that drifts, and the drift would show
 * up as this test passing.
 *
 * It can therefore fail in a fourth way — the parsers stop matching and it
 * checks nothing — so it also asserts what it managed to read.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SERVER = join(ROOT, "packages", "http", "src", "main.ts");

/**
 * Keys at depth 1 of the object literal starting at `src[start]`.
 *
 * A value is skipped rather than scanned: in `{ github_login: login }` the
 * identifier `login` is a value, and counting it as a key reported six routes
 * as broken that were not. Nested literals are values too — the `id` in
 * `attachments: [{ id }]` belongs to the route's own schema, not to this body.
 */
export function topLevelKeys(src: string, start: number): string[] {
  let depth = 0;
  let i = start;
  let inValue = false;
  const keys: string[] = [];
  while (i < src.length) {
    const c = src[i]!;
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") {
      depth -= 1;
      if (depth === 0) break;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
    } else if (depth === 1 && c === ",") inValue = false;
    else if (depth === 1 && !inValue) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*([:,}])/.exec(src.slice(i));
      if (m && "{, \n\t".includes(src[i - 1]!)) {
        keys.push(m[1]!);
        if (m[2] === ":") inValue = true;
        i += m[0].length - 1;
        continue;
      }
    }
    i += 1;
  }
  return keys;
}

/**
 * The keys of the object literal handed to the first `JSON.stringify` in
 * `window`, or `null` when the argument is not a literal.
 *
 * `JSON.stringify(payload)` has to answer `null` rather than the next `{` in
 * the file: reading on found the body of an unrelated call and reported its
 * keys against this route.
 */
export function stringifiedKeys(window: string): Set<string> | null {
  const at = window.indexOf("JSON.stringify(");
  if (at < 0) return null;
  let i = at + "JSON.stringify(".length;
  while (i < window.length && " \n\t".includes(window[i]!)) i += 1;
  if (window[i] !== "{") return null;
  return new Set(topLevelKeys(window, i));
}

/** `/api/v1/admin/groups/:group_id/egress` and its template form both become `…/{}/egress`. */
function normalisePath(url: string): string {
  const collapsed = url.replace(/\$\{[^}]*\}/g, "{}").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}");
  const query = collapsed.split("?")[0]!.replace(/\/$/, "");
  const at = query.indexOf("/api/v1");
  return at >= 0 ? query.slice(at) : query;
}

/** A route's path as segments, with `:param` already collapsed to `{}`. */
const segmentsOf = (path: string) => path.split("/").filter(Boolean);

/**
 * The route a caller's URL reaches, or `undefined`.
 *
 * A caller writes the parameter out — `/groups/engineering/egress` — and the
 * route declares it as `{}`, so comparing the strings misses every call that
 * names a real group. This test shipped with that hole for exactly as long as
 * its own recall case used `${g}`, which is a shape the string compare happens
 * to get right.
 */
export function routeFor(verb: string, path: string, routes: Map<string, Set<string>>): string | undefined {
  const want = segmentsOf(path);
  for (const key of routes.keys()) {
    const [routeVerb, routePath] = key.split(" ") as [string, string];
    if (routeVerb !== verb) continue;
    const have = segmentsOf(routePath);
    if (have.length !== want.length) continue;
    if (have.every((seg, i) => seg === "{}" || seg === want[i])) return key;
  }
  return undefined;
}

/**
 * The routes a looped, templated registration stands for.
 *
 * `for (const decision of ['approve','deny','revoke']) app.post(`…/${decision}`)`
 * is one registration and three routes, and the path is a template rather than
 * a literal, so a split on `app.post('` sees none of them. Those three are the
 * key decision routes: while they were invisible, a fixture posting
 * `{identity, public_key}` at one of them passed this check without a word.
 *
 * The handler has to come with them. Writing out three registration lines and
 * leaving the body attached to the last was worse than not parsing them —
 * two routes then read *no* field, so every caller of them looked wrong.
 */
const LOOPED_REGISTRATION = /for \(const (\w+) of \[([^\]]+)\][^)]*\)\s*\{\s*app\.(get|post|put|delete|patch)\(`([^`]+)`/g;

/** How many write registrations the server has, and how many of them are loops. */
export function registrationSites(source: string): { total: number; looped: number } {
  return {
    total: [...source.matchAll(/app\.(post|put|patch)\(/g)].length,
    looped: [...source.matchAll(new RegExp(LOOPED_REGISTRATION.source, "g"))].length,
  };
}

export function loopedRoutes(source: string): Array<{ key: string; keys: Set<string> }> {
  const out: Array<{ key: string; keys: Set<string> }> = [];
  for (const m of source.matchAll(new RegExp(LOOPED_REGISTRATION.source, "g"))) {
    const [, variable, list, verb, path] = m as unknown as [string, string, string, string, string];
    if (verb === "get" || verb === "delete") continue;
    // The handler runs to the next top-level registration; taking less would
    // drop the field reads this exists to collect.
    const after = source.slice(m.index! + m[0].length);
    const handler = after.slice(0, after.indexOf("\napp.") >= 0 ? after.indexOf("\napp.") : after.length);
    const keys = bodyFieldsIn(handler);
    for (const quoted of list.match(/'([^']+)'/g) ?? []) {
      const value = quoted.slice(1, -1);
      out.push({ key: `${verb.toUpperCase()} ${normalisePath(path.replace("${" + variable + "}", value))}`, keys });
    }
  }
  return out;
}

/** Every body field a handler reads, by property access or by destructuring. */
function bodyFieldsIn(handler: string): Set<string> {
  const keys = new Set<string>();
  for (const m of handler.matchAll(/body\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(m[1]!);
  // `const { subject, capability, scope } = body ?? {}` — the grants routes
  // read this way, and a scan for `body.x` alone called them bodyless.
  for (const m of handler.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*body\b/g)) {
    for (const name of m[1]!.split(",")) {
      const clean = name.split(":")[0]!.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) keys.add(clean);
    }
  }
  return keys;
}

/** What each write route reads, taken from the server rather than from a list beside it. */
export function routesFrom(source: string): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  const parts = source.split(/\napp\.(get|post|put|delete|patch)\('([^']+)'/);
  for (let i = 1; i < parts.length; i += 3) {
    const verb = parts[i]!;
    const path = normalisePath(parts[i + 1]!);
    const handler = parts[i + 2]!;
    if (verb === "get" || verb === "delete") continue;
    const keys = bodyFieldsIn(handler);
    // Kept even when empty: a route that reads no body still answers this verb,
    // and the difference between "reads nothing" and "is not there" is what
    // told the fixture's `PUT .../egress` from a real call.
    routes.set(`${verb.toUpperCase()} ${path}`, keys);
  }
  for (const { key, keys } of loopedRoutes(source)) routes.set(key, keys);
  return routes;
}

export interface Sent {
  verb: string;
  path: string;
  file: string;
  keys: Set<string>;
  /** The route this reaches, or `undefined` when the server answers no such verb here. */
  route: string | undefined;
}

/** True when some other verb serves this path — so the path is this server's, and the verb is the question. */
const pathIsServed = (path: string, routes: Map<string, Set<string>>) =>
  [...routes.keys()].some((k) => routeFor(k.split(" ")[0]!, path, routes) === k);

/**
 * The same text with comment-only lines blanked, offsets untouched.
 *
 * A comment is not a call. `test/fe-render.test.ts` explains the four-month
 * silence by quoting the fields that caused it — `used to send \`name\` and
 * \`members: [...]\`` — directly above the corrected `fetch`, and a scan that
 * reads prose as code answers "the fixture still sends them". The fix belongs
 * here rather than in that comment: the sentence is the only record of why the
 * route changed, and rewording it to suit a parser is fitting the check to the
 * thing it checks.
 *
 * Only whole comment lines, and blanked rather than removed, because every
 * index in this file is an offset into the original — `https://` inside a URL
 * literal is not a comment, and a stripper clever enough to know that is a
 * second parser to get wrong.
 */
export function withoutCommentLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? " ".repeat(line.length) : line))
    .join("\n");
}

/**
 * The remainder of the call the url sits in — up to the `)` that closes it.
 *
 * A fixed-size window is not a call boundary. Eight hundred characters after
 * an egress url ran past the end of the `fetch` and into a block seeding
 * `audit.db`, whose `JSON.stringify({covers, sig})` was then reported as that
 * route's body. Stopping at the next `/api/v1` did not help: there was none in
 * between. The enclosing call ends where its parenthesis does, and nothing
 * else is a boundary.
 */
export function restOfCall(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.slice(from, i);
      depth -= 1;
    } else if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
    }
  }
  return text.slice(from);
}

/** A call that sends an unread field on purpose says so where it sends it. */
export const DELIBERATE = "dropped-fields: sent on purpose";

/** The object literal handed to a helper straight after the url: `setupWrite(what, url, { … })`. */
export function argumentKeys(window: string): Set<string> | null {
  const m = /^\s*,\s*\{/.exec(window);
  if (!m) return null;
  const keys = new Set(topLevelKeys(window, window.indexOf("{", m.index)));
  // `fetch(url, { method, headers, body })` puts an options object here, not a
  // body. Reading it as one reported every upload and every raw `fetch` in the
  // suite as sending `body, headers, method` to a route that reads none of
  // them — a checker inventing findings, which is worse than one inventing
  // silence because someone acts on it.
  if (["method", "headers", "body", "credentials", "signal", "redirect"].some((k) => keys.has(k))) return null;
  return keys;
}

/** Every `POST`/`PUT`/`PATCH` body literal in `sources` that is aimed at a route of this server. */
export function bodiesIn(sources: Array<{ file: string; text: string }>, routes: Map<string, Set<string>>): Sent[] {
  const found: Sent[] = [];
  for (const { file, text: raw } of sources) {
    const text = withoutCommentLines(raw);
    for (const m of text.matchAll(/["'`]([^"'`\n]*?\/api\/v1\/[^"'`\n]*)["'`]/g)) {
      const path = normalisePath(m[1]!);
      const window = restOfCall(text, m.index! + m[0].length);
      const verb = /method:\s*["']?(POST|PUT|PATCH|GET|DELETE|HEAD)/.exec(window)?.[1];
      // A call whose verb is written somewhere else. `setupWrite(what, url, {…})`
      // puts the url and the body in the argument list and the `method` inside
      // the helper, so a scan anchored on `method:` skips the entire fixture —
      // silently, which is the failure this file exists to name.
      const viaHelper = !verb && /^\s*,\s*\{/.test(window);
      if (!verb && !viaHelper) continue;
      if (verb && !["POST", "PUT", "PATCH"].includes(verb)) continue;
      const writeVerbs = ["POST", "PUT", "PATCH"];
      const candidates = verb
        ? [routeFor(verb, path, routes)].filter(Boolean)
        : writeVerbs.map((v) => routeFor(v, path, routes)).filter(Boolean);
      // Two write verbs on one path and no `method:` in sight: which one this
      // reaches is unknowable here, and guessing is what this test is against.
      if (!verb && candidates.length > 1) {
        found.push({ verb: "?", path, file, keys: new Set<string>(), route: undefined });
        continue;
      }
      const route = candidates[0] as string | undefined;
      // Not this server's path at all — the hub answers some of these, and a
      // path served only by GET is not this test's business.
      if (!route && !pathIsServed(path, routes)) continue;
      const keys = stringifiedKeys(window) ?? argumentKeys(window);
      if (!keys || keys.size === 0) continue;
      // The marker sits in a comment, and comments are blanked above, so it is
      // read from the original text at the same offset. A test proving a route
      // ignores a field has to send that field — `grants-routes.test.ts` says
      // so in its own words — and a check that forbids it would be demanding
      // the guard be a no-op.
      const site = raw.slice(Math.max(0, m.index! - 400), m.index! + m[0].length + window.length);
      if (site.includes(DELIBERATE)) continue;
      found.push({ verb: verb ?? "POST", path, file, keys, route });
    }
  }
  return found;
}

function sourcesUnder(dir: string, out: Array<{ file: string; text: string }> = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourcesUnder(full, out);
    else if (/\.tsx?$/.test(name) && full !== join(import.meta.dir, "dropped-fields.test.ts")) {
      out.push({ file: full.slice(ROOT.length + 1), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const ROUTES = routesFrom(readFileSync(SERVER, "utf8"));
/**
 * **The mutation manifest is not a caller.** Every string in it is a quotation
 * of code that lives in another file — `scripts/mutation-check.ts --anchors`
 * refuses any entry whose `from` is not found in the file it names — so the
 * real call is scanned where it actually is, and the quotation here is a second
 * copy with no route behind it. Its `to` halves are worse: mutants, code that
 * exists nowhere, read here as a caller sending a field.
 *
 * It arrived as two rows naming `POST /api/v1/messages` and
 * `POST /api/v1/admin/groups` the day a logout anchor grew long enough to reach
 * a `{ ok: true }`, which is a fact about where a `from` string happened to
 * stop rather than about anything this repository sends.
 */
const QUOTES_SOURCE = join("scripts", "mutation-check.ts");

const SOURCES = ["test", join("packages", "platform-web", "src"), "scripts", join("packages", "http", "src")]
  .flatMap((d) => sourcesUnder(join(ROOT, d)))
  .filter(({ file }) => file !== QUOTES_SOURCE);
const SENT = bodiesIn(SOURCES, ROUTES);

describe("a request body field the route never reads", () => {
  /**
   * The skip above is only sound while the manifest stays a manifest. It runs
   * `bun test` against a mutated tree and reads exit codes; the day it starts
   * calling a route itself, its calls stop being scanned and this file goes on
   * saying every caller was checked.
   *
   * **Checked against invented text as well as the real file**, because a
   * predicate that always answers "no requests here" would pass on the real
   * file forever. It cannot be planted in `scripts/mutation-check.ts` the usual
   * way: an entry that quotes a line of that file *is* a second copy of the
   * line, so the anchor stops being unique and `--anchors` refuses it. The
   * synthetic case is what a mutation would have bought.
   */
  test("the file left out of the scan does not call a route itself", () => {
    /**
     * **String literals removed first, because this file is a quoter.** An
     * entry that plants a discarded `fetch` — `ui-fetch.test.ts` exists for
     * three of them — carries that line into the manifest twice, as `from` and
     * as `to`, and the characters `fetch(` then appear here with no call
     * behind them. Counting them read the manifest as having started making
     * requests on the day an entry quoted one.
     *
     * A call is code. Stripping the strings keeps the question the same one —
     * a `fetch(` written as code in that file is still seen, which is the day
     * this test is about — and stops a quotation from answering it.
     */
    const codeOnly = (text: string) =>
      text
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const requests = (text: string) => codeOnly(text).match(/\bfetch\s*\(/g) ?? [];

    expect(
      requests(readFileSync(join(ROOT, QUOTES_SOURCE), "utf8")),
      "the mutation manifest makes requests now, so leaving it out of the scan leaves those requests unchecked",
    ).toEqual([]);
    expect(
      requests('await fetch("/api/v1/messages", { method: "POST" })').length,
      "the predicate cannot see a request at all, so its silence about the manifest means nothing",
    ).toBe(1);
    expect(
      requests(`  from: "const res = await fetch('/api/v1/admin/approve', { method: 'POST' });",`).length,
      "a quoted line is being counted as a call, which is every entry that plants a request",
    ).toBe(0);
  });

  test("no caller sends one, and no caller writes to a verb this server does not answer", () => {
    const wrong = SENT.flatMap(({ verb, path, file, keys, route }) => {
      if (!route) {
        // Not a dropped field but the same silence: nothing reads the body
        // because nothing answers the call. The fixture's egress rule was set
        // this way and never existed.
        return [`${file} sends ${verb} ${path}, and this server answers no ${verb} there`];
      }
      const read = ROUTES.get(route)!;
      const extra = [...keys].filter((k) => !read.has(k)).sort();
      return extra.length === 0
        ? []
        : [`${file} sends ${extra.join(", ")} to ${route}, which reads ${[...read].sort().join(", ") || "no body field"}`];
    });
    expect([...new Set(wrong)]).toEqual([]);
  });

  // Three ways this could pass while checking nothing, asserted rather than
  // assumed: the route parser matching none, the sender scan matching none,
  // and the sender scan matching only one route's worth.
  test("read both sides before comparing them", () => {
    expect(ROUTES.size, "no write route in main.ts was parsed — the handler pattern stopped matching").toBeGreaterThan(10);
    expect(SENT.length, "no request body was matched to a route — the caller pattern stopped matching").toBeGreaterThan(20);
    expect(new Set(SENT.map((s) => s.path)).size, "every body matched one route, so the scan is narrower than it looks").toBeGreaterThan(4);
  });

  test("accounts for every write registration, or fails naming the shortfall", () => {
    const source = readFileSync(SERVER, "utf8");
    const { total, looped } = registrationSites(source);
    // One parsed route per registration, and one per path a loop stands for.
    // A registration written in a form this file cannot read drops out
    // silently, and every call to it then goes unchecked — not a smaller
    // check, a quieter one. Three key routes were invisible that way while a
    // fixture posted the wrong fields at one of them, and nothing said so
    // because the denominator had shrunk with them.
    const expected = total - looped + loopedRoutes(source).length;
    expect(
      ROUTES.size,
      `main.ts registers ${total} write routes (${looped} of them loops) and this file resolved ` +
        `${ROUTES.size}; the difference is unreadable here and therefore unguarded`,
    ).toBe(expected);
  });

  test("reads a body handed to a helper rather than written at the call site", () => {
    // `setupWrite(what, url, {…})` puts the url and the body in the argument
    // list and the `method` inside the helper. Anchoring on `method:` skipped
    // every setup write in the fixture — not reporting them clean, not seeing
    // them at all.
    const helper = [{
      file: "helper.ts",
      text: 'await setupWrite("approve agent-alpha key", `${u}/api/v1/admin/keys/approve`, {\n' +
        '  identity: "agent-alpha",\n  public_key: keyPairA.publicKey,\n});',
    }];
    const [only] = bodiesIn(helper, ROUTES);
    expect(only, "a body passed as an argument is still a body").toBeDefined();
    expect([...only!.keys].sort()).toEqual(["identity", "public_key"]);
    const read = ROUTES.get(only!.route!)!;
    expect([...only!.keys].filter((k) => !read.has(k)).sort()).toEqual(["identity", "public_key"]);
  });

  test("reports a field that is not read", () => {
    const planted = [{
      file: "planted.ts",
      text: 'await fetch(`${u}/api/v1/admin/groups/${g}/egress`, {\n' +
        '  method: "POST",\n  body: JSON.stringify({ to_group: target, weight: 3 }),\n});',
    }];
    const found = bodiesIn(planted, ROUTES);
    expect(found).toHaveLength(1);
    expect([...found[0]!.keys].sort()).toEqual(["to_group", "weight"]);
    expect(ROUTES.get("POST /api/v1/admin/groups/{}/egress")!.has("weight")).toBe(false);
  });

  test("reports it when the caller writes the parameter out", () => {
    // The shape that escaped: the route says `{}` and the caller says
    // `engineering`, so a string compare finds no route and skips the call
    // silently. Its own recall case used `${g}` and passed.
    const planted = [{
      file: "planted-literal.ts",
      text: 'await fetch(`${u}/api/v1/admin/groups/engineering/egress`, {\n' +
        '  method: "POST",\n  body: JSON.stringify({ allowed_targets: ["security"] }),\n});',
    }];
    const [only] = bodiesIn(planted, ROUTES);
    expect(only?.route).toBe("POST /api/v1/admin/groups/{}/egress");
    expect([...only!.keys]).toEqual(["allowed_targets"]);
  });

  test("reports a verb this server does not answer at that path", () => {
    const planted = [{
      file: "planted-verb.ts",
      text: 'await fetch(`${u}/api/v1/admin/groups/engineering/egress`, {\n' +
        '  method: "PUT",\n  body: JSON.stringify({ allowed_targets: ["security"] }),\n});',
    }];
    const [only] = bodiesIn(planted, ROUTES);
    expect(only, "a PUT to a path this server only serves by POST has to be reported, not skipped").toBeDefined();
    expect(only!.route).toBeUndefined();
  });

  test("does not read a comment as a call", () => {
    // agent-mesh-local-pm raised this against their own commit before it was
    // measured, and then measured it and withdrew it — the comment sits above
    // the call, and the window reads forward. It is still worth closing: the
    // window is 800 characters and the next comment need not be.
    const commented = [{
      file: "commented.ts",
      text: '// this setup used to send name and members to\n' +
        '// `${u}/api/v1/admin/groups` with\n' +
        '//   body: JSON.stringify({ group_id: g, name: "E", members: ["a"] }),\n' +
        'await fetch(`${u}/api/v1/admin/groups`, {\n' +
        '  method: "POST",\n  body: JSON.stringify({ group_id: g, description: d }),\n});',
    }];
    const found = bodiesIn(commented, ROUTES);
    expect(found).toHaveLength(1);
    expect([...found[0]!.keys].sort()).toEqual(["description", "group_id"]);
  });

  test("the marker silences its own call site and nothing else", () => {
    const body = 'await setupWrite("x", `${u}/api/v1/admin/groups/engineering/egress`, { to_group: "s", weight: 3 });';
    const bare = bodiesIn([{ file: "bare.ts", text: body }], ROUTES);
    expect([...bare[0]!.keys].sort(), "without the marker the extra field is still a finding").toEqual(["to_group", "weight"]);

    const marked = bodiesIn([{ file: "marked.ts", text: `// ${DELIBERATE} — proving the route ignores it\n${body}` }], ROUTES);
    expect(marked, "the marker suppresses the call it sits above").toHaveLength(0);

    // A marker somewhere else in the file must not cover this call: an
    // exemption that spreads is an ignore list wearing a comment.
    const elsewhere = `// ${DELIBERATE}\n${"const filler = 1;\n".repeat(40)}${body}`;
    expect(bodiesIn([{ file: "elsewhere.ts", text: elsewhere }], ROUTES), "a distant marker covers nothing").toHaveLength(1);
  });

  test("leaves a body alone when every field is read", () => {
    const clean = [{
      file: "clean.ts",
      text: 'await fetch(`${u}/api/v1/admin/agent-types`, {\n' +
        '  method: "POST",\n  body: JSON.stringify({ type: "worker", description: "d", requires_key: true }),\n});',
    }];
    const [only] = bodiesIn(clean, ROUTES);
    const read = ROUTES.get("POST /api/v1/admin/agent-types")!;
    expect([...only!.keys].filter((k) => !read.has(k))).toEqual([]);
  });
});

describe("the parser this rests on", () => {
  const keysOf = (src: string) => stringifiedKeys(src);

  test("counts a value identifier as a value, not a key", () => {
    // `{ github_login: login }` read as two keys reported six clean routes as
    // broken. The first version of this parser did exactly that, and passed a
    // self-check whose every value happened to be a string or an array.
    expect(keysOf("JSON.stringify({ github_login: login })")).toEqual(new Set(["github_login"]));
    expect(keysOf("JSON.stringify({ group_id: groupId, description: desc })")).toEqual(new Set(["group_id", "description"]));
    expect(keysOf("JSON.stringify({ a: fn(x, y), b: cond ? p : q })")).toEqual(new Set(["a", "b"]));
  });

  test("keeps shorthand, and does not descend into a nested literal", () => {
    expect(keysOf('JSON.stringify({ identity, ttl_seconds: ttlSeconds })')).toEqual(new Set(["identity", "ttl_seconds"]));
    expect(keysOf('JSON.stringify({ to, text: "x", attachments: [{ id: aId, download_url: `u` }] })'))
      .toEqual(new Set(["to", "text", "attachments"]));
  });

  test("answers nothing for a body that is not a literal", () => {
    // Reading past this found the next `{` in the file and attributed its keys
    // to this route — `sendMessageApi` posts `JSON.stringify(payload)`.
    expect(keysOf("JSON.stringify(payload),\n  });\n}\nconst res = { messages: 1 }")).toBeNull();
    expect(keysOf("no call here at all")).toBeNull();
  });

  test("resolves the three key routes registered in a loop", () => {
    // `for (const decision of ['approve','deny','revoke'])` — one registration,
    // three routes, and a path that is a template rather than a literal.
    for (const decision of ["approve", "deny", "revoke"]) {
      expect(ROUTES.get(`POST /api/v1/admin/keys/${decision}`), `no route parsed for ${decision}`)
        .toEqual(new Set(["fingerprint", "reason"]));
    }
  });

  test("finds the grants routes, which read their body by destructuring it", () => {
    expect(ROUTES.get("POST /api/v1/admin/grants")).toEqual(new Set(["subject", "capability", "scope"]));
  });
});

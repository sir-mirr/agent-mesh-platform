/**
 * Every route a document names is a route the mesh serves.
 *
 * `agent-mesh-local-pm` found five documents calling `GET /api/v1/admin/inbox`
 * ten times between them. It answers `404` — it shipped as `admin/mailbox`, and
 * the proposal that named it `inbox` predates the rename. Nobody was wrong on
 * the day they wrote it, and nothing since could say it had gone stale: the
 * check needed a running server, so it happened once, months later, by hand.
 *
 * **This asks the routes instead of reading for them.** A first attempt scanned
 * the source for path literals and reported 92 offenders, nearly all of them
 * real routes, because this mesh declares them three ways: Hono literals in
 * `agent-mesh-http`, `url.pathname === "…"` and `startsWith`/`endsWith` pairs in
 * the hub's hand-rolled router, and — the one no scan will ever find —
 * `app.post(\`/api/v1/admin/keys/${'${decision}'}\`)` inside a loop. A check that
 * cannot be made right by reading can still be made right by asking.
 *
 * Asking is only possible because `main.ts` separates being loaded from being
 * the program: `app.fetch(request)` runs the whole handler stack in this
 * process, with no port and no hub.
 *
 * `401`/`403` mean the route is there and refused an unauthenticated caller,
 * which is the answer this file wants. Only `404` is a missing route.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Three levels up: this file sits beside the service it asks, for the same
// reason `main.in-process.test.ts` does — a project that imports a file outside
// its own directory has to contain that file, and listing `main.ts` in
// `test/tsconfig.json` pulled in its whole import graph, one TS6307 at a time.
const ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * `docs/proposals/` is exempt: a proposal records what was proposed, and some
 * of it was never built. One directory, named here — anything finer and the
 * denominator shrinks quietly, which is how three of this repository's scans
 * went green while the product was not.
 */
const EXEMPT = [
  // A proposal records what was proposed, and some of it was never built.
  "docs/proposals/",
  // `scripts/mail-to-*.md` are drafts of mail already sent. Editing one to
  // match today's routes would be rewriting a message somebody received.
  "scripts/mail-to-",
];

/**
 * The hub serves some of them, and it is not importable here — its entrypoint
 * still binds a socket on load, unlike `agent-mesh-http`. So its paths are read
 * out of its dispatcher rather than asked, which is the weaker half of this
 * check and says so. It compares `url.pathname` against literals and takes
 * prefixes of it; both shapes are matched.
 */
function hubPaths(): string[] {
  const dir = join(ROOT, "packages", "hub", "src");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((e) => {
      const full = join(d, e);
      return statSync(full).isDirectory() ? walk(full) : /\.ts$/.test(full) && !/\.test\./.test(full) ? [full] : [];
    });
  const found = new Set<string>();
  for (const file of walk(dir)) {
    for (const m of readFileSync(file, "utf8")
      .matchAll(/pathname\s*(?:===|==|\.startsWith\(|\.endsWith\()\s*['"`](\/[^'"`]*)['"`]/g)) {
      found.add(m[1]!);
    }
  }
  return [...found];
}

const HUB = hubPaths();

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") return [];
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? markdown(full) : full.endsWith(".md") ? [full] : [];
  });
}

/** A path named in prose, with the punctuation a sentence puts around it. */
function routesIn(line: string): string[] {
  return [...line.matchAll(/`?(\/api\/v1\/[A-Za-z0-9_\-{}:/]+)`?/g)]
    .map((m) => m[1]!.replace(/[.,;:)]+$/, ""))
    .filter((p) => !p.endsWith("/"));
}

/** `{identity}` and `:identity` both stand for a value; give the route one. */
const concrete = (path: string) =>
  path.replace(/\{[^}]+\}/g, "probe").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "probe");

const mentioned = new Map<string, string[]>();
for (const file of markdown(ROOT)) {
  const relative = file.slice(ROOT.length + 1);
  if (EXEMPT.some((prefix) => relative.startsWith(prefix))) continue;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    // **Prose may name the mistake — that is how the reason survives.** The
    // same carve-out `greppable.test.ts` makes for source comments: a `#` line
    // is a heading or a comment inside a shell block, and one of them exists
    // precisely to record that `/api/v1/audit/stream` was a path this
    // repository never served.
    if (/^\s*#/.test(line)) return;
    for (const route of routesIn(line)) {
      const where = mentioned.get(route) ?? [];
      where.push(`${relative}:${i + 1}`);
      mentioned.set(route, where);
    }
  });
}

// The service refuses to load without a signing secret, which is the right
// refusal — a default one would mean anybody who has read the file can forge a
// session. Nothing here signs anything; the value only has to exist.
process.env.JWT_SECRET ||= "documented-routes-probe";

const app = (await import("./main.ts")).app;

describe("routes named in documentation", () => {
  test("the documents were actually read", () => {
    // A walk that stopped matching would make the assertion below vacuous,
    // which is the failure mode of a check that derives its own denominator.
    expect(mentioned.size).toBeGreaterThan(20);
  });

  test("every one of them answers something other than not-found", async () => {
    const offenders: string[] = [];
    for (const [route, where] of mentioned) {
      if (HUB.some((p) => route === p || route.startsWith(`${p}/`) || p.startsWith(route))) continue;
      // **Every verb, because a path is only served under some of them.** Hono
      // answers `404` for a `GET` on a delete-only route, not `405`, so asking
      // one way reported forty-one routes missing that are all there.
      //
      // Unauthenticated on purpose: every admin route refuses before it acts —
      // `auth-sweep` holds them to that — so a `DELETE` here reaches a guard
      // and not a table. `401` and `403` are the answers this file wants.
      let served = false;
      for (const method of ["GET", "POST", "DELETE", "PUT"]) {
        const res = await app.fetch(new Request(`http://documented${concrete(route)}`, { method }));
        if (res.status !== 404) { served = true; break; }
      }
      if (!served) offenders.push(`${route} — named at ${where.join(", ")}`);
    }
    expect(offenders, "a document names a route this mesh does not serve").toEqual([]);
  });
});

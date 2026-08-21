/**
 * The operations document, held to the source it describes (T-022).
 *
 * `docs/LOGGING-OPS.md` tells an operator which `event` to grep for when
 * somebody says their message never arrived, that they cannot sign in, or that
 * they got no notification. Every one of those names is a string literal in a
 * service, and a rename is invisible to the document — the reader greps, finds
 * nothing, and reads *nothing went wrong*, which is the exact failure the whole
 * of T-022 is about.
 *
 * `test/readme.test.ts` holds `running-locally.md`'s quoted output the same way
 * and for the same reason. This is that check, pointed at the names rather than
 * at the lines.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOC = readFileSync(join(ROOT, "docs", "LOGGING-OPS.md"), "utf8");

/** Every `.ts` under `packages/`, minus the tests and the browser bundle. */
function serviceSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "ui") return [];
      return serviceSources(full);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const SOURCE = serviceSources(join(ROOT, "packages")).map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * The names the document tells somebody to grep for.
 *
 * Three shapes appear: `"event":"x"` inside a quoted command, a bare `` `x` ``
 * opening a table row, and `` `x` · `y` `` where a row names an event and one
 * of its reasons. The table forms are where a name rots unnoticed, because
 * nothing about them looks like code.
 *
 * The row form is taken only when the name carries an underscore. The other
 * tables here open with a field (`id`, `actor`) or a level (`warn`), which are
 * documented in their own right and are not names to grep for.
 */
const NAMED = [
  ...new Set([
    ...[...DOC.matchAll(/"event":"([a-z0-9_]+)"/g)].map((m) => m[1]!),
    ...[...DOC.matchAll(/^\| `([a-z0-9]+_[a-z0-9_]*)`/gm)].map((m) => m[1]!),
    ...[...DOC.matchAll(/`([a-z0-9_]+)` · `([a-z0-9_]+)`/g)].map((m) => m[1]!),
  ]),
];

/** The reasons it tells somebody to read, in the same two shapes. */
const REASONS = [
  ...new Set([...DOC.matchAll(/`[a-z0-9_]+` · `([a-z0-9_]+)`/g)].map((m) => m[1]!)),
];

describe("the logging operations document", () => {
  test("names enough events to be worth checking", () => {
    // A pattern that went stale would agree with every assertion below it.
    expect(NAMED.length).toBeGreaterThan(12);
    expect(REASONS.length).toBeGreaterThan(4);
  });

  test("every event it tells an operator to grep for is one a service emits", () => {
    const missing = NAMED.filter((event) => !SOURCE.includes(`"${event}"`) && !SOURCE.includes(`'${event}'`));
    expect(missing, "the document names an event no service writes").toEqual([]);
  });

  test("every reason it tells an operator to read is one a service writes", () => {
    const missing = REASONS.filter((r) => !SOURCE.includes(`"${r}"`) && !SOURCE.includes(`'${r}'`));
    expect(missing, "the document names a reason no service writes").toEqual([]);
  });

  test("the five counters it names are all in it", () => {
    for (const counter of ["lease_expired", "frame_dropped", "push_failed", "audit_gap_fetch", "wal_recovered"]) {
      expect({ counter, named: NAMED.includes(counter) }).toEqual({ counter, named: true });
    }
  });

  test("its example line is the shape the logger renders", () => {
    const [example] = [...DOC.matchAll(/^(\d{4}-\d\d-\d\dT\S+ (?:error|warn|info) \[[a-z-]+\] .*)$/gm)].map((m) => m[1]!);
    expect(example, "the document shows no example line").toBeDefined();

    const cut = example!.lastIndexOf(' {"ts":"');
    expect(cut, "the example carries no machine half").toBeGreaterThan(0);
    const payload = JSON.parse(example!.slice(cut + 1));
    // The head is a rendering of the payload, not a second copy — so the three
    // fields that appear in both have to agree in the document too.
    expect(example!.startsWith(`${payload.ts} ${payload.level} [${payload.component}] `)).toBe(true);
    expect(payload.event).toBe("send_refused");
  });

  test("the levels it documents are the levels the logger has", () => {
    const declared = /export type Level = ([^;]+);/.exec(
      readFileSync(join(ROOT, "packages", "log", "src", "index.ts"), "utf8"),
    );
    expect(declared, "the Level type moved or was renamed").not.toBeNull();
    const levels = [...declared![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    expect(levels.length).toBeGreaterThan(1);
    for (const level of levels) {
      expect({ level, documented: DOC.includes(`| \`${level}\` |`) }).toEqual({ level, documented: true });
    }
  });

  test("the bound it quotes for a reason is the bound the logger applies", () => {
    const source = readFileSync(join(ROOT, "packages", "log", "src", "index.ts"), "utf8");
    const applied = /const BOUNDED_REASON = (\/[^\n]+\/);/.exec(source);
    expect(applied, "BOUNDED_REASON moved or was renamed").not.toBeNull();
    expect(DOC).toContain(applied![1]!);
  });

  test("the environment variable it names is the one the services read", () => {
    expect(DOC).toContain("AGENT_MESH_COUNTER_SNAPSHOT_MS");
    expect(SOURCE).toContain("AGENT_MESH_COUNTER_SNAPSHOT_MS");
  });
});

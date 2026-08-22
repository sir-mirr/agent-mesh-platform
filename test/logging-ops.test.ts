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
import { readdirSync, readFileSync } from "node:fs";
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

  test("the six counters it names are all in it", () => {
    for (const counter of ["lease_expired", "frame_dropped", "push_failed", "audit_gap_fetch", "wal_recovered", "hub_disconnected"]) {
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

  /**
   * The units set no `StandardOutput`/`StandardError`, so systemd's default
   * sends both streams to the journal with their priorities intact. An
   * override to a file would split the record in two and quietly undo the
   * reason `warn` and `error` go to stderr at all.
   */
  test("no unit file redirects a stream away from the journal", () => {
    const unitDir = join(ROOT, "ops", "systemd");
    const units = readdirSync(unitDir).filter((f) => f.endsWith(".service"));
    expect(units.length, "no unit files found — the path went stale").toBeGreaterThan(2);

    const redirected = units.filter((f) =>
      /^\s*Standard(Output|Error)\s*=/m.test(readFileSync(join(unitDir, f), "utf8")),
    );
    expect(redirected, "a unit sends its output somewhere other than the journal").toEqual([]);
  });

  /**
   * **Every `reason` a service writes is a key a counter can hold.**
   *
   * The map is keyed on `(component, event, reason)`, so a reason assembled
   * from a request — a database's error text, an address, a filename — is a map
   * that grows at whatever rate the caller chooses. The logger's answer is to
   * count anything unbounded as `other` while still printing it in full, which
   * keeps the memory safe and makes the counter useless in exactly the case
   * somebody is reading it. Better to know at the source.
   *
   * Only `reason:` inside a `log.*(...)` call. The word is also a field on
   * ordinary domain objects here — `ProvisionOutcome.reason` is a sentence for
   * a person, `PushFailure.reason` names a status — and those are right to be
   * prose. `push.ts` shows the shape this checks for: `reason: "endpoint_gone"`
   * for the counter, and the sentence beside it in `detail`.
   */
  test("every reason a service logs is one a counter can key on", () => {
    const bound = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
    const offenders: string[] = [];

    /**
     * One interpolated reason is allowed, because its interpolation is a
     * union of three words. Named rather than pattern-matched: a list of one
     * is honest about how special it is, and the next one has to be argued.
     */
    const BOUNDED_TEMPLATE = "key_${outcome.keyStatus}";

    for (const file of serviceSources(join(ROOT, "packages"))) {
      const src = readFileSync(file, "utf8");
      for (const call of [...src.matchAll(/\blog\.(error|warn|info)\(/g)]) {
        // The call's own arguments and not the next call's: balanced from the
        // opening paren, minding strings so a `)` inside one does not close it.
        let depth = 1;
        let i = call.index! + call[0].length;
        let quote: string | null = null;
        while (i < src.length && depth > 0) {
          const c = src[i]!;
          if (quote) {
            if (c === "\\") { i += 2; continue; }
            if (c === quote) quote = null;
          } else if (c === '"' || c === "'" || c === "`") quote = c;
          else if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") depth--;
          i++;
        }
        const args = src.slice(call.index! + call[0].length, i - 1);

        // **The whole value, not the first quote after the colon.** A first
        // version required `reason:` to be followed immediately by a string
        // and so read nothing at all in `reason: drop ? "a" : "b"` — the exact
        // line the mutation for this test changes. It passed by not looking.
        for (const m of args.matchAll(/\breason:\s*/g)) {
          const rest = args.slice(m.index! + m[0].length);
          let end = 0, d = 0, q: string | null = null;
          while (end < rest.length) {
            const c = rest[end]!;
            if (q) {
              if (c === "\\") { end += 2; continue; }
              if (c === q) q = null;
            } else if (c === '"' || c === "'" || c === "`") q = c;
            else if (c === "(" || c === "[" || c === "{") d++;
            else if (c === ")" || c === "]" || c === "}") { if (d === 0) break; d--; }
            else if (c === "," && d === 0) break;
            end++;
          }
          const value = rest.slice(0, end).trim();
          const where = file.slice(ROOT.length + 1);

          const literals = [...value.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2]!);
          for (const lit of literals) {
            if (!bound.test(lit)) offenders.push(`${where} logs reason ${JSON.stringify(lit)}`);
          }
          for (const t of [...value.matchAll(/`([^`]*)`/g)].map((x) => x[1]!)) {
            if (t.includes("${") && t !== BOUNDED_TEMPLATE) {
              offenders.push(`${where} builds reason \`${t}\`, which the caller can grow`);
            } else if (!t.includes("${") && !bound.test(t)) {
              offenders.push(`${where} logs reason \`${t}\``);
            }
          }
          // A bare identifier — `reason: verdict.reason` — is checked where it
          // is produced, not here. `SignatureRefusal` is the example: a union
          // of seven words, named at the refusal rather than read back off a
          // message, which is how one of the seven came to be unreachable.
          if (literals.length === 0 && !value.includes("`") && !value) {
            offenders.push(`${where} logs an empty reason`);
          }
        }
      }
    }

    // The scan itself has to be finding something, or it agrees with anything.
    const counted = [...SOURCE.matchAll(/\blog\.(?:error|warn|info)\(/g)].length;
    expect(counted, "no log calls were found — the pattern went stale").toBeGreaterThan(50);
    // And it has to be reading the values, not just finding the word.
    expect(SOURCE).toContain('reason: drop ? "endpoint_gone" : "push_service_error"');
    expect(offenders, "a logged reason cannot be a counter key, so it is counted as `other`").toEqual([]);
  });

  test("the environment variable it names is the one the services read", () => {
    expect(DOC).toContain("AGENT_MESH_COUNTER_SNAPSHOT_MS");
    expect(SOURCE).toContain("AGENT_MESH_COUNTER_SNAPSHOT_MS");
  });
});

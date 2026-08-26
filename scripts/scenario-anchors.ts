/**
 * Which scenarios a planted mutation would actually take down.
 *
 * The browser sweep is driven by a list of scenarios nothing in the manifest
 * points at, and that list was being produced by a shell one-liner that
 * grepped the manifest for the scenario **id**. Most entries do not carry
 * one: `expect` matches the mutated run's output, which is the *test name*,
 * and a name is usually quoted without its `[SC-…]` prefix. So the one-liner
 * called `SC-ADDR-02` unproven while `invented-fingerprint-onscreen` had been
 * pinning it for weeks, and two of a morning's seven entries were written for
 * scenarios that already had one.
 *
 * A miscounted denominator is the same defect as an assertion that cannot
 * fail, one level up: it does not report an error, it reports work to do that
 * is already done, and nobody checks a number that only ever goes down.
 *
 * This resolves the pairing the way the sweep does — a scenario is **pinned**
 * when some entry on **its own suite** carries an `expect` phrase that the
 * scenario's full title contains, or one that names its id.
 *
 * **Pinned is a claim, not a verdict.** An entry pins a scenario the moment it
 * is written; whether that mutation actually takes the scenario down is known
 * only after the manifest runs it, and an entry whose phrase names the wrong
 * test records `uncaught` there. Reading this file's count as *proven* would
 * be the same error as the one-liner it replaces, one level up — fe-codex
 * caught it doing exactly that while seven entries were still mid-run.
 *
 * `--from-log <file>` splits the two: it reads a mutation-check run's ✓/✗
 * lines and reports which pins that run actually observed. There is no durable
 * verdict store — `readVerdict` interprets one run's output and keeps nothing —
 * so a log is the only record of an observation short of adding one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MUTATIONS } from "./mutation-check.ts";

const root = join(import.meta.dir, "..");

/** Every suite that holds scenarios, found rather than listed. */
const suites: string[] = [];
for (const file of readdirSync(join(root, "test"))) {
  if (file.endsWith(".test.ts")) suites.push(`test/${file}`);
}

type Scenario = { id: string; title: string; suite: string };
const scenarios: Scenario[] = [];
/** Scenario headers this parse could not read — a denominator that shrinks goes quiet. */
const unparsed: string[] = [];

for (const suite of suites) {
  const text = readFileSync(join(root, suite), "utf8");
  const declared = [...text.matchAll(/\bit\([^\n]*\[SC-[A-Z0-9]+-\d+\]/g)].length;
  let read = 0;
  for (const m of text.matchAll(/\bit\(\s*"(\[(SC-[A-Z0-9]+-\d+)\][^"]*)"/g)) {
    scenarios.push({ id: m[2]!, title: m[1]!, suite });
    read += 1;
  }
  if (read !== declared) unparsed.push(`${suite}: ${declared} headers, ${read} read`);
}

/** Entry ids a mutation-check log recorded as caught, when one is given. */
const observed = (() => {
  const flag = process.argv.indexOf("--from-log");
  if (flag < 0) return null;
  const path = process.argv[flag + 1];
  if (!path) {
    console.error("--from-log needs a file");
    process.exit(2);
  }
  const caught = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*✓\s+(\S+)/.exec(line);
    if (m) caught.add(m[1]!);
  }
  return caught;
})();

const proofs = new Map<string, string[]>();
/** Phrases that name more than one scenario cannot say which one went red. */
const ambiguous: string[] = [];

for (const entry of MUTATIONS) {
  for (const phrase of entry.expect) {
    const hits = scenarios.filter(
      (s) => s.suite === entry.suite && (s.title.includes(phrase) || phrase.includes(s.id)),
    );
    if (hits.length > 1) ambiguous.push(`${entry.id}: "${phrase}" names ${hits.map((h) => h.id).join(", ")}`);
    for (const hit of hits) {
      const list = proofs.get(hit.id) ?? [];
      list.push(entry.id);
      proofs.set(hit.id, list);
    }
  }
}

const ids = [...new Set(scenarios.map((s) => s.id))].sort();
const unpinned = ids.filter((id) => !proofs.has(id));
/** Pinned by an entry some run in the given log recorded as caught. */
const seen = observed === null
  ? null
  : ids.filter((id) => (proofs.get(id) ?? []).some((entry) => observed.has(entry)));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(
    { scenarios: ids.length, pinned: ids.length - unpinned.length, unpinned, observed: seen?.length ?? null },
    null,
    2,
  ));
} else {
  console.log(`scenarios: ${ids.length}  pinned: ${ids.length - unpinned.length}  unpinned: ${unpinned.length}`);
  if (seen !== null) console.log(`observed caught in that log: ${seen.length}`);
  if (unparsed.length) {
    console.log("\nheaders this parse could not read:");
    for (const line of unparsed) console.log(`  ${line}`);
  }
  if (ambiguous.length) {
    console.log("\nphrases that name more than one scenario:");
    for (const line of ambiguous) console.log(`  ${line}`);
  }
  console.log(`\nunpinned:\n${unpinned.join(" ")}`);
}

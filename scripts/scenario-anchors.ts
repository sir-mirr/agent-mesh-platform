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
 * This resolves the pairing the way the sweep does — a scenario is proven when
 * some entry on **its own suite** carries an `expect` phrase that the
 * scenario's full title contains, or one that names its id. Reporting only:
 * the gate on this is the manifest itself, which fails when an entry's phrase
 * does not appear in the mutated run's output.
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
const unproven = ids.filter((id) => !proofs.has(id));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ scenarios: ids.length, proven: ids.length - unproven.length, unproven }, null, 2));
} else {
  console.log(`scenarios: ${ids.length}  proven: ${ids.length - unproven.length}  unproven: ${unproven.length}`);
  if (unparsed.length) {
    console.log("\nheaders this parse could not read:");
    for (const line of unparsed) console.log(`  ${line}`);
  }
  if (ambiguous.length) {
    console.log("\nphrases that name more than one scenario:");
    for (const line of ambiguous) console.log(`  ${line}`);
  }
  console.log(`\nunproven:\n${unproven.join(" ")}`);
}

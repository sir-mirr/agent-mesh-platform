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
import { caughtInLog } from "./caught-in-log.ts";

/**
 * The tree to read, so this reader can be pointed at a fixture.
 *
 * **Nothing ran this but a person.** It was in no CI job, no `verify` step and
 * no other script — so the morning its id pattern could not see `SC-USER-D4`,
 * the only thing that noticed was a total that failed to move, and the only
 * reason anyone looked was that the number was about to be reported. A reader
 * whose output goes into a report to the owner needs a test, and a test needs
 * a tree it controls.
 */
const rootFlag = process.argv.indexOf("--root");
const root = rootFlag >= 0 ? (process.argv[rootFlag + 1] ?? join(import.meta.dir, "..")) : join(import.meta.dir, "..");

/**
 * **A letter in the number is still a number.** The id pattern read
 * `SC-[A-Z0-9]+-\d+` and every `SC-USER-B1 … B5` and `SC-USER-D1 … D5` fell
 * through it — ten scenarios, none of them counted, none of them reported as
 * unpinned, and none of them named by the `unparsed` guard either, because
 * that guard counted headers with the same pattern that could not see them.
 * A denominator and its own tripwire derived from one expression agree with
 * each other whatever they miss.
 *
 * Found when `fe-codex` landed `SC-USER-D4`/`D5` and the total did not move.
 */
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
  /**
   * **Widened twice, and the second time by a fixture rather than by luck.**
   *
   * It read `SC-[A-Z0-9]+-\d+` and missed every `SC-USER-D4` — a letter in the
   * number. Widening that to `[A-Z]*\d+` still missed `SC-API-AUTH-01`, which
   * has three segments, and `SC-DOWN-ALL`, which has no number at all: four
   * more scenarios absent from a denominator that had just been corrected and
   * reported. An id is segments joined by hyphens, so that is what this matches
   * now, and neither reader below carries an opinion about what a segment
   * contains.
   *
   * The two readings differ in kind rather than in quoting: one scans lines
   * that register a scenario, the other reads titles. A pattern narrowed in one
   * place therefore shows up as a disagreement instead of as a smaller number
   * that agrees with itself.
   */
  const declared = text
    .split("\n")
    .filter((line) => /\bit(?:\.skip)?\(/.test(line) && /\[SC-[A-Z0-9]+(?:-[A-Z0-9]+)+\]/.test(line)).length;
  let read = 0;
  // Both quote styles: thirteen `SC-DOWN-ALL` registrations are template
  // literals because the route is interpolated into the title, and a reader
  // that requires a double quote calls every one of them unreadable.
  for (const m of text.matchAll(/\bit\(\s*["`](\[(SC-[A-Z0-9]+(?:-[A-Z0-9]+)+)\][^"`]*)["`]/g)) {
    scenarios.push({ id: m[2]!, title: m[1]!, suite });
    read += 1;
  }
  if (read !== declared) unparsed.push(`${suite}: ${declared} headers, ${read} read`);
}

/**
 * Entry ids recorded as caught across every log given, when any is.
 *
 * Repeatable, because the nightly is eight shards and a night is only measured
 * once all eight have been read together. One shard's log answers for an
 * eighth of the manifest and says nothing about the rest.
 */
const observed = (() => {
  const paths = process.argv.flatMap((arg, i) => (arg === "--from-log" ? [process.argv[i + 1]] : []));
  if (paths.length === 0) return null;
  const caught = new Set<string>();
  for (const path of paths) {
    if (!path) {
      console.error("--from-log needs a file");
      process.exit(2);
    }
    for (const id of caughtInLog(readFileSync(path, "utf8"))) caught.add(id);
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

/**
 * Scenarios no product mutation can take down, with the reason each one is
 * exempt rather than owed.
 *
 * **The unpinned list is a work queue, and a work queue with permanent
 * residents stops being read.** These do not assert anything about the
 * product: mutate any line of it and they stay green, correctly, because what
 * they check is the harness that runs everything else. Counting them as debt
 * says there is work here that nobody can do.
 *
 * Kept short and reasoned on purpose — this is an exemption list, which is the
 * shape a check gets weakened through. Two rules keep it honest, both enforced
 * below: an id that is not a scenario is a typo, and an id that some entry
 * *does* pin means the exemption was wrong and is reported rather than
 * silently obeyed.
 */
const NOT_A_PRODUCT_GUARD: Record<string, string> = {
  "SC-HARNESS-01": "asserts the harness object itself — that `mesh.http.url` and `mesh.hub.url` were handed over. No line of the product appears in it.",
};

const ids = [...new Set(scenarios.map((s) => s.id))].sort();
const unpinnedAll = ids.filter((id) => !proofs.has(id));
const unpinned = unpinnedAll.filter((id) => !(id in NOT_A_PRODUCT_GUARD));
const exempt = unpinnedAll.filter((id) => id in NOT_A_PRODUCT_GUARD);
/** An exemption that names nothing, or names something an entry already pins. */
const staleExemptions = Object.keys(NOT_A_PRODUCT_GUARD).flatMap((id) => {
  if (!ids.includes(id)) return [`${id}: no scenario by that id`];
  if (proofs.has(id)) return [`${id}: pinned by ${(proofs.get(id) ?? []).join(", ")} — the exemption is wrong`];
  return [];
});
/**
 * Pinned by an entry a run could actually plant.
 *
 * **A retired entry pins nothing a night can confirm.** `retired` keeps the
 * reasoning where somebody looking for that defect will find it, and it carries
 * no `from` — so no run ever ticks it, and a scenario whose only pin is retired
 * can never be observed however green the night was. `SC-INVENT-01` is in
 * exactly that state, and comparing `observed` against `pinned` would have
 * failed the nightly's summary on every perfect night: 173 against 174.
 *
 * That is the difference this file exists to draw, one level in. `pinned` is
 * the claim; this is the part of the claim a run can answer.
 */
const plantable = new Set(MUTATIONS.filter((m) => m.from).map((m) => m.id));
const provableIds = ids.filter((id) => (proofs.get(id) ?? []).some((entry) => plantable.has(entry)));
/** Pinned, and only by entries no run can plant. */
const pinnedOnlyByRetired = ids.filter(
  (id) => proofs.has(id) && !(proofs.get(id) ?? []).some((entry) => plantable.has(entry)),
);

/** Pinned by an entry some run in the given log recorded as caught. */
const seen = observed === null
  ? null
  : ids.filter((id) => (proofs.get(id) ?? []).some((entry) => observed.has(entry)));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(
    {
      scenarios: ids.length,
      pinned: ids.length - unpinnedAll.length,
      unpinned,
      exempt,
      staleExemptions,
      // **The tripwires travel with the numbers.** They were printed for a
      // person and left out of the machine-readable summary, which is the same
      // shape as the defect they exist to catch: whoever reads the JSON reads a
      // denominator with no way to ask whether it was complete.
      unparsed,
      ambiguous,
      // What a night can answer. `pinned` counts a scenario whose only entry
      // is retired; no run can tick that entry, so a summary comparing an
      // observation against `pinned` fails on a perfect night.
      provable: provableIds.length,
      pinnedOnlyByRetired,
      observed: seen?.length ?? null,
    },
    null,
    2,
  ));
} else {
  console.log(
    `scenarios: ${ids.length}  pinned: ${ids.length - unpinnedAll.length}  unpinned: ${unpinned.length}` +
      (exempt.length ? `  (+${exempt.length} no product mutation can reach)` : ""),
  );
  if (staleExemptions.length) {
    console.log("\nexemptions that are wrong:");
    for (const line of staleExemptions) console.log(`  ${line}`);
  }
  if (exempt.length) {
    console.log("\nnot a product guard:");
    for (const id of exempt) console.log(`  ${id} — ${NOT_A_PRODUCT_GUARD[id]}`);
  }
  if (pinnedOnlyByRetired.length) {
    console.log("\npinned only by an entry no run can plant:");
    for (const id of pinnedOnlyByRetired) console.log(`  ${id} — ${(proofs.get(id) ?? []).join(", ")} carries no \`from\``);
  }
  if (seen !== null) console.log(`observed caught in that log: ${seen.length} of ${provableIds.length} a run can answer for`);
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

/**
 * Disagreement between this reader's two readings is a failure, not a note.
 *
 * `unpinned` is a work queue and stays a report — an unpinned scenario is work
 * somebody has to do, and failing on it would make every new scenario a red
 * tree for whoever wrote it. These three are different: they say this file
 * could not read what it was counting, or that its exemption list has gone
 * stale. A number produced under either is not a number, and it was being
 * printed in the same tone as one that is.
 */
if (unparsed.length || ambiguous.length || staleExemptions.length) process.exit(1);

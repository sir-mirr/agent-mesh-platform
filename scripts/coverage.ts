/**
 * The coverage number, and what is not in it.
 *
 * `bun test --coverage` has no path-ignore option — `--coverage-reporter` and
 * `--coverage-dir` are the whole surface — so an exclusion has to happen after
 * the fact. Doing it here rather than in a config key means it can be *counted*:
 * this prints the number with the excluded files and the number without, so a
 * reader can see what the exclusion is worth rather than taking the smaller
 * denominator on trust.
 *
 * `packages/http/src/ui/` is excluded by the owner's decision, relayed through
 * `agent-mesh-local-pm`. The four files there are server-rendered HTML —
 * `chat.ts` alone is over a thousand lines of template — reached by a browser
 * rather than by a caller.
 *
 * **Bun reports only the files a test loaded.** A file nobody imports is absent
 * from the report, not `0%`, so the fastest way to raise this number is to stop
 * importing the hard parts. `packages/platform-web/src/every-module.test.ts`
 * exists to stop that, and this script prints the file count beside the
 * percentage for the same reason.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Excluded from the denominator, by decision rather than by accident. */
const EXCLUDED = [/^packages\/http\/src\/ui\//];

type FileCoverage = { path: string; lines: number; hit: number; funcs: number; funcsHit: number };

/** One record per file, out of an lcov report. */
function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { path: line.slice(3).trim(), lines: 0, hit: 0, funcs: 0, funcsHit: 0 };
    } else if (!current) {
      continue;
    } else if (line.startsWith("LF:")) current.lines = Number(line.slice(3));
    else if (line.startsWith("LH:")) current.hit = Number(line.slice(3));
    else if (line.startsWith("FNF:")) current.funcs = Number(line.slice(4));
    else if (line.startsWith("FNH:")) current.funcsHit = Number(line.slice(4));
    else if (line.startsWith("end_of_record")) { files.push(current); current = null; }
  }
  return files;
}

const pct = (hit: number, total: number) => (total === 0 ? 100 : (hit / total) * 100);

function report(label: string, files: FileCoverage[]): void {
  const lines = files.reduce((n, f) => n + f.lines, 0);
  const hit = files.reduce((n, f) => n + f.hit, 0);
  const funcs = files.reduce((n, f) => n + f.funcs, 0);
  const funcsHit = files.reduce((n, f) => n + f.funcsHit, 0);
  console.log(
    `${label.padEnd(22)} ${pct(funcsHit, funcs).toFixed(2).padStart(6)} funcs · ` +
    `${pct(hit, lines).toFixed(2).padStart(6)} lines · ${String(files.length).padStart(3)} files`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "agent-mesh-coverage-"));
const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
/**
 * `--by-file` prints the per-file table, worst first by *uncovered lines*.
 *
 * The totals say how far there is to go and nothing about where to stand. A
 * percentage sorts small files to the top — a 12-line module at 0% looks worse
 * than a 900-line one at 60% and is worth a fiftieth as much — so the order
 * here is the count of lines nobody has run, which is the same thing as the
 * work each file is worth.
 */
const byFile = process.argv.includes("--by-file");
const run = spawnSync(
  "bun",
  ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`,
   ...(targets.length ? targets : ["packages/", "test/"])],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (run.status !== 0) {
  console.error("\ncoverage: the suite did not pass, so the number below would be about a broken tree");
  process.exit(run.status ?? 1);
}

const all = parseLcov(readFileSync(join(dir, "lcov.info"), "utf8"));
const excluded = all.filter((f) => EXCLUDED.some((re) => re.test(f.path)));
const counted = all.filter((f) => !EXCLUDED.some((re) => re.test(f.path)));

console.log("");
report("everything measured", all);
report("reported", counted);
if (byFile) {
  console.log("\nby file, worst first by lines nobody ran:\n");
  const rows = [...all].sort((a, b) => (b.lines - b.hit) - (a.lines - a.hit));
  for (const f of rows) {
    const missed = f.lines - f.hit;
    if (missed === 0) continue;
    const mark = EXCLUDED.some((re) => re.test(f.path)) ? " (excluded)" : "";
    console.log(
      `  ${String(missed).padStart(5)} uncovered  ${pct(f.hit, f.lines).toFixed(2).padStart(6)}%  ` +
      `${f.path}${mark}`,
    );
  }
  const covered = rows.filter((f) => f.lines - f.hit === 0).length;
  console.log(`\n  ${covered} file(s) fully covered, not listed`);
}

if (excluded.length > 0) {
  console.log(`\nexcluded by decision (${excluded.length} files, ${excluded.reduce((n, f) => n + f.lines, 0)} lines):`);
  for (const f of excluded.sort((a, b) => b.lines - a.lines)) {
    console.log(`  ${f.path.padEnd(40)} ${String(f.lines).padStart(5)} lines · ${pct(f.hit, f.lines).toFixed(2)}%`);
  }
}

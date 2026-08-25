#!/usr/bin/env bun
/**
 * The three checks CLAUDE.md names, plus the floor, with one exit code.
 *
 * ## The failure this exists for
 *
 * Every verification today ran as
 *
 *   bash -c 'tsc | tail -3; bun test packages/ | tail -4; bun test test/ | tail -4; coverage | tail -4'
 *
 * and a `;` chain exits with the status of the *last* command, while each
 * `| tail` discards the status of the one before the pipe. So a run reporting
 * `1157 pass / 10 fail` released the window with `exit 0`. `agent-mesh-local-pm`
 * and `fe-codex` both read that contradiction off one broadcast and said the
 * same thing: do not read a verdict from the far side of a pipe.
 *
 * Nothing was silently wrong in what I *claimed* — the counts were read out of
 * the output each time — but a wrapper whose exit code cannot go red is a
 * checker that checks nothing, and this repository has a document about that.
 *
 * ## Shape
 *
 * Steps run in order and all of them run: a red typecheck does not hide a red
 * suite, and knowing both is the difference between one broken thing and two.
 * The summary names every step that failed, and the exit code is 1 if any did.
 *
 * `AGENT_MESH_VERIFY_STEPS` replaces the step list with a JSON array of
 * `{name, command}` — how the suite exercises this without running the whole
 * repository twice.
 */

// A module, not a script: a top-level `await` in a file with no imports or
// exports is a syntax error nobody runs `tsc` over until the day somebody
// does. `mailbox-watch.ts` shipped exactly that.
export {};

interface Step {
  name: string;
  command: string[];
}

const DEFAULT_STEPS: Step[] = [
  { name: "typecheck", command: ["bun", "--bun", "tsc", "-b", "tsconfig.base.json"] },
  { name: "packages/", command: ["bun", "test", "packages/"] },
  { name: "test/", command: ["bun", "test", "test/"] },
  { name: "coverage floor", command: ["bun", "scripts/coverage.ts", "--ratchet", "coverage-floor.json"] },
];

function steps(): Step[] {
  const override = process.env.AGENT_MESH_VERIFY_STEPS;
  if (!override) return DEFAULT_STEPS;
  const parsed = JSON.parse(override) as Step[];
  if (!Array.isArray(parsed) || parsed.some((s) => !s?.name || !Array.isArray(s?.command))) {
    console.error("AGENT_MESH_VERIFY_STEPS must be a JSON array of {name, command[]}");
    process.exit(2);
  }
  return parsed;
}

/** The last few lines, which is what a summary of a passing suite is. */
function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

const failed: string[] = [];

for (const step of steps()) {
  console.log(`--- ${step.name}`);
  const proc = Bun.spawn(step.command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const said = (out + err).trimEnd();
  console.log(said.length === 0 ? "(no output)" : tail(said, 6));
  // The code is taken from the process, not inferred from what it printed: a
  // suite can print a summary and still exit non-zero, and a tool can print
  // nothing and be fine.
  if (code !== 0) failed.push(`${step.name} (exit ${code})`);
}

if (failed.length > 0) {
  console.log(`\nverification failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nverification passed: every step exited zero.");

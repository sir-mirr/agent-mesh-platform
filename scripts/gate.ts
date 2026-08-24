#!/usr/bin/env bun
/**
 * Run a gate inside an announced window, and release the window whatever
 * happens.
 *
 *   bun scripts/gate.ts "test/ 전수(브라우저 포함)" -- bun test test/
 *
 * ## The failure this exists for
 *
 * The browser suite is exclusive on this machine: two of them at once and both
 * results are noise. So a run is bracketed by two broadcasts — *starting* and
 * *finished* — and the other agents wait on the first and resume on the second.
 *
 * Both were sent by hand, and one went missing. The start for the `5a0bfdc`
 * window arrived; the release never did, and the other side had to go and read
 * `ps` to find out whether the machine was free. `agent-mesh-local-pm` noticed
 * and said the useful thing about it: **when the middle is missing, whoever
 * reads a red run cannot account for it.** A window announced and never
 * released is worse than one never announced, because the other side is now
 * waiting on a signal that is not coming.
 *
 * Remembering harder is not a fix. The pairing is mechanical, so it belongs in
 * a script — the same move as the shutdown closer list and the mailbox standing
 * order.
 *
 * ## The release fires on every path out
 *
 * Success, failure, a non-zero exit, `^C`, `SIGTERM`. A release that only
 * follows a green run is exactly the one that goes missing when a run goes red,
 * which is the moment the other side most needs to know the machine is free.
 *
 * ## It reports what it measured, not that it exited zero
 *
 * The summary carries the `N pass / N fail` the run printed. When those lines
 * are absent it says so rather than reporting the exit code as a result — a
 * process can exit zero having run nothing, and "green" that nobody measured is
 * the thing this repository keeps finding behind its own checks.
 */

import { $ } from "bun";

const MAILBOX = process.env.AGENT_MESH_MAILBOX_URL ?? "http://localhost:3300/api/mail";
const FROM = process.env.AGENT_MESH_AGENT_ID ?? "platform-claude";
/** Everyone who waits on this machine. Both, always: a release one side misses is a release. */
const TO = (process.env.AGENT_MESH_GATE_PEERS ?? "agent-mesh-local-pm,fe-codex")
  .split(",").map((s) => s.trim()).filter(Boolean);

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 1) {
  console.error('usage: bun scripts/gate.ts "<what this run is>" -- <command…>');
  process.exit(2);
}
const label = argv.slice(0, split).join(" ");
const command = argv.slice(split + 1);
if (command.length === 0) {
  console.error("nothing to run after --");
  process.exit(2);
}

async function broadcast(body: string): Promise<void> {
  await Promise.all(TO.map(async (to) => {
    try {
      await fetch(MAILBOX, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: FROM, to, body }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      // A mailer that is down must not take the gate with it: the run is the
      // point and the broadcast is the courtesy. Said on stderr so the gap is
      // visible here rather than only as silence on the other side.
      console.error(`[gate] could not tell ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

const commit = (await $`git rev-parse --short HEAD`.quiet().nothrow().text()).trim() || "unknown";

/**
 * What the run measured, in whichever shape it prints. Null when it printed no
 * measurement at all.
 *
 * Bun's `N pass / N fail` was the only shape this knew, and the runs that most
 * need an exclusive window print other ones: `mutation-check` ends on `n/m
 * caught`, its anchor pass on `n/m anchors point at exactly one place`, and
 * `coverage.ts` on whether the floor held. All of those released with *수치
 * 없음*, which reads as *nothing ran* — `agent-mesh-local-pm` measured two
 * sub-second windows, could not tell them from runs that never started, and
 * asked. The answer was in the captured output the whole time.
 *
 * Every shape here is a line one of those tools actually prints, and the
 * absence of all of them still reports nothing rather than the exit code.
 */
function summarise(output: string): string | null {
  const last = (re: RegExp) => [...output.matchAll(re)].at(-1);
  const parts: string[] = [];

  const pass = last(/^\s*(\d+)\s+pass\s*$/gm)?.[1];
  const fail = last(/^\s*(\d+)\s+fail\s*$/gm)?.[1];
  if (pass !== undefined || fail !== undefined) parts.push(`${pass ?? "?"} pass / ${fail ?? "?"} fail`);

  const caught = last(/^(\d+)\/(\d+) caught\b/gm);
  if (caught) parts.push(`${caught[1]}/${caught[2]} caught`);

  const anchors = last(/^(\d+)\/(\d+) anchors point at exactly one place/gm);
  if (anchors) parts.push(`${anchors[1]}/${anchors[2]} anchors`);

  const selfCheck = last(/^self-check: ([^\n]+)/gm);
  if (selfCheck) parts.push(`self-check: ${selfCheck[1]}`);

  const held = last(/^(?:floor|ratchet) ([^\n]*?): held[^\n]*/gm);
  if (held) parts.push(`floor held (${held[1]})`);

  const below = last(/^coverage: (funcs|lines) at ([\d.]+) is below[^\n]*/gm);
  if (below) parts.push(`${below[1]} ${below[2]} below the floor`);

  return parts.length === 0 ? null : parts.join(" · ");
}

let released = false;
async function release(outcome: string): Promise<void> {
  if (released) return;
  released = true;
  await broadcast(`[측정 종료 · 창 해제] ${label} · ${commit}\n\n${outcome}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The one path where the release matters most: somebody stopped the run and
    // the machine is free *now*, with nothing else about to say so.
    release(`${signal} — 중단됨. 결과 없음.`).finally(() => process.exit(130));
  });
}

await broadcast(`[측정 출발] ${label} · ${commit}\n\n${command.join(" ")}`);

const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });

/**
 * How much of the run is kept to read counts out of.
 *
 * **Everything was kept, and a run can print more than a machine holds.** One
 * failed `toBe(null)` on a jsdom node serialises to 248 MB; holding that as a
 * string here would take the window down with it, and this script's whole job
 * is to announce that the window closed. Every line `summarise` looks for is a
 * run's closing summary, so the end is the part worth keeping.
 */
const KEPT = 1024 * 1024;
let captured = "";
const tee = async (stream: ReadableStream<Uint8Array>, sink: typeof Bun.stdout) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    // Kept bounded; the terminal still gets all of it below.
    captured = (captured + text).slice(-KEPT);
    await Bun.write(sink, text);
  }
};
await Promise.all([tee(proc.stdout, Bun.stdout), tee(proc.stderr, Bun.stderr)]);
const code = await proc.exited;

const counts = summarise(captured);
await release(
  counts === null
    // Not "failed" and not "passed": the run printed no counts, so this script
    // has nothing to report and says that instead of reading the exit code as a
    // result.
    ? `exit ${code} · 수치 없음 — 실행이 pass/fail 줄을 찍지 않았습니다.`
    : `${counts} · exit ${code}`,
);
process.exit(code);

/**
 * One measuring window at a time, and the ways that guarantee is lost.
 *
 * The incident this pins: three `gate.ts` windows open at once on one machine,
 * because the gate announced windows rather than holding one. Nothing here
 * asserts the announcement — `gate.ts` broadcasts to a mailbox and that is
 * checked elsewhere. What is asserted is the refusal, the stale clear, and the
 * one that is easy to get wrong: a release must drop only its own window.
 *
 * The lock is exercised in child processes, because a lock a single process
 * takes from itself is not a lock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOCK = resolve(import.meta.dir, "..", "scripts", "window-lock.ts");
const HELD = 7;

let dirs: string[] = [];
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "window-lock-"));
  dirs.push(dir);
  return dir;
};
const windowFile = (dir: string) => join(dir, "measuring-window.json");

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A child that takes the window and stays up until it is killed. */
function holder(dir: string, label: string) {
  return Bun.spawn(
    ["bun", "-e", `import { takeWindow } from ${JSON.stringify(LOCK)};
       takeWindow(${JSON.stringify(label)}, "holder");
       process.exit(${HELD});`],
    { env: { ...process.env, AGENT_MESH_KEY_DIR: dir }, stdout: "pipe", stderr: "pipe" },
  );
}

/** A child that tries to take it and reports what happened. */
async function contender(dir: string) {
  const proc = Bun.spawn(
    ["bun", "-e", `import { takeWindow } from ${JSON.stringify(LOCK)};
       takeWindow("the second run", "contender");
       process.exit(${HELD});`],
    { env: { ...process.env, AGENT_MESH_KEY_DIR: dir }, stdout: "pipe", stderr: "pipe" },
  );
  const [said, complained, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, said, complained };
}

describe("taking the window", () => {
  test("a second run is refused, and told who has it", async () => {
    const dir = stateDir();
    // A live pid this test controls: the refusal is about liveness, so the
    // holder cannot be a number somebody made up.
    const sleeper = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(
        windowFile(dir),
        JSON.stringify({ pid: sleeper.pid, label: "test/ 전수(브라우저 포함)", cwd: "/some/worktree", since: "2026-08-25T04:00:00.000Z" }),
      );
      const second = await contender(dir);
      expect(second.code).toBe(2);
      expect(second.complained).toContain("already measuring");
      // Who, where and since when — a refusal naming none of those sends a
      // person to `ps`, which is where this went wrong in the first place.
      expect(second.complained).toContain("test/ 전수(브라우저 포함)");
      expect(second.complained).toContain(String(sleeper.pid));
      expect(second.complained).toContain("/some/worktree");
    } finally {
      sleeper.kill();
    }
  }, 30_000);

  test("a window whose process is gone is cleared rather than inherited", async () => {
    const dir = stateDir();
    // A pid that has certainly exited: this test's own child, awaited.
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    writeFileSync(
      windowFile(dir),
      JSON.stringify({ pid: dead.pid, label: "a run that crashed", cwd: "/gone", since: "2026-08-25T03:00:00.000Z" }),
    );

    const second = await contender(dir);
    expect({ code: second.code, cleared: second.complained.includes("which is gone") }).toEqual({
      code: HELD,
      cleared: true,
    });
  }, 30_000);

  test("a marker that will not parse is not read as an empty machine", async () => {
    const dir = stateDir();
    writeFileSync(windowFile(dir), "{ this is half a write");
    const second = await contender(dir);
    expect(second.code).toBe(2);
    expect(second.complained).toContain("cannot be read");
  }, 30_000);

  test("the window is written with the holder's own pid, directory and label", async () => {
    const dir = stateDir();
    const proc = holder(dir, "a run that records itself");
    expect(await proc.exited).toBe(HELD);
    // The process is gone, so what remains is what it wrote — the release only
    // runs when the caller calls it, and this child never did.
    const held = JSON.parse(readFileSync(windowFile(dir), "utf8"));
    expect({ pid: held.pid, label: held.label, cwd: held.cwd }).toEqual({
      pid: proc.pid,
      label: "a run that records itself",
      cwd: process.cwd(),
    });
  }, 30_000);
});

describe("releasing it", () => {
  test("a release drops the window it took", async () => {
    const dir = stateDir();
    const proc = Bun.spawn(
      ["bun", "-e", `import { takeWindow } from ${JSON.stringify(LOCK)};
         const drop = takeWindow("a run that finishes", "holder");
         drop();
         process.exit(${HELD});`],
      { env: { ...process.env, AGENT_MESH_KEY_DIR: dir }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(HELD);
    expect(existsSync(windowFile(dir))).toBe(false);
  }, 30_000);

  test("a late release does not drop the window somebody else now holds", async () => {
    // The shape that makes a lock worse than none: run A finishes slowly, run B
    // starts, and A's release frees B's window. Then two runs measure at once
    // believing they are alone.
    const dir = stateDir();
    const proc = Bun.spawn(
      ["bun", "-e", `import { takeWindow, readWindow } from ${JSON.stringify(LOCK)};
         const drop = takeWindow("run A", "holder");
         // Somebody else takes it while A is still finishing.
         const { writeFileSync } = await import("node:fs");
         writeFileSync(${JSON.stringify(windowFile(dir))},
           JSON.stringify({ pid: 999999, label: "run B", cwd: "/b", since: "now" }));
         drop();
         const after = readWindow();
         process.exit(after?.label === "run B" ? ${HELD} : 3);`],
      { env: { ...process.env, AGENT_MESH_KEY_DIR: dir }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(HELD);
  }, 30_000);
});

/**
 * The gate itself, against a mailbox that is not the real one.
 *
 * `gate.ts` broadcasts to the other agents, so this points it at a recording
 * server and names peers that do not exist. A test that sent real mail would
 * be a test nobody could run twice.
 */
describe("the gate", () => {
  const GATE = resolve(import.meta.dir, "..", "scripts", "gate.ts");

  async function runGate(dir: string, label: string, command: string[]) {
    const seen: Array<{ to: string; body: string }> = [];
    const mailer = Bun.serve({
      port: 0,
      async fetch(req) {
        const sent = (await req.json()) as { to: string; body: string };
        seen.push(sent);
        return Response.json({ id: seen.length, ...sent });
      },
    });
    try {
      const proc = Bun.spawn(["bun", GATE, label, "--", ...command], {
        env: {
          ...process.env,
          AGENT_MESH_KEY_DIR: dir,
          AGENT_MESH_MAILBOX_URL: `http://127.0.0.1:${mailer.port}/api/mail`,
          AGENT_MESH_GATE_PEERS: "nobody-at-all",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [said, complained, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, said, complained, seen };
    } finally {
      mailer.stop();
    }
  }

  test("runs its command and announces both ends of the window", async () => {
    const dir = stateDir();
    const run = await runGate(dir, "a short measurement", ["bun", "-e", "console.log('1 pass')"]);
    expect(run.code).toBe(0);
    // Both ends, in order, and the close carries what the run measured — the
    // expectations are written out rather than derived from what arrived,
    // which would assert only that the string equals itself.
    expect(run.seen).toHaveLength(2);
    expect({
      opens: run.seen[0]!.body.startsWith("[측정 출발] a short measurement"),
      closes: run.seen[1]!.body.startsWith("[측정 종료 · 창 해제] a short measurement"),
      measured: run.seen[1]!.body.includes("1 pass"),
    }).toEqual({ opens: true, closes: true, measured: true });
    // And it leaves the machine free.
    expect(existsSync(windowFile(dir))).toBe(false);
  }, 60_000);

  test("refuses a second window, and says so before announcing anything", async () => {
    // The failure this exists for: three windows open at once, each announcing
    // a start. An announced window that then finds the machine busy is worse
    // than silence — the other side waits for a release that is not coming.
    const dir = stateDir();
    const sleeper = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(
        windowFile(dir),
        JSON.stringify({ pid: sleeper.pid, label: "somebody else's rehearsal", cwd: "/other", since: "2026-08-25T04:00:00.000Z" }),
      );
      const second = await runGate(dir, "my rehearsal", ["bun", "-e", "console.log('should not run')"]);
      expect({ code: second.code, announced: second.seen.length, ran: second.said.includes("should not run") })
        .toEqual({ code: 2, announced: 0, ran: false });
      expect(second.complained).toContain("somebody else's rehearsal");
    } finally {
      sleeper.kill();
    }
  }, 60_000);
});

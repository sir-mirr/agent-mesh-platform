import { describe, it, expect } from "bun:test";
import { join } from "node:path";

/**
 * `orphan-guard.ts` is preloaded into every service the harness spawns, and
 * neither half of it runs during an ordinary suite: nothing reparents and
 * nothing signals. So it is run here directly, against a child that does
 * nothing but wait, where the signal can be sent on purpose and the log line
 * can be read.
 */
const GUARD = join(import.meta.dir, "orphan-guard.ts");

/** A child with the guard preloaded, already past its first line of output. */
async function waiting(body: string) {
  const proc = Bun.spawn(["bun", "--preload", GUARD, "-e", `${body}\nsetInterval(() => {}, 1000);\nconsole.log("ready");`], {
    env: { ...process.env, AGENT_MESH_TEST_PARENT_PID: String(process.pid) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  while (!seen.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  clearTimeout(deadline);
  reader.releaseLock();
  return proc;
}

/** The exit code, or the string "hung" — a signal nothing acts on is a signal ignored. */
async function exitOf(proc: Bun.Subprocess, ms = 5_000): Promise<number | "hung"> {
  return await Promise.race([
    proc.exited,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
}

describe("a service told to stop from outside", () => {
  it("says so, next to the clean shutdown it is about to log", async () => {
    const proc = await waiting(`process.on("SIGTERM", () => { console.log("shutdown complete"); process.exit(0); });`);
    proc.kill("SIGTERM");
    expect(await exitOf(proc)).toBe(0);
    const said = await new Response(proc.stderr).text();
    // The three facts a reader needs: which signal, when, and whether the run
    // that started this service is still going. Without the last one a kill
    // during a run reads the same as the harness tidying up after one.
    expect(
      {
        witnessed: said.includes("[orphan-guard] SIGTERM arrived from outside"),
        namedTheStarter: said.includes(`(pid ${process.pid}) is still running`),
        stamped: /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.test(said),
      },
      `a service was signalled mid-run and its log says only what a clean exit says — stderr was: ${said.trim() || "(empty)"}`,
    ).toEqual({ witnessed: true, namedTheStarter: true, stamped: true });
  }, 20_000);

  it("still stops when nothing else is listening for the signal", async () => {
    // A listener replaces the default disposition. Watching a signal must not
    // be the same as ignoring it: without the exit below this child outlives
    // every SIGTERM sent to it, which is the immortal service the rest of the
    // guard exists to prevent.
    const proc = await waiting(`console.error("no shutdown handler here");`);
    proc.kill("SIGTERM");
    const code = await exitOf(proc);
    expect(code, "SIGTERM no longer stops a service that has no handler of its own — watching the signal turned into ignoring it")
      .not.toBe("hung");
    expect(code, "the exit code no longer reports the signal that caused it").toBe(143);
  }, 20_000);

  it("reports the same for an interrupt", async () => {
    const proc = await waiting(`console.error("no shutdown handler here either");`);
    proc.kill("SIGINT");
    expect(await exitOf(proc)).toBe(130);
    const said = await new Response(proc.stderr).text();
    expect(said, "an interrupt goes unwitnessed").toContain("[orphan-guard] SIGINT arrived from outside");
  }, 20_000);

  it("is preloaded into the services the harness starts, or none of the above reaches one", async () => {
    const harness = await Bun.file(join(import.meta.dir, "harness.ts")).text();
    expect(harness, "the harness stopped preloading the guard, so no spawned service carries it")
      .toContain("test/orphan-guard.ts");
  });
});

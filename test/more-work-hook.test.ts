/**
 * The `Stop` hook itself, as a process — not the question it asks.
 *
 * `remaining-work.ts` is measured by `more-work.test.ts`; this covers the
 * twelve lines around it that `settings.json` actually registers. They decide
 * three things nothing else does: whether a continuation is blocked again,
 * whether an empty answer is still spoken, and what shape the block takes. Get
 * any of them wrong and the hook is silent or loops, and both look from the
 * outside like a repository with nothing left to do.
 *
 * **Spawned, because `import.meta.main` cannot be true in the test process.**
 * Importing this file runs none of it, which is the point of the split — and
 * is itself one of the things checked here, since `mailbox.ts` imports it
 * *after* reading stdin and a second reader gets EOF.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runChild } from "./child-output.ts";

const HOOK = resolve(import.meta.dir, "..", ".claude", "hooks", "more-work.ts");

/**
 * A tree with the two documents the question reads, and no git remote.
 *
 * The hook resolves its root from `CLAUDE_PROJECT_DIR`, and `mainWorktree`
 * falls back to it when git cannot answer — so a fixture outside any
 * repository is read exactly as written, with no unpushed count leaking in
 * from whichever branch happens to be checked out.
 */
function tree(deferred: string): string {
  const root = mkdtempSync(join(tmpdir(), "more-work-hook-"));
  mkdirSync(join(root, "docs", "proposals"), { recursive: true });
  writeFileSync(join(root, "docs", "deferred.md"), deferred);
  writeFileSync(join(root, "docs", "proposals", "README.md"), "");
  return root;
}

const OPEN = "### the poller repeats a row\n\nSome detail.\n";
const CLOSED = "### ~~the poller repeats a row~~\n\nClosed.\n";

/** Run the hook the way Claude Code runs it: JSON on stdin, JSON or nothing out. */
async function fire(root: string, input: unknown): Promise<{ out: string; code: number }> {
  // Read from files, not pipes: `new Response(child.stdout).text()` threw
  // `EBADF: bad file descriptor` out of a reader in CI and failed a test whose
  // child had run correctly. See `test/child-output.ts`.
  const ran = await runChild(["bun", HOOK], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    stdin: JSON.stringify(input),
  });
  return { out: ran.stdout.trim(), code: ran.code };
}

describe("the hook that keeps a turn from ending", () => {
  test("blocks the turn with what is left", async () => {
    const { out, code } = await fire(tree(OPEN), { hook_event_name: "Stop" });

    expect(code).toBe(0);
    const said = JSON.parse(out);
    expect(said.decision).toBe("block");
    expect(said.systemMessage).toBe("work remains");
    expect(said.reason).toContain("the poller repeats a row");
  });

  test("does not block a continuation it caused", async () => {
    // Without this guard a turn that ends having found work blocks again on
    // the next end, and there is no human in the loop to stop it.
    const { out, code } = await fire(tree(OPEN), { hook_event_name: "Stop", stop_hook_active: true });

    expect(out).toBe("");
    expect(code).toBe(0);
  });

  test("says nothing when nothing is open", async () => {
    // A hook that speaks on every turn stops being read. Silence is also the
    // only honest way to report "finished".
    const { out, code } = await fire(tree(CLOSED), { hook_event_name: "Stop" });

    expect(out).toBe("");
    expect(code).toBe(0);
  });

  test("importing it reads no stdin and still re-exports the question", async () => {
    // `mailbox.ts` reads stdin and *then* imports this file. If the import ran
    // the hook body, the second reader would get EOF and a `JSON Parse error`
    // naming the wrong file — so the import must be inert and the re-export
    // must be there, which is the whole reason the import exists.
    const root = tree(OPEN);
    const probe = join(root, "probe.ts");
    writeFileSync(
      probe,
      `import { remainingWork } from ${JSON.stringify(HOOK)};\n` +
        `const text = await Bun.stdin.text();\n` +
        `console.log(JSON.stringify({ read: text, question: typeof remainingWork }));\n`,
    );

    const ran = await runChild(["bun", probe], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      stdin: "the turn's own input",
    });

    expect(JSON.parse(ran.stdout.trim())).toEqual({ read: "the turn's own input", question: "function" });
  });
});

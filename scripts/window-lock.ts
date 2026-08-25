/**
 * One measuring window at a time on this machine.
 *
 * ## The failure this exists for
 *
 * `gate.ts` announces a window and releases it, and that is all it ever did —
 * a courtesy to the other agents, not a lock. Nothing refused a second window,
 * and on 2026-08-25 three of mine were open at once on one working tree, each
 * planting and restoring mutations under the others. The results were noise,
 * and worse than noise: I read a live run's planted mutation as a stranded one
 * and reverted it, so entries were measured against sources nobody had
 * mutated. Every part of that was invisible because nothing said "somebody is
 * already measuring".
 *
 * ## Machine-wide, not tree-wide
 *
 * `tree-lock.ts` guards a *working tree* against a mutation left in it, and it
 * belongs there because a mutation is a fact about files. This is the other
 * axis: the browser suite, the services and the ports are exclusive per
 * *machine*, and two worktrees of this repository exist on this one. So the
 * marker lives beside the mailbox state rather than in either tree.
 *
 * ## Liveness is a pid, never a command line
 *
 * `kill(pid, 0)` asks the kernel. Matching `ps` output against a pattern is
 * wrong in both directions — it misses a process whose command line does not
 * look the way the pattern guessed, which is exactly how the incident above
 * started (`mutation-check --shard` never matches `mutation-check.ts --shard`),
 * and it can match a neighbour that merely reads similarly. `agent-mesh-local-pm`
 * keeps the same rule for the same reason, from their own version of this.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.AGENT_MESH_KEY_DIR ?? join(homedir(), ".claude", "agent-mesh");
export const WINDOW_FILE = join(STATE_DIR, "measuring-window.json");

export interface Window {
  pid: number;
  label: string;
  /** Which tree it is measuring — two worktrees share this machine. */
  cwd: string;
  since: string;
}

/** Alive, asked of the kernel. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means somebody else's process, which is still a process.
    return err?.code === "EPERM";
  }
}

export function readWindow(): Window | null {
  let raw: string;
  try {
    raw = readFileSync(WINDOW_FILE, "utf8");
  } catch {
    return null;
  }
  try {
    const held = JSON.parse(raw) as Window;
    return typeof held?.pid === "number" ? held : { pid: -1, label: "unreadable", cwd: "", since: "" };
  } catch {
    // A torn write still means somebody was here. Reported as unknown so a
    // person looks, rather than silently treated as free.
    return { pid: -1, label: "unreadable", cwd: "", since: "" };
  }
}

/**
 * Take the window, or explain who has it and exit.
 *
 * Returns the release. A window held by a pid that is gone is cleared and said
 * so — the alternative is one crashed run locking the machine until somebody
 * finds the file.
 */
export function takeWindow(label: string, who = "this run"): () => void {
  const held = readWindow();
  if (held && held.pid !== process.pid) {
    if (held.pid === -1) {
      console.error(
        `${who} refuses to start: ${WINDOW_FILE} cannot be read.\n` +
          "A window marker that will not parse still means somebody was measuring. Look, then remove it.",
      );
      process.exit(2);
    }
    if (alive(held.pid)) {
      console.error(
        `${who} refuses to start: this machine is already measuring.\n` +
          `  ${held.label}\n` +
          `  pid ${held.pid}, in ${held.cwd || "an unrecorded directory"}, since ${held.since}\n` +
          "Wait for its release, or stop that run — do not measure over it.",
      );
      process.exit(2);
    }
    console.error(`(clearing a window marker from pid ${held.pid}, which is gone — held since ${held.since})`);
  }

  const mine: Window = { pid: process.pid, label, cwd: process.cwd(), since: new Date().toISOString() };
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(WINDOW_FILE, JSON.stringify(mine, null, 2) + "\n", { mode: 0o600 });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only ever remove our own: a release that fires late must not drop the
    // window somebody else has since taken.
    const now = readWindow();
    if (now && now.pid === process.pid) rmSync(WINDOW_FILE, { force: true });
  };
}

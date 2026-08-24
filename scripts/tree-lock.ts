/**
 * A marker saying the working tree is mid-mutation, visible to other processes.
 *
 * ## What went wrong without it
 *
 * `mutation-check` edits source files in place and restores them between
 * entries. Two of its entries neuter `packages/hub/src/signature.ts`. Another
 * agent's e2e runner builds a mesh **from this same tree**, and ran during that
 * window: eighteen scenarios passed at 11:52 and ten passed at 11:58 on the same
 * commit, with all eight failures signature refusals.
 *
 * Ports, state directories and ready files were all isolated, and that isolation
 * was checked and reported as sufficient. The source tree is the fourth thing,
 * and nothing was looking at it.
 *
 * **The failure landed in the other repository.** A red run there, at a commit
 * that was fine, caused by a command run here. That is the most expensive shape
 * on the list this project keeps — not a check that misses, but a check that
 * fires and accuses the wrong side, because the investigation goes somewhere the
 * defect is not.
 *
 * ## Why a file rather than the environment variable already here
 *
 * `AGENT_MESH_MUTATING` stops `mutation-check` nesting inside itself, and it
 * cannot do this job: an environment variable is visible to children and to
 * nobody else. The other runner is not a child. A file in the tree is visible to
 * anything that can see the tree, which is exactly the set of processes at risk.
 *
 * ## A dead holder is not a holder
 *
 * The marker records a pid, and a marker whose pid is gone is removed rather
 * than obeyed. A `mutation-check` killed by ^C would otherwise block every
 * harness on the machine until somebody found a file they did not know to look
 * for — which trades a rare wrong-repository failure for a common
 * nothing-starts one.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MARKER = resolve(import.meta.dir, "..", ".agent-mesh-mutating");

interface Held {
  pid: number;
  reason: string;
  since: string;
}

function read(): Held | null {
  if (!existsSync(MARKER)) return null;
  try {
    return JSON.parse(readFileSync(MARKER, "utf8")) as Held;
  } catch {
    // Unreadable is not "unheld" — a truncated write still means somebody was
    // here. Report it as held by an unknown pid so a person looks.
    return { pid: -1, reason: "unreadable marker", since: "unknown" };
  }
}

const alive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Claim the tree. Returns a release function; also releases on exit and on the
 * signals a person actually sends, because the common way this leaks is ^C.
 */
export function holdTree(reason: string): () => void {
  const held: Held = { pid: process.pid, reason, since: new Date().toISOString() };
  writeFileSync(MARKER, JSON.stringify(held, null, 2) + "\n");

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only if it is still ours. A later run that took over must not be cleared
    // by our exit handler.
    const now = read();
    if (now?.pid === process.pid) rmSync(MARKER, { force: true });
  };

  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}

/**
 * Refuse to build from a tree somebody is mutating.
 *
 * Returns nothing and exits when held: a caller that has to remember to check a
 * return value is a caller that will not.
 */
export function assertTreeUsable(who: string): void {
  const held = read();
  if (!held) return;

  // **A torn write is written by somebody who is still here.** The only way to
  // catch a half-written marker is to look while it is being written, so an
  // unreadable one is the strongest evidence of a live holder there is — and it
  // carries no pid to check. `read` says so by reporting pid -1; treating that
  // as a dead holder cleared the marker and let the caller build from a tree
  // mid-mutation, which is the failure at the top of this file, reached through
  // the one path that cannot name who to wait for.
  if (held.pid === -1) {
    console.error(
      `${who} refuses to start: this working tree carries a mutation marker that cannot be read.\n` +
        `  ${MARKER}\n` +
        `\n` +
        `A marker is only ever caught half-written while it is being written, so\n` +
        `something is very likely mutating this tree right now. Wait for it, or —\n` +
        `if you are certain nothing is — delete that file.`,
    );
    process.exit(2);
  }

  if (!alive(held.pid)) {
    // Stale. Say so — a silent cleanup here would hide a mutation-check that is
    // dying repeatedly.
    console.error(`(clearing a stale mutation marker from pid ${held.pid}, held since ${held.since})`);
    rmSync(MARKER, { force: true });
    return;
  }

  console.error(
    `${who} refuses to start: this working tree is mid-mutation.\n` +
      `  held by pid ${held.pid} since ${held.since}\n` +
      `  reason: ${held.reason}\n` +
      `\n` +
      `Source files here are being edited and restored in place, so a mesh built\n` +
      `now may be built from a deliberately broken guard. A run against it fails\n` +
      `for a reason that has nothing to do with the commit, and the failure looks\n` +
      `like a defect in whatever called it.\n` +
      `\n` +
      `Wait for it to finish, or use a different checkout.`,
  );
  process.exit(2);
}

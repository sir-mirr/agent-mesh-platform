/**
 * Which checkout this process is running (SPEC § 7).
 *
 * **Two multi-message investigations came from not having this.** A long-running
 * instance on `:3000` was serving a branch ninety-three commits behind `main`,
 * and the only way anyone could tell was to notice that routes were missing and
 * reason backwards. It happened twice — the same worktree, fifty-three commits
 * further apart the second time — and both times the first diagnosis was wrong:
 * once "an old build", once "the redirect is a defect". Neither was.
 *
 * The harness already reports this in its ready file, so a scenario run always
 * knows what answered it. A hub somebody started by hand had no such thing, and
 * that is exactly the hub people leave running for a week.
 *
 * ## Read once, at boot
 *
 * A process cannot change commit while running, so this is a constant. Spawning
 * `git` per request would be a cost paid forever for an answer that never
 * changes.
 *
 * ## Never fatal
 *
 * A deployment from a tarball has no `.git` and is entirely legitimate. It
 * reports `unknown`, which is honest and still more than the nothing this
 * replaces — an instance that says `unknown` is telling you it cannot be
 * identified, which is itself the answer to "which commit is this".
 */

import { resolve } from "node:path";

export interface Provenance {
  commit: string;
  branch: string;
  /** Uncommitted changes make the commit a claim about the wrong bytes. */
  dirty: boolean;
}

function read(): Provenance {
  const root = resolve(import.meta.dir, "../../..");
  const git = (...args: string[]): string => {
    try {
      const p = Bun.spawnSync(["git", "-C", root, ...args]);
      return p.success ? new TextDecoder().decode(p.stdout).trim() : "";
    } catch {
      return "";
    }
  };

  const commit = git("rev-parse", "HEAD");
  if (!commit) return { commit: "unknown", branch: "unknown", dirty: false };
  return {
    commit,
    branch: git("rev-parse", "--abbrev-ref", "HEAD") || "detached",
    dirty: git("status", "--porcelain") !== "",
  };
}

/** Computed at import, because it cannot change while the process lives. */
export const PROVENANCE: Provenance = read();

/**
 * What is left to do, as a question a `Stop` hook can put.
 *
 * **Separate from the hook that asks it.** `import.meta.main` cannot be true in
 * a test process, so glue registered as a hook sits in the coverage report as
 * source nothing can reach — and a floor at 100 is then either a lie or a file
 * nobody may test. `more-work.ts` stays the registered entry point, re-exports
 * this, and is never imported in-process; the question itself lives here and is
 * measured.
 */

/**
 * Ask, at the end of a turn, whether there is more to do.
 *
 * The failure this exists for is not idleness — it is **reporting instead of
 * continuing**. A turn that ends with "next I will do X" has not done X, and
 * from the outside that is indistinguishable from being blocked. Several turns
 * went that way before this hook.
 *
 * ## It does not decide, it asks
 *
 * The hook cannot tell whether the remaining work is genuinely blocked on a
 * decision or merely unstarted, so it does not try. It gathers what is
 * demonstrably outstanding — open `deferred.md` entries, undecided proposals,
 * unpushed commits — and hands that back with the question. Deciding is the
 * model's job; noticing is cheap and mechanical, which is why it belongs here.
 *
 * ## Guarded, like the mailbox hook
 *
 * `stop_hook_active` is the same guard for the same reason: without it a turn
 * that ends having found more work blocks again on the next end, and there is
 * no human in the loop to stop it. One nudge per turn.
 *
 * ## Silent when there is nothing
 *
 * A hook that speaks on every turn stops being read. This one exits `0` when
 * the lists come back empty, which is also the only honest way to report
 * "finished".
 */

import { $ } from "bun";

const SESSION_ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/**
 * The worktree holding `main`, which is not necessarily the session's.
 *
 * Two agents share this repository through separate worktrees, so
 * `CLAUDE_PROJECT_DIR` is whichever one the session started in. Reading
 * `docs/deferred.md` from the other one reports items that were closed on
 * `main` hours ago and unpushed counts belonging to somebody else's branch —
 * which is exactly what the first firing of this hook did.
 *
 * Asking git is better than hard-coding a sibling path: the answer stays right
 * when the layout changes, and there is no second place recording where `main`
 * lives.
 */
export async function mainWorktree(sessionRoot: string = SESSION_ROOT): Promise<string> {
  try {
    const out = await $`git -C ${sessionRoot} worktree list --porcelain`.quiet().text();
    let path = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      else if (line.trim() === "branch refs/heads/main" && path) return path;
    }
  } catch {
    // Not a repo, or no worktree on main — the session's own tree is the only
    // honest answer left.
  }
  return sessionRoot;
}

const ROOT = await mainWorktree();

/**
 * **The root is an argument, not a constant.** This read `ROOT` directly while
 * `remainingWork` took a root parameter, so passing one moved the git count to
 * that tree and left the documents being read from this one — a caller would
 * get one worktree's unpushed commits beside another's open items, and nothing
 * could be measured against a fixture at all.
 */
const read = async (root: string, path: string): Promise<string> => {
  try {
    return await Bun.file(`${root}/${path}`).text();
  } catch {
    return "";
  }
};

/**
 * Deferred entries that are open **and carry no reason for being deferred**.
 *
 * Two conventions that file already uses, read rather than reinvented: a
 * closed entry is struck through (`### ~~…~~`), and a deliberate one states
 * **Why deferred**. An entry with a reason is a decision somebody made; an
 * entry without one is work nobody has looked at.
 *
 * Reporting all of them was the first version, and it listed twenty-five every
 * turn — **a hook that speaks on every turn stops being read**, which is the
 * failure it exists to prevent, arriving through the fix.
 */
function openDeferred(text: string): string[] {
  return text
    .split(/\n(?=### )/)
    .filter((b) => b.startsWith("### ") && !b.startsWith("### ~~") && !b.includes("**Why deferred"))
    .map((b) => b.split("\n")[0]!.slice(4).trim());
}

/** Bullets under "Still undecided" in the proposal index. */
function undecided(text: string): string[] {
  const start = text.indexOf("### Still undecided");
  if (start === -1) return [];
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n### ");
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((l) => l.startsWith("- **"))
    .map((l) => l.replace(/^- \*\*(.*?)\*\*.*$/s, "$1").trim());
}

/**
 * The question, or `null` when there is nothing to ask.
 *
 * Exported because `/hooks` cannot reload settings mid-session: a hook entry
 * added to `settings.json` after a session starts never runs. The commands
 * already registered do re-read their *files* on every execution, so the
 * mailbox hook calls this and it takes effect immediately. Registering it
 * separately still matters for the next session; this is what makes it work in
 * this one.
 */
export async function remainingWork(root = ROOT): Promise<string | null> {
  const [deferredText, indexText] = await Promise.all([
    read(root, "docs/deferred.md"),
    read(root, "docs/proposals/README.md"),
  ]);

  let unpushed = 0;
  try {
    const out = await $`git -C ${root} log --oneline origin/main..HEAD`.quiet().text();
    unpushed = out.trim() ? out.trim().split("\n").length : 0;
  } catch {
    // Not a repo, no remote, or no upstream — none of which is this hook's
    // business to report on.
  }

  const open = openDeferred(deferredText);
  const pending = undecided(indexText);

  if (open.length === 0 && pending.length === 0 && unpushed === 0) return null;

  const lines: string[] = ["Before stopping — is any of this the next thing to do?", ""];
  if (unpushed > 0) {
    lines.push(`**${unpushed} commit(s) not on \`origin/main\`.** Push them or say why not.`, "");
  }
  if (open.length > 0) {
    lines.push(`**${open.length} in docs/deferred.md with no stated reason for waiting:**`);
    for (const item of open.slice(0, 12)) lines.push(`- ${item}`);
    if (open.length > 12) lines.push(`- …and ${open.length - 12} more`);
    lines.push("");
  }
  if (pending.length > 0) {
    lines.push("**Undecided in docs/proposals/README.md:**");
    for (const item of pending) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push(
    "If something here is implementable, implement it rather than describing it —",
    "a turn that ends with \"next I will do X\" has not done X. If it is genuinely",
    "blocked on a decision only the user can make, ask that one question and stop.",
    "If none of it is worth doing now, say so in one line and stop.",
  );

  return lines.join("\n");
}

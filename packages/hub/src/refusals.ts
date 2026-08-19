/**
 * What this hub has refused, and why.
 *
 * **§ 8.1 and § 12 both refuse and then forget.** A signature that fails
 * verification and a send that no egress rule allows are each answered with an
 * RPC error and a line on stdout, and nothing anywhere can be queried
 * afterwards. So an operator asking *is something failing to get in* has to
 * grep a process's output, and one asking *has this ever happened* has no
 * answer at all.
 *
 * That is the same shape as the rate limiter beside this file, which stated
 * that limits exist and counted nothing: a limit protecting a mesh and a limit
 * set so wide it is decoration are both silent, and so are a mesh nobody is
 * attacking and a mesh whose signatures have been failing for a week.
 *
 * ## In memory, not in the audit store
 *
 * A signature refusal is **the one event an unauthenticated caller can produce
 * at will**. Writing each one to `audit.db` hands anybody who can open a socket
 * a way to fill a disk, which is the same reasoning that makes § 8.1 spend the
 * nonce before verifying rather than after.
 *
 * So these are counters in the process, and they are lost on restart. That is
 * the right trade for the question being asked: an operator wants to know
 * whether something is failing to get in *now*, not what happened last month.
 * Anything wanting history belongs in the audit trail under § 11's rules, and
 * that is a separate decision with a cost attached.
 *
 * ## Bounded by construction
 *
 * Keyed on a **reason**, never on an identity, an address or anything else a
 * caller supplies. The set of reasons is fixed by the code that reports them,
 * so the map cannot grow past it however much traffic arrives — a counter map
 * keyed on caller input is a memory leak whose rate the caller chooses, which
 * is precisely what the rate limiter's `sweep()` exists to undo.
 *
 * Egress pairs are the one exception and are safe for the same reason in
 * reverse: both group names come from `groups` in the database, not from the
 * request, so the set is bounded by how many groups an operator made.
 */

export type RefusalKind = "signature" | "egress";

const counts = new Map<string, number>();

/**
 * When this process began counting.
 *
 * **Without it a `0` cannot be read.** These counters live in memory and are
 * lost on restart — the module says so a few lines down — so "no signature
 * refusals" and "this hub started ninety seconds ago" produce the same number,
 * and on a screen the second one looks like health. Refusal counts are the kind
 * of metric where `0` is the hoped-for answer, which is exactly when nobody
 * questions it.
 *
 * Captured at module load rather than at first refusal: the window a reader
 * needs is *how long has this been watching*, not *when did something first go
 * wrong*.
 */
export const COUNTING_SINCE = new Date().toISOString();

/**
 * NUL as the separator, because no reason can contain one — and **written as an
 * escape**, because it used to be typed here as the byte itself.
 *
 * A raw NUL makes the file binary to everything that decides by sniffing:
 * `file` reports `data`, and `grep -rn` skips it entirely without saying so.
 * This is the counter module, which makes it the densest place in the
 * repository to look for state that is written and never read — and it was
 * invisible to the tool anybody would look with. It is clean, and nothing about
 * the searching established that.
 *
 * The escape produces an identical string, so keys and digests do not move.
 */
const key = (kind: RefusalKind, reason: string) => `${kind}\u0000${reason}`;

/**
 * Record one refusal.
 *
 * Deliberately returns nothing and cannot fail. A counter that throws would
 * turn a refusal into a crash, and this is called on the path that already
 * decided to say no.
 */
export function recordRefusal(kind: RefusalKind, reason: string): void {
  const k = key(kind, reason);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

export interface RefusalCount {
  kind: RefusalKind;
  reason: string;
  count: number;
}

/** Every refusal counted since this process started, most frequent first. */
export function refusalCounts(): RefusalCount[] {
  return [...counts.entries()]
    .map(([k, count]) => {
      const [kind, reason] = k.split("\u0000") as [RefusalKind, string];
      return { kind, reason, count };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

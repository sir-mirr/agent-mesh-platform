/**
 * One nth of a list, taken round-robin.
 *
 * **Round-robin rather than contiguous blocks.** The manifest is grouped by
 * subject and the expensive suites cluster inside a group, so a contiguous
 * eighth would hand one shard every `fe-render` entry and another shard none —
 * the nightly's wall-clock would be one shard's, and seven jobs would sit idle.
 *
 * **A partition, which is the part that can go quiet.** Every entry belongs to
 * exactly one shard: an off-by-one in either index runs some entries twice and
 * others never, and the nightly reports eight green shards either way. Nothing
 * in the output distinguishes a manifest fully measured from one measured with
 * a hole in it, which is why this is a function with a test rather than an
 * expression inside a script.
 */
export function shardOf<T>(entries: readonly T[], k: number, n: number): T[] {
  return entries.filter((_, i) => i % n === k - 1);
}

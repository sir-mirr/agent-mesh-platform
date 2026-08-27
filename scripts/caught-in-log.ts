/**
 * The entry ids a mutation-check log records as **caught**.
 *
 * **Only the tick.** A run prints one line per entry — `✓ id` or `✗ id: …` —
 * and then a summary that names every id it was filtered to, caught and
 * uncaught alike. A reader that takes ids from anywhere but the ✓ lines turns
 * an entry that *missed* into an observation that it did not, which is the
 * error `scenario-anchors.ts` exists to name arriving through the log instead
 * of through the manifest.
 *
 * Its own module so it can be run without running the inventory: importing
 * `scenario-anchors.ts` executes the whole reader, and the piece that turns
 * *pinned* into *observed* was the one part of that file nothing had measured.
 */
export function caughtInLog(text: string): Set<string> {
  const caught = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\s*✓\s+(\S+)/.exec(line);
    if (m) caught.add(m[1]!);
  }
  return caught;
}

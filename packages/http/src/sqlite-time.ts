/**
 * SQLite's `datetime('now')` on the wire (D-809, SPEC § 9.1).
 *
 * The store writes `YYYY-MM-DD HH:MM:SS` — a space, no zone — and this API
 * sends ISO-8601 everywhere else. `new Date("2026-08-28 11:54:06")` is not
 * portable: engines disagree on whether it parses at all, and the ones that
 * accept it read it as **local time**, so the same row renders hours apart in
 * two browsers and a sort mixes the two formats wrongly.
 *
 * **The column is not renamed and not rewritten.** A storage format is not a
 * wire format — the same rule `recorded_by` settled under, for the same reason:
 * correcting a spelling is not worth rewriting history a row at a time.
 */

/** SQLite's own shape: `YYYY-MM-DD HH:MM:SS`, optionally with fractional seconds. */
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

/**
 * Convert if it is SQLite's shape, pass through otherwise.
 *
 * **Pass-through is deliberate and is the case that needs saying.** Some rows
 * arrive already ISO — the one-time `registry.json` import wrote them, and
 * `mesh.audit.append` carries client timestamps — and rewriting a value this
 * function does not understand would be inventing a zone for it. A caller
 * seeing a non-ISO string here is seeing a value from somewhere this comment
 * does not cover, which is worth noticing rather than smoothing over.
 *
 * `datetime('now')` is UTC, which is why `Z` can be appended rather than
 * guessed at.
 */
export function isoOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const m = SQLITE_UTC.exec(value)
  if (!m) return value
  return `${m[1]}T${m[2]}Z`
}

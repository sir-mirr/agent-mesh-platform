/**
 * Who may download an attachment (SPEC § 15.3).
 *
 * **The parties to the message that carries it, and nobody else.** Sender or
 * recipient, agent or person — the same two names § 8.2 already distinguishes.
 *
 * The route was unauthenticated, on the reasoning that a content-addressed id
 * is unguessable and therefore a capability. That holds right up until the id
 * appears somewhere: in a log line, in an audit event, in a screenshot, in the
 * `download_url` of a message forwarded to a third party. A capability that
 * travels inside the thing it protects is one nobody can withdraw.
 *
 * ## Participation is read from `messages`
 *
 * An attachment is not owned; it is *referenced*. The same bytes may appear in
 * ten conversations — content addressing is the point — so the question is not
 * "whose file is this" but "was this caller party to a message carrying it".
 *
 * That makes the check a search rather than a lookup, and it is deliberately
 * over `messages` rather than the audit trail: the audit copy is permanent
 * (§ 15.6), so authorising from it would keep granting access long after the
 * conversation rotated away. Access should expire with the operational record,
 * not with the evidence one.
 */

import type { Database } from 'bun:sqlite'

/**
 * Does `identity` appear as sender or recipient on any message referencing
 * this attachment?
 *
 * The `LIKE` is over the id inside the message body, which is where § 15.2 puts
 * attachment metadata. Matching the **quoted** id rather than the bare string
 * keeps a request for `abc` from matching a message carrying `abcdef`.
 *
 * That quoting is defensive rather than load-bearing today: ids are digests
 * plus an extension, so a prefix never names a file and the filesystem refuses
 * it first. A mutation swapping the quotes out therefore passes the suite —
 * recorded here rather than covered by a test that would only appear to.
 *
 * `from_agent` and `to_agent` both count, and `sent_by` deliberately does not:
 * a proxy carried the message, and carrying it is not being party to it.
 */
export function mayDownload(db: Database, identity: string, attachmentId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM messages
        WHERE (from_agent = ? OR to_agent = ?)
          AND content LIKE ?
        LIMIT 1`,
    )
    .get(identity, identity, `%"${attachmentId}"%`) as { ok: number } | undefined
  return !!row
}

/**
 * Every identity party to a message carrying this attachment.
 *
 * For diagnostics and for the operator screen — a `403` that cannot say who
 * *would* be allowed is one an operator cannot act on.
 */
export function participants(db: Database, attachmentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT from_agent, to_agent FROM messages WHERE content LIKE ?`,
    )
    .all(`%"${attachmentId}"%`) as Array<{ from_agent: string; to_agent: string }>
  return [...new Set(rows.flatMap((r) => [r.from_agent, r.to_agent]))].sort()
}

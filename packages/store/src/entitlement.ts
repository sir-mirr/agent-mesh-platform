/**
 * Who may speak for whom (SPEC § 8.2).
 *
 * `mesh.send` accepts a `from` override, and it is load-bearing: the http
 * server uses it to forward for a signed-in person, who has no socket of their
 * own. Until 0.2 it was accepted unchecked, so any connected socket could
 * originate an envelope as any identity.
 *
 * The rule is small because the question turned out to be small. Every other
 * participant holds a key and signs for itself, so `from` is already settled by
 * the signature; the client team confirmed that lanes never proxy. The override
 * exists for exactly one case — a participant who by design holds no key — and
 * that case is now a type rather than a special case:
 *
 *   1. the proxying identity must carry `can_proxy`
 *   2. the proxied identity must be of a type with `requires_key = 0`
 *
 * Rule 2 is the substantive one, and it is expressed against the type registry
 * rather than a grant table because that is what makes it true rather than
 * merely configured. An identity that can hold a key can sign for itself, so a
 * proxy claim over it is either redundant or a lie. This is also why people had
 * to become registered identities first: before that the hub had no row whose
 * type it could ask about.
 *
 * Rule 1 exists because rule 2 alone would let any connected agent speak for
 * any person — the scheduler is a `service` exactly as the web gateway is.
 */

import type { Database } from "bun:sqlite";

export type Refusal = "not-a-proxy" | "unknown-identity" | "deleted" | "self-signing";

export interface Entitlement {
  ok: boolean;
  reason?: Refusal;
}

const OK: Entitlement = { ok: true };

/** Whether `identity` is allowed to claim other identities at all. */
export function canProxy(db: Database, identity: string): boolean {
  const row = db
    .prepare(`SELECT can_proxy FROM agents WHERE identity = ? AND deleted_at IS NULL`)
    .get(identity) as { can_proxy: number } | undefined;
  return row?.can_proxy === 1;
}

/**
 * Whether `proxy` may speak for `subject`.
 *
 * Both halves are checked every call rather than cached with the connection,
 * for the same reason § 8.1 reads the signing key per request: an operator who
 * withdraws `can_proxy`, or tears the subject down, means it from that moment
 * and not from whenever the socket next happens to reconnect.
 */
export function mayProxy(db: Database, proxy: string, subject: string): Entitlement {
  if (proxy === subject) return OK;
  if (!canProxy(db, proxy)) return { ok: false, reason: "not-a-proxy" };

  const row = db
    .prepare(
      `SELECT a.deleted_at, t.requires_key
         FROM agents a LEFT JOIN agent_types t ON t.type = a.type
        WHERE a.identity = ?`,
    )
    .get(subject) as { deleted_at: string | null; requires_key: number | null } | undefined;

  if (!row) return { ok: false, reason: "unknown-identity" };
  if (row.deleted_at) return { ok: false, reason: "deleted" };
  // An unregistered type is treated as key-requiring. The safe direction: a
  // deployment that adds a type without deciding this does not thereby make its
  // identities impersonable.
  if (row.requires_key !== 0) return { ok: false, reason: "self-signing" };
  return OK;
}

export function refusalMessage(subject: string, reason: Refusal): string {
  switch (reason) {
    case "not-a-proxy":
      return `not entitled to act for '${subject}'`;
    case "unknown-identity":
      return `cannot act for '${subject}': no such identity`;
    case "deleted":
      return `cannot act for '${subject}': identity has been deleted`;
    case "self-signing":
      return `cannot act for '${subject}': that identity holds its own key and signs for itself`;
  }
}

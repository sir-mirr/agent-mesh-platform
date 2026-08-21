/**
 * The audit's message list: what it filters on, how it pages, and what it says
 * when the store will not answer.
 *
 * Split out of `main.ts` for the reason `audit-agents.ts` was, and it is the
 * same route family: the failure branch is only reachable when the store is
 * broken, and breaking the real one to reach it takes every later test in the
 * process down with it. Taking the handle as an argument turns "break the
 * database" into "pass a different argument".
 *
 * **A failed query is not an empty audit.** The refusal carries the driver's
 * message rather than a bare `500`, because the two failures an operator can
 * act on — a store that is not there and a query this build got wrong — read
 * identically without it.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";

/** `c.req.query()`: every value a string, or absent. */
export type ChatAuditQuery = Record<string, string | undefined>;

export interface ChatAuditMessage {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  reply_to: string | null;
  status: string | null;
  ts: string;
}

export interface ChatAuditsResult {
  status: 200 | 500;
  body:
    | { messages: ChatAuditMessage[]; has_more: boolean; oldest_id: string | null }
    | { error: string; detail: string };
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

/**
 * An empty string is not a filter — `?to_agent=` asks for everything.
 *
 * **The only place emptiness is decided.** The call sites test `!== null`
 * rather than truthiness, so this predicate is the single guard: a second one
 * downstream would be a second sufficient check, and a mutation of either
 * would survive the other. Two guards for one rule are not twice as safe —
 * they are one rule nobody can test.
 */
const filter = (v: string | undefined): string | null =>
  typeof v === "string" && v ? v : null;

/**
 * **The page size is clamped, not trusted.** `limit` arrives as text, so
 * `?limit=abc` parses to `NaN` and unbounded rows is not what a mistyped
 * query should mean; and a caller asking for a million rows would hold the
 * whole audit in memory to serve one screen.
 */
export function pageLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return n > MAX_LIMIT ? MAX_LIMIT : n;
}

export function listChatAudits(openHub: () => Database, q: ChatAuditQuery): ChatAuditsResult {
  const beforeId = filter(q.before_id);
  const fromAgent = filter(q.from_agent);
  const toAgent = filter(q.to_agent);
  const search = filter(q.search);
  const limit = pageLimit(q.limit);

  try {
    const db = openHub();

    // The primary key is not sortable lexically, so the cursor anchors on `ts`
    // with `id` as the tiebreak. An id nobody has seen resolves to no cursor
    // and pages from the top, rather than refusing: a client holding a message
    // that has since been deleted gets a page, not an error.
    let cursorTs: string | null = null;
    if (beforeId) {
      const row = db.query("SELECT ts FROM messages WHERE id = ?").get(beforeId) as
        | { ts: string }
        | undefined;
      if (row) cursorTs = row.ts;
    }

    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (cursorTs !== null) {
      // Strictly older than the cursor, or the same instant under a smaller id
      // — two messages sharing a `ts` must not page over each other.
      where.push("(ts < ? OR (ts = ? AND id < ?))");
      params.push(cursorTs, cursorTs, beforeId);
    }
    if (fromAgent !== null) {
      where.push("from_agent = ?");
      params.push(fromAgent);
    }
    if (toAgent !== null) {
      where.push("to_agent = ?");
      params.push(toAgent);
    }
    if (search !== null) {
      where.push("content LIKE ?");
      params.push("%" + search + "%");
    }

    const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    // One more than asked for, so `has_more` is measured rather than guessed.
    const sql = `SELECT id, from_agent, to_agent, content, reply_to, status, ts FROM messages ${whereClause} ORDER BY ts DESC, id DESC LIMIT ?`;
    const rows = db.query(sql).all(...params, limit + 1) as ChatAuditMessage[];

    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    const oldestId = messages.length > 0 ? messages[messages.length - 1]!.id : null;

    return { status: 200, body: { messages, has_more: hasMore, oldest_id: oldestId } };
  } catch (e: any) {
    console.error("[chat-audits] query failed:", e?.message ?? e);
    return {
      status: 500,
      body: { error: "Failed to query chat audits", detail: String(e?.message ?? e) },
    };
  }
}

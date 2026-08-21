/**
 * Who appears in the audit, and what to say when the store will not answer.
 *
 * **An empty list is an answer, and a failed query is not one.** This route
 * used to catch the failure and return `{ agents: [] }`, so *the audit holds
 * nobody* and *the query did not run* were one sentence to every caller — the
 * shape `SC-DOWN-*` exists to catch on the front end, arriving on the wrong
 * side of it. A test written as the happy path passed through the catch
 * without noticing, which is how invisible it was (D-736).
 *
 * Split out of `main.ts` for the reason `push.ts` and `env-file.ts` were: the
 * refusal is only reachable when the store is broken, and breaking the real
 * one to reach it takes every later test in the process down with it. That was
 * tried — `hub.db` renamed without its `-wal` — and eight tests failed on a
 * mismatched WAL. Taking the handle as an argument turns "break the database"
 * into "pass a different argument".
 */

import type { Database } from "bun:sqlite";
import { log } from "./log";

export interface AuditAgentsResult {
  status: 200 | 503;
  body: { agents: string[] } | { ok: false; error: string; code: string };
}

/**
 * Every identity that appears in the audit, from either end of a message.
 *
 * `UNION`, not `UNION ALL`: the same identity on both sides of a conversation
 * is one name in this list. Sorted case-insensitively because the caller is an
 * operator picking from a dropdown, and `Zeta` before `alpha` is a list nobody
 * can scan.
 */
export function auditAgents(openHub: () => Database): AuditAgentsResult {
  try {
    const rows = openHub()
      .query(
        "SELECT DISTINCT a FROM (SELECT from_agent AS a FROM messages UNION SELECT to_agent AS a FROM messages) ORDER BY a COLLATE NOCASE",
      )
      .all() as Array<{ a: string }>;
    return { status: 200, body: { agents: rows.map((r) => r.a).filter(Boolean) } };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("the agent list could not be read, so the caller is told so", "audit_agents_query_failed", {
      outcome: "failed",
      reason: "store_unreadable",
      error: message,
    });
    // 503, not 500: the request was valid and the deployment is degraded, so a
    // caller that retries once the store is back gets its answer. Same shape
    // as `AUDIT_READ_UNRECORDABLE`.
    return {
      status: 503,
      body: {
        ok: false,
        error: "the audit store did not answer, so who appears in it is unknown",
        code: "AUDIT_AGENTS_UNAVAILABLE",
      },
    };
  }
}

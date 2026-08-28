import type { RestMailboxResponse, RestMailboxSummary } from "@agent-mesh/contracts";

import { apiClient } from "./client.ts";

/**
 * One row of `GET /api/v1/admin/mailbox`, in the column names the route's own
 * SQL gives them: `count(*) AS pending`, `sum(…) AS leased`, `min(ts) AS oldest`.
 *
 * This interface used to declare `depth`, `unacked_count`, `oldest_message_ts`
 * and `leased_count` — four names, none of which any package on this platform
 * has ever sent. The summing below read `depth`, so it summed `undefined` and
 * produced `0`, and the dashboard drew that `0` as the queue.
 *
 * It is the contract's row now rather than a fourth spelling of the same four
 * columns.
 */
export type MailboxSummary = RestMailboxSummary;

export interface AdminMailboxResponse {
  mailboxes: MailboxSummary[];
  /**
   * `null` when the route did not answer with a list of mailboxes, which is a
   * different fact from an empty queue and has to reach the screen as one.
   * The old field was read off the response as `data.total_queued` — a name no
   * route sends either — so both branches were dead and the value was `0`
   * whether the mesh was idle or backed up.
   */
  total_queued: number | null;
}

export async function fetchAdminMailbox(): Promise<AdminMailboxResponse> {
  const data = await apiClient<RestMailboxResponse>("/api/v1/admin/mailbox");
  return {
    mailboxes: Array.isArray(data?.mailboxes) ? data.mailboxes : [],
    // The route's own `count(*)`, not a sum taken here. Summing the rows is
    // what produced the defect — over `depth`, a column this route has never
    // emitted — and it would go quietly small the day the grouping takes a
    // `LIMIT`.
    //
    // **`total_queued` is sent.** The comment here used to say it was "a name
    // no route sends either", which was true of `depth` and never of this one:
    // `packages/http/src/main.ts` answers `{ ok, mailboxes, total_queued }`.
    // The sentence sat inside the explanation of the original defect and
    // carried the error forward, and `api/telemetry.ts` repeated it.
    //
    // The check stays anyway, because `null` for a total that did not arrive is
    // a different fact from a queue of zero, and a type cannot promise what
    // arrived on a socket.
    total_queued: typeof data?.total_queued === "number" ? data.total_queued : null,
  };
}

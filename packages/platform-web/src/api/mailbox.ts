import { apiClient } from "./client.ts";

/**
 * One row of `GET /api/v1/admin/mailbox`, in the column names the route's own
 * SQL gives them: `count(*) AS pending`, `sum(…) AS leased`, `min(ts) AS oldest`.
 *
 * This interface used to declare `depth`, `unacked_count`, `oldest_message_ts`
 * and `leased_count` — four names, none of which any package on this platform
 * has ever sent. The summing below read `depth`, so it summed `undefined` and
 * produced `0`, and the dashboard drew that `0` as the queue.
 */
export interface MailboxSummary {
  identity: string;
  pending: number;
  leased: number;
  oldest: string | null;
}

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
  const data = await apiClient<any>("/api/v1/admin/mailbox");
  return {
    mailboxes: Array.isArray(data?.mailboxes) ? data.mailboxes : [],
    // The route's own `count(*)`, not a sum taken here. Summing the rows is
    // what produced the defect — over `depth`, a column this route has never
    // emitted — and it would go quietly small the day the grouping takes a
    // `LIMIT`. `null` when the field is absent, because a total that did not
    // arrive is not a queue of zero.
    total_queued: typeof data?.total_queued === "number" ? data.total_queued : null,
  };
}

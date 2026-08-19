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
  const known = Array.isArray(data?.mailboxes);
  const mailboxes: MailboxSummary[] = known ? data.mailboxes : [];
  return {
    mailboxes,
    total_queued: known ? mailboxes.reduce((acc, m) => acc + (m.pending ?? 0), 0) : null,
  };
}

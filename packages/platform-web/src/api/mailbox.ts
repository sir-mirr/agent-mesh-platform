import { apiClient } from "./client.ts";

export interface MailboxSummary {
  identity: string;
  depth: number;
  unacked_count: number;
  oldest_message_ts?: string | null;
  leased_count?: number;
}

export interface AdminMailboxResponse {
  mailboxes: MailboxSummary[];
  total_queued: number | null;
}

export async function fetchAdminMailbox(): Promise<AdminMailboxResponse> {
  const data = await apiClient<any>("/api/v1/admin/mailbox");
  const mailboxes = data.mailboxes ?? data.inboxes ?? [];
  return {
    mailboxes,
    total_queued: data.total_queued != null ? data.total_queued : (Array.isArray(mailboxes) && mailboxes.length > 0 ? mailboxes.reduce((acc: number, m: any) => acc + (m.depth || 0), 0) : null),
  };
}

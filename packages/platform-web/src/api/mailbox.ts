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
  total_queued: number;
}

export async function fetchAdminMailbox(): Promise<AdminMailboxResponse> {
  try {
    const data = await apiClient<any>("/api/v1/admin/mailbox");
    return {
      mailboxes: data.mailboxes ?? data.inboxes ?? [],
      total_queued: data.total_queued ?? data.mailboxes?.reduce((acc: number, m: any) => acc + (m.depth || 0), 0) ?? 0,
    };
  } catch (err) {
    console.warn("[API] fetchAdminMailbox error:", err);
    return { mailboxes: [], total_queued: 0 };
  }
}

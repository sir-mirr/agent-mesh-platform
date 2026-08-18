import { apiClient } from "./client.ts";

export interface TenantTrafficItem {
  tenant: string;
  received: number;
  recipients: number;
  senders: number;
  via_mailbox: number;
  last_at: string | null;
}

export interface TenantTrafficResponse {
  ok: boolean;
  hours: number;
  tenants: TenantTrafficItem[];
}

export async function fetchTenantTraffic(): Promise<TenantTrafficResponse> {
  return apiClient<TenantTrafficResponse>("/api/v1/admin/tenants");
}

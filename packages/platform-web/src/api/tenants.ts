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

/**
 * A tenant in the platform-owned directory, as opposed to one traffic row.
 *
 * `deleted_at` is deliberately not collapsed to a boolean. The timestamp is
 * the server's evidence that this is a soft-deleted row, and callers that show
 * history need the row to survive rather than treating it as absent.
 */
export interface TenantDirectoryItem {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

export interface TenantDirectoryResponse {
  ok: boolean;
  /** The tenant of the signed-in account. */
  tenant: string;
  tenants: TenantDirectoryItem[];
}

export interface TenantMutationResponse {
  ok: boolean;
  tenant: TenantDirectoryItem | null;
  action?: "deleted" | "already-deleted" | "not-found";
}

export async function fetchTenantDirectory(): Promise<TenantDirectoryResponse> {
  return apiClient<TenantDirectoryResponse>("/api/v1/admin/tenants/directory");
}

export async function createTenantApi(id: string, name: string): Promise<TenantMutationResponse> {
  return apiClient<TenantMutationResponse>("/api/v1/admin/tenants", {
    method: "POST",
    body: JSON.stringify({ id, name }),
  });
}

export async function renameTenantApi(id: string, name: string): Promise<TenantMutationResponse> {
  return apiClient<TenantMutationResponse>(`/api/v1/admin/tenants/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteTenantApi(id: string): Promise<TenantMutationResponse> {
  return apiClient<TenantMutationResponse>(`/api/v1/admin/tenants/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

import { apiClient } from "./client.ts";

export interface GrantItem {
  tenant?: string;
  subject: string;
  capability: string;
  scope?: string;
  granted_by?: string;
  granted_at?: string;
}

export interface GrantsResponse {
  ok: boolean;
  capabilities?: string[];
  grants: GrantItem[];
}

export async function fetchGrants(): Promise<GrantsResponse> {
  return await apiClient<GrantsResponse>("/api/v1/admin/grants", {
    method: "GET",
  });
}

export async function addGrantApi(subject: string, capability: string, scope: string = "*"): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>("/api/v1/admin/grants", {
    method: "POST",
    body: JSON.stringify({ subject, capability, scope }),
  });
}

export async function deleteGrantApi(subject: string, capability: string, scope: string = "*"): Promise<{ ok: boolean; removed?: boolean }> {
  return await apiClient<{ ok: boolean; removed?: boolean }>("/api/v1/admin/grants", {
    method: "DELETE",
    body: JSON.stringify({ subject, capability, scope }),
  });
}

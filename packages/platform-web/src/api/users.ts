import { apiClient } from "./client.ts";

export interface PendingUser {
  github_login: string;
  github_id?: string;
  role?: string;
  created_at?: string;
}

export async function fetchPendingUsers(): Promise<PendingUser[]> {
  try {
    const data = await apiClient<{ pending: PendingUser[] }>("/api/v1/admin/pending");
    return data.pending || [];
  } catch (err) {
    console.warn("[API] fetchPendingUsers error:", err);
    return [];
  }
}

export async function approveUserApi(githubLogin: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>("/api/v1/admin/approve", {
    method: "POST",
    body: JSON.stringify({ github_login: githubLogin }),
  });
}

export async function denyUserApi(githubLogin: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>("/api/v1/admin/deny", {
    method: "POST",
    body: JSON.stringify({ github_login: githubLogin }),
  });
}

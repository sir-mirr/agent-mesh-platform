import { apiClient } from "./client.ts";

export interface RegistryAgent {
  identity: string;
  type: string;
  description: string | null;
  status: "active" | "inactive" | "pending";
  created_at: string;
  last_seen_at?: string;
  fingerprint?: string;
}

export interface KeyProposal {
  identity: string;
  fingerprint: string;
  type?: string;
  proposed_at?: string;
}

export interface PairingCodeResponse {
  ok: boolean;
  code: string;
  identity: string;
  expires_at: string;
  ttl_seconds: number;
}

export async function fetchAgents(): Promise<RegistryAgent[]> {
  try {
    const data = await apiClient<any>("/api/v1/agents");
    return Array.isArray(data) ? data : data.agents ?? [];
  } catch (err) {
    console.warn("[API] fetchAgents error, returning empty list:", err);
    return [];
  }
}

export async function fetchPendingKeys(): Promise<KeyProposal[]> {
  try {
    const data = await apiClient<any>("/api/v1/admin/keys/pending");
    return Array.isArray(data) ? data : data.proposals ?? data.pending ?? [];
  } catch (err) {
    console.warn("[API] fetchPendingKeys error:", err);
    return [];
  }
}

export async function approveKeyProposal(fingerprint: string, reason?: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>("/api/v1/admin/keys/approve", {
    method: "POST",
    body: JSON.stringify({ fingerprint, reason: reason ?? "Approved via Platform Web Console" }),
  });
}

export async function denyKeyProposal(fingerprint: string, reason?: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>("/api/v1/admin/keys/deny", {
    method: "POST",
    body: JSON.stringify({ fingerprint, reason: reason ?? "Rejected by operator" }),
  });
}

export async function createPairingCodeApi(identity: string, ttlSeconds: number = 300): Promise<PairingCodeResponse> {
  return await apiClient<PairingCodeResponse>("/api/v1/admin/pairing-codes", {
    method: "POST",
    body: JSON.stringify({ identity, ttl_seconds: ttlSeconds }),
  });
}

import { apiClient } from "./client.ts";

/**
 * A row as `GET /api/v1/agents` actually sends it.
 *
 * That route returns `{id, name, description, channel, type}` and nothing else
 * — `main.ts:932`. Every other field here is absent, and every one of them used
 * to be filled in on arrival: `status` collapsed to `"active"`, `created_at` to
 * `new Date()`, `last_seen_at` to the same, `fingerprint` to a constant. The
 * screen then reported every agent as online, just created, recently seen and
 * cryptographically verified — **four claims, none of them from the server.**
 *
 * `null` is the honest value and the type has to permit it, because a required
 * field is what made inventing one the only way to compile.
 */
export interface RegistryAgent {
  identity: string;
  type: string;
  description: string | null;
  status: "active" | "inactive" | "pending" | null;
  created_at: string | null;
  last_seen_at: string | null;
  fingerprint: string | null;
}

export interface KeyProposal {
  identity: string;
  fingerprint: string | null;
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
  const data = await apiClient<any>("/api/v1/agents");
  const list: any[] = Array.isArray(data) ? data : data.agents ?? [];
  return list.map((a: any) => ({
    identity: a.identity || a.id || a.name || "unknown",
    type: a.type || a.channel || "agent",
    description: a.description || a.name || a.identity || null,
    // Not defaulted to "active". The absence of a status is not a report of
    // health, and reading it as one made every agent online on a screen whose
    // job is to show which ones are not.
    status: a.status === "inactive" ? "inactive" : a.status === "pending" ? "pending" : a.status === "active" ? "active" : null,
    // `new Date()` here meant every agent appeared to have been created at the
    // moment the page loaded.
    created_at: a.created_at ?? null,
    last_seen_at: a.last_seen_at ?? null,
    // **No fallback.** `GET /api/v1/agents` returns id, name, description,
    // channel and type — no fingerprint; the only route that carries one is the
    // key-proposal flow, which is a different thing behind `key.approve`. So
    // this defaulted for every row, and it defaulted to the literal
    // `sha256:verified_mesh_identity` under a column headed "Ed25519 public key
    // fingerprint".
    //
    // A fingerprint is what an operator compares to decide an identity is who
    // it claims to be. A constant in that place makes every agent match, and
    // the word `verified` inside it invites skipping the comparison — so a real
    // mismatch would have been invisible. Absent is the truth and has to look
    // like it.
    fingerprint: a.fingerprint ?? null,
  }));
}

export async function fetchPendingKeys(): Promise<KeyProposal[]> {
  const data = await apiClient<any>("/api/v1/admin/keys/pending");
  return Array.isArray(data) ? data : data.proposals ?? data.pending ?? [];
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

export async function teardownAgentApi(identity: string): Promise<{ ok: boolean }> {
  return await apiClient<{ ok: boolean }>(`/api/v1/admin/agents/${encodeURIComponent(identity)}`, {
    method: "DELETE",
  });
}

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
      // **No `status`.** SPEC § 9.1 says this route deliberately has no such
      // field: whether silence means `inactive` is an operating policy, not
      // something the route decides. These three comparisons read a key the
      // server has never sent, so all of them were dead and the value was
      // always `null` — a judgement dressed as a reading. What the route does
      // carry is `last_seen_at`, which is measured, and the screen says how long
      // ago rather than what that means.
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

/**
 * How long ago the mesh last saw an identity, in words.
 *
 * **`null` is not "offline".** SPEC § 9.1 says so at the route: `last_seen_at:
 * null` means the mesh holds no presence record for that identity, and whether
 * silence means `inactive` is an operating policy this screen does not get to
 * decide. So the three states stay three — seen at a time, never seen, and (for
 * a caller that has not asked yet) not loaded.
 */
/**
 * **The api layer stops writing sentences.**
 *
 * This returned Korean prose — `"접속 기록 없음"`, `"3시간 전 접속"` — from a module
 * with no dictionary in reach, so five screens printed Korean in English mode and
 * no key could reach it. It now returns the shape of the answer and the number;
 * the screen that draws it owns the words.
 */
export type LastSeen =
  | { kind: "never" }
  | { kind: "ago"; unit: "second" | "minute" | "hour" | "day"; value: number };

export function lastSeen(lastSeenAt: string | null | undefined): LastSeen {
  if (!lastSeenAt) return { kind: "never" };
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return { kind: "never" };
  const secs = Math.max(0, Math.round((Date.now() - seen) / 1000));
  if (secs < 60) return { kind: "ago", unit: "second", value: secs };
  if (secs < 3600) return { kind: "ago", unit: "minute", value: Math.floor(secs / 60) };
  if (secs < 86400) return { kind: "ago", unit: "hour", value: Math.floor(secs / 3600) };
  return { kind: "ago", unit: "day", value: Math.floor(secs / 86400) };
}

/** The sentence, composed where the dictionary is. */
export function lastSeenText(t: (key: string, fallback: string) => string, at: string | null | undefined): string {
  const v = lastSeen(at);
  if (v.kind === "never") return t("agents.neverSeen", "접속 기록 없음");
  const unit =
    v.unit === "second" ? t("agents.unit.second", "초")
    : v.unit === "minute" ? t("agents.unit.minute", "분")
    : v.unit === "hour" ? t("agents.unit.hour", "시간")
    : t("agents.unit.day", "일");
  return `${v.value}${unit} ${t("agents.ago", "전 접속")}`;
}

/** Has the mesh ever seen this identity? A measured fact, unlike "online". */
export function hasBeenSeen(a: { last_seen_at?: string | null }): boolean {
  return typeof a.last_seen_at === "string" && a.last_seen_at.length > 0;
}

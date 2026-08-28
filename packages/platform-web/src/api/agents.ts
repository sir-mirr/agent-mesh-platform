import type {
  RestAgentListResponse,
  RestKeyProposalsResponse,
  TeardownResponse,
} from "@agent-mesh/contracts";

import { apiClient } from "./client.ts";

/**
 * A row as `GET /api/v1/agents` actually sends it.
 *
 * That route returns identity metadata plus the tenant named by the platform.
 * Presence and key fields remain independently optional, and they used
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
  tenant: string | null;
  description: string | null;
  created_at: string | null;
  last_seen_at: string | null;
  fingerprint: string | null;
}

/**
 * The identities that belong on a screen labelled "agents".
 *
 * `GET /api/v1/agents` is deliberately a unified registry: approved web
 * accounts are rows with `type: "user"`, beside agent and service identities.
 * The route must stay unified, but an agent count or agent picker must not turn
 * a person into an agent merely because both came from the same response.
 *
 * This helper is opt-in at the view boundary rather than inside `fetchAgents`:
 * callers that genuinely present people can still receive the server's full
 * answer, while every agent-labelled view applies one shared rule.
 */
export function agentRegistryEntries<T extends Pick<RegistryAgent, "type">>(entries: readonly T[]): T[] {
  return entries.filter((entry) => entry.type !== "user");
}

/**
 * The members of a group that the same registry confirms are agents.
 *
 * Group membership uses the unified identity namespace too, so a person can
 * legitimately be a member for policy purposes. A card headed "agents" must
 * intersect that membership with the agent rows instead of counting every
 * identity in the group.
 */
export function agentMemberIdentities<T extends Pick<RegistryAgent, "identity" | "type">>(
  members: readonly string[],
  entries: readonly T[],
): string[] {
  const agentIds = new Set(agentRegistryEntries(entries).map((entry) => entry.identity));
  return members.filter((identity) => agentIds.has(identity));
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

/**
 * What a teardown answers, from the contracts package rather than from here.
 *
 * This was a local copy under a comment saying it was temporary "until teardown
 * is published from the contracts package". It is published — `v0.32.0` — so
 * the copy is gone and there is nothing left to keep aligned by hand. The
 * declaration a browser bundle can safely take was never the store's, which
 * opens `bun:sqlite`; it is this one.
 *
 * Re-exported rather than merely imported: the screens already reach these
 * through `@/api/agents.ts`, and a pointer costs nothing while a second import
 * path would invite one of them to drift back to a hand-written shape.
 *
 * One difference the copy had: `ok` was `boolean` here and is `true` in the
 * contract, because all three actions are success — a `not-found` teardown had
 * the outcome the caller asked for. A refusal is `TeardownRefusal`, and it is a
 * `400` or a `500`, not a `200` with `ok: false`.
 */
export type { TeardownAction, TeardownRefusal, TeardownResponse } from "@agent-mesh/contracts";

export async function fetchAgents(tenant?: string): Promise<RegistryAgent[]> {
  const query = tenant === undefined ? "" : `?tenant=${encodeURIComponent(tenant)}`;
  // Typed, so a field this maps has to be one the route sends. The list used
  // to be read as `Array.isArray(data) ? data : data.agents ?? []`, and the
  // first branch has never run: this route has always answered `{ agents }`.
  //
  // The array check stays, one level in. A type is a claim about a correct
  // server and not a guarantee from the network — an old build, a proxy or an
  // error page can still put anything here, and `undefined.map` would take the
  // screen down. What does not stay is guessing at *names*: the shape is
  // checked, the field names are not re-invented.
  const { agents } = await apiClient<RestAgentListResponse>(`/api/v1/agents${query}`);
  return (Array.isArray(agents) ? agents : []).map((a) => ({
    // **`id`, and nothing before it.** This read `a.identity || a.id || a.name
    // || "unknown"` — three of those four are names this route has never sent,
    // so the chain always reached the second link, and `"unknown"` was a row
    // the server cannot produce. The route's primary key is `id`; renaming it
    // here is a mapping, and the mapping has one source.
    identity: a.id,
    // `a.type || a.channel` folded two different facts into one: `type` is what
    // the identity *is* (`agent`, `user`, `service`) and `channel` is how it is
    // reached (`native`, `web`). Both are `NOT NULL` in `agent_registry` with
    // defaults, so the second link never ran — and had it run, a `web` channel
    // would have been drawn as an agent type.
    type: a.type,
    tenant: a.tenant ?? null,
    // `a.description || a.name` stays — both are sent, and `description` is the
    // one nullable column of the two, so the fallback is a live choice about
    // what to show rather than a guess at a field name. Only the third link
    // went: `a.identity` is not on this row.
    description: a.description || a.name || null,
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
  // **Two decision queues answered with the same key.** `GET admin/pending`
  // (people waiting to be admitted) and this one both replied
  // `{ pending: [...] }`, one path segment apart, so a reader holding a
  // response could not tell which queue it was — and the guessable one answers
  // `[]`. `D-689` split them: this route says `{ keys }` and the other
  // `{ users }`.
  //
  // **The move is finished.** This read carried a comment saying `keys` was
  // read here first "while nothing sends it yet"; `packages/http/src/keys-admin.ts`
  // has sent `keys` since. A comment that describes a route as it was is the
  // thing a reader consults when deciding whether the fallback beside it can
  // go — so the fallbacks and the sentence come out together.
  const { keys } = await apiClient<RestKeyProposalsResponse>("/api/v1/admin/keys/pending");
  return Array.isArray(keys) ? keys : [];
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

export async function teardownAgentApi(identity: string): Promise<TeardownResponse> {
  return await apiClient<TeardownResponse>(`/api/v1/admin/agents/${encodeURIComponent(identity)}`, {
    method: "DELETE",
  });
}

/**
 * How long ago the mesh last saw an identity, in words.
 *
 * **`null` is not "offline".** SPEC § 9.1 says so at the route: `last_seen_at:
 * null` means the mesh holds no presence record for that identity, and whether
 * silence means `inactive` is an operating policy this screen does not get to
 * decide. An unparsable value is also kept separate from no record: the server
 * sent something, but the client cannot truthfully turn it into a time.
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
  | { kind: "invalid" }
  | { kind: "ago"; unit: "second" | "minute" | "hour" | "day"; value: number };

export function lastSeen(lastSeenAt: string | null | undefined): LastSeen {
  if (!lastSeenAt) return { kind: "never" };
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return { kind: "invalid" };
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
  if (v.kind === "invalid") return t("agents.invalidLastSeen", "마지막 접속 시각 형식 오류");
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

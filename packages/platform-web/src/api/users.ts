import type { RestPendingAdmission, RestPendingAdmissionsResponse } from "@agent-mesh/contracts";

import { apiClient, listOf } from "./client";

/**
 * Local accounts — the people a platform admin admitted, as opposed to the
 * agents in the registry. The role lives here and nowhere else on the client:
 * a screen that needs to show somebody's role asks for this list rather than
 * deriving one from a username, which is how `/tenant/rbac` came to print
 * "Operator" beside every subject the server had never described.
 */
export interface LocalUser {
  username: string;
  display_name?: string;
  role: string;
  tenant?: string;
  created_at?: string;
  must_change_password?: boolean | number;
  /** `null` while active; an ISO timestamp after D-803 deactivation. */
  disabled_at?: string | null;
}

export interface LocalUsersResponse {
  ok: boolean;
  users: LocalUser[];
}

export async function fetchLocalUsers(): Promise<LocalUsersResponse> {
  return await apiClient<LocalUsersResponse>("/api/v1/admin/users", { method: "GET" });
}

export interface AdmittedUser {
  ok: boolean;
  user: LocalUser;
  /** Shown once, at the top of the response, and never returned again. */
  temporary_password: string;
}

export async function admitLocalUserApi(
  username: string,
  displayName?: string,
  tenant?: string,
  role?: "member",
): Promise<AdmittedUser> {
  return await apiClient<AdmittedUser>("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      display_name: displayName || undefined,
      tenant: tenant || undefined,
      role: role || undefined,
    }),
  });
}

export interface ReissuedPassword {
  ok: boolean;
  username: string;
  temporary_password: string;
  must_change_password: boolean;
}

/**
 * Replace an existing local account's password with a one-time temporary one.
 * The response is the only read path for the value, exactly as on admission.
 */
export async function reissueLocalUserPasswordApi(username: string): Promise<ReissuedPassword> {
  return await apiClient<ReissuedPassword>(
    `/api/v1/admin/users/${encodeURIComponent(username)}/password`,
    { method: "POST" },
  );
}

export interface LocalUserLifecycleResponse {
  ok: boolean;
  username: string;
  disabled_at: string | null;
}

/** Deactivate or reactivate one local account without deleting its history. */
export async function setLocalUserDeactivatedApi(
  username: string,
  deactivated: boolean,
): Promise<LocalUserLifecycleResponse> {
  const action = deactivated ? "deactivate" : "reactivate";
  return await apiClient<LocalUserLifecycleResponse>(
    `/api/v1/admin/users/${encodeURIComponent(username)}/${action}`,
    { method: "POST" },
  );
}

/**
 * People who asked to be let in and have not been decided on.
 *
 * This is a **different queue** from the key requests the bell draws. Both
 * routes answered `{ pending: [...] }` one path segment apart, and until this
 * function existed nothing in this front end asked for this one at all — an
 * operator standing on these screens could not see that anybody was waiting.
 * The server-rendered `/admin` page was the only surface that did.
 *
 * `D-689` moved this route to `{ users }`, and the older branch is gone.
 *
 * **The row shape is the contract's, not a local copy.** This declared its own
 * with three optional fields; the route sends all four, and `requested_at` is
 * nullable rather than absent — the column is `DATETIME DEFAULT
 * CURRENT_TIMESTAMP` with no `NOT NULL`. Optional and nullable are different
 * claims, and a reader that treats a null as a missing key defaults it, which
 * is how a request time gets invented.
 */
export type PendingAdmission = RestPendingAdmission;

export async function fetchPendingAdmissions(): Promise<PendingAdmission[]> {
  // The route moved to `{ users }` in `6b2b304`, so the older branch is gone:
  // leaving it would be the alias `D-689` refused to add, arriving by the back
  // door — a reader could not tell which name the server actually sends. The
  // sentence that used to end this comment said `agents.ts` still carried its
  // chain "because `keys/pending` has not moved"; it had, and both readers are
  // typed now.
  //
  // The array check stays: a type is a claim about a correct server, not a
  // guarantee from the network.
  const { users } = await apiClient<RestPendingAdmissionsResponse>("/api/v1/admin/pending");
  return listOf<PendingAdmission>(users, "/api/v1/admin/pending", "users");
}

export type AdmissionDecision = "approve" | "deny";

export interface AdmissionDecisionResponse {
  ok: boolean;
  github_login: string;
  status: "approved" | "denied";
}

/** Decide the GitHub sign-up request named by the operator. */
export async function decidePendingAdmissionApi(
  githubLogin: string,
  decision: AdmissionDecision,
): Promise<AdmissionDecisionResponse> {
  return await apiClient<AdmissionDecisionResponse>(`/api/v1/admin/${decision}`, {
    method: "POST",
    body: JSON.stringify({ github_login: githubLogin }),
  });
}

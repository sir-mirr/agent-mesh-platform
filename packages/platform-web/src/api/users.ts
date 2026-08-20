import { apiClient } from "./client";

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

export async function admitLocalUserApi(username: string, displayName?: string): Promise<AdmittedUser> {
  return await apiClient<AdmittedUser>("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ username, display_name: displayName || undefined }),
  });
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
 * `D-689` moves this route to `{ users }`; `users` is read first, ahead of the
 * name in use today, so the rename lands without a window where this draws
 * nothing. The older branch comes out once the route has moved.
 */
export interface PendingAdmission {
  github_login: string;
  github_id?: number;
  requested_at?: string;
  status?: string;
}

export async function fetchPendingAdmissions(): Promise<PendingAdmission[]> {
  const data = await apiClient<any>("/api/v1/admin/pending");
  return Array.isArray(data) ? data : data.users ?? data.pending ?? [];
}

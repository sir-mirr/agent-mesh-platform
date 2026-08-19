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

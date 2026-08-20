import { apiClient } from "./client.ts";
import type { Capability } from "@/types/auth.ts";

export interface LocalLoginResponse {
  ok: boolean;
  user: {
    github_id: number;
    github_login: string;
    role: string;
    capabilities?: Capability[];
  };
}

export interface AuthMeResponse {
  /**
   * The account has not chosen a password yet, so the session may do nothing
   * but change it. **Measured on the running server, not taken from a message:**
   * `/auth/me` carries this and the login response does not, though the note
   * announcing the route said both would. Reading it here is what makes the
   * screen's decision the server's answer.
   */
  must_change_password?: boolean;
  /**
   * Which tenant the account belongs to, or `null` when it belongs to none.
   *
   * The route carries this; this interface did not, so a screen reading it was
   * reading a field TypeScript said was absent. Declared rather than cast at
   * the call site, which is where the six hand-typed capability names came from.
   */
  tenant?: string | null;
  github_id: number;
  github_login: string;
  role: string;
  approved: boolean;
  capabilities?: Capability[];
  created_at: string;
}

export async function loginLocalApi(username: string, password: string): Promise<LocalLoginResponse> {
  const formData = new URLSearchParams();
  formData.append("username", username);
  formData.append("password", password);

  return await apiClient<LocalLoginResponse>("/auth/local", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
  });
}

export async function fetchAuthMe(): Promise<AuthMeResponse> {
  return await apiClient<AuthMeResponse>("/auth/me", {
    method: "GET",
    headers: {
      "Accept": "application/json",
    },
  });
}

export interface PasswordChangeResponse {
  ok: boolean;
  must_change_password: boolean;
}

/**
 * `current` is asked for again on purpose — a cookie left on an unattended
 * screen must not be enough to take the account.
 */
export async function changePasswordApi(current: string, next: string): Promise<PasswordChangeResponse> {
  return await apiClient<PasswordChangeResponse>("/auth/local/password", {
    method: "POST",
    body: JSON.stringify({ current, next }),
  });
}

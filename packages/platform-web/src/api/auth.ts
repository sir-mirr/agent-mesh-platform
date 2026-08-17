import { apiClient } from "./client.ts";

export interface LocalLoginResponse {
  ok: boolean;
  user: {
    github_id: number;
    github_login: string;
    role: string;
  };
}

export interface AuthMeResponse {
  github_id: number;
  github_login: string;
  role: string;
  approved: boolean;
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

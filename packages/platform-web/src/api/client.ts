import { ENV } from "@/config/env.ts";

/**
 * What failed, so a caller can tell *refused* from *not reached*.
 *
 * The thrown value used to be a bare `Error` carrying a message, and every
 * caller therefore had one bucket for "the server said no" and "there was no
 * server". `AuthContext` put a `502` from a proxy into the same branch as a
 * `401` and signed the person out — on a deployment that meant a backend
 * restart threw every operator to a login form that could not log them in.
 */
export class ApiError extends Error {
  /** The HTTP status, or `null` when the request never got an answer. */
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  /** The server answered and refused. A different thing from being unreachable. */
  get refused(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}


export async function apiClient<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const isAbsolute = path.startsWith("http://") || path.startsWith("https://");
  const url = isAbsolute ? path : `${ENV.API_BASE_URL}${path}`;

  const headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  // Auto set content-type for json bodies if not specified
  if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: "include", // Ensure mesh_token cookie is sent/received
    });
  } catch (cause: any) {
    // No answer at all — offline, DNS, connection refused. `status: null` is
    // the reading, and it is not zero and not a refusal.
    throw new ApiError(cause?.message || "서버에 연결할 수 없습니다", null);
  }

  if (!response.ok) {
    let errorData: any = {};
    try {
      errorData = await response.json();
    } catch {
      errorData = { error: response.statusText };
    }
    const errorMsg = errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new ApiError(errorMsg, response.status);
  }

  return (await response.json()) as T;
}

/**
 * Why a read failed, in the two words a screen has to tell apart.
 *
 * Every list on this console caught its error and drew one sentence: "the
 * server did not answer". Measured with a member session — the server answered,
 * with `403`, and the screen told them the backend was down. `ApiError` has
 * carried `refused` since the day a `502` was read as a signed-out session; the
 * screens had not started asking.
 */
export type FailureKind = "refused" | "unreachable";

export function failureKind(err: unknown): FailureKind {
  return err instanceof ApiError && err.refused ? "refused" : "unreachable";
}

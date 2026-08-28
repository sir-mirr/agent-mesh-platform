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
  /**
   * The capability the server named, when it named one.
   *
   * § 11.3's refusal carries `capability` and `scope` as fields so code and
   * diagnostics can distinguish the refused operation without parsing prose.
   * Operator-facing screens intentionally do not print this machine key; they
   * map the refusal to ordinary language and leave the field on the error for
   * programmatic handling.
   */
  readonly capability: string | null;
  /** A stable admin refusal code, when the response names one. */
  readonly code: string | null;
  constructor(
    message: string,
    status: number | null,
    capability: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.capability = capability;
    this.code = code;
  }
  /** The server answered and refused. A different thing from being unreachable. */
  get refused(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}


/**
 * One request, with the answer's shape named by the caller.
 *
 * **The default is `unknown`, not `any`.** `any` agreed with every shape,
 * including the ones the server does not send, so a caller could ask for a
 * field nobody emits and get `undefined` at runtime with nothing said at build
 * time — which is how a `status` on the agent list, a `depth` on the mailbox
 * summary and a `pending` on the admission queue were each read for months.
 * `unknown` makes the next caller that names no shape say what it expects
 * before it can read anything.
 *
 * The nine call sites that take the default all discard the value, so this
 * costs them nothing.
 */
/**
 * The list a route promised, or a refusal to guess.
 *
 * **`[]` is a claim about the mesh; this is a fact about the read.** A body
 * that is not the agreed shape used to be mapped to an empty array, and an
 * empty audit log is indistinguishable from a quiet mesh — the one thing an
 * audit screen must not be. Every screen here already distinguishes a failed
 * read from an empty answer, so throwing reaches the operator as "could not
 * read" instead of as "nothing happened".
 *
 * Not the same as trusting the type: `apiClient<T>` is a claim about a correct
 * server, and an old build, a proxy or an error page can still put anything on
 * the wire. This is where that is noticed rather than absorbed.
 */
export function listOf<T>(value: unknown, route: string, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  throw new Error(
    `${route} answered without a '${key}' array. This reader does not know that shape, ` +
      `and an empty list here would read as an empty mesh.`,
  );
}

export async function apiClient<T = unknown>(
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
    throw new ApiError(cause?.message || "no response from the server", null);
  }

  if (!response.ok) {
    let errorData: any = {};
    try {
      errorData = await response.json();
    } catch {
      errorData = { error: response.statusText };
    }
    const errorMsg = errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new ApiError(
      errorMsg,
      response.status,
      typeof errorData.capability === "string" ? errorData.capability : null,
      typeof errorData.code === "string" ? errorData.code : null,
    );
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

/**
 * What the server said was missing, or `null` when it did not say.
 *
 * Kept for programmatic decisions and diagnostics. Operator-facing copy must
 * not print the returned machine key; `refusedText` deliberately ignores it.
 */
export function refusedCapability(err: unknown): string | null {
  return err instanceof ApiError ? err.capability : null;
}

/**
 * The sentence a screen shows when the server refused.
 *
 * Nine screens had the capability typed into their copy — `(key.approve)`,
 * `(group.manage)`, `(mailbox.read.depth)` — nine guesses that were right on
 * the day they were written. The machine key still stays on the error for code
 * and diagnostics, but it is not operator-facing language.
 */
export function refusedText(t: (key: string, fallback: string) => string, _capability: string | null): string {
  const base = t("common.refusedRead", "이 계정에는 이 화면을 볼 권한이 없습니다");
  return `${base}.`;
}

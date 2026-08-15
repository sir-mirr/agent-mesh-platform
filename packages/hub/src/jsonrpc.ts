/**
 * JSON-RPC 2.0 framing (SPEC § 8).
 *
 * Responses are built as strings rather than objects because every one of them
 * is written straight to a socket; going through an intermediate object would
 * only mean serialising later.
 */

export interface JsonRpcRequest {
  jsonrpc?: string;
  method: string;
  params?: Record<string, any>;
  id?: string | number | null;
}

export function rpcResult(id: string | number | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", result, id: id ?? null });
}

export function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id: id ?? null,
  });
}

/** A notification carries no `id`, and a client must not answer it (SPEC § 8.8). */
export function rpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

/** Hub-specific codes. See SPEC § 8.1 and § 8.2. */
export const DUPLICATE_IDENTITY = -32010;
export const IDENTITY_NOT_REGISTERED = -32011;
/** SPEC § 8.2 — `from` or a `proxy_for` entry the socket may not claim. */
export const NOT_ENTITLED = -32013;
export const SERVER_ERROR = -32000;

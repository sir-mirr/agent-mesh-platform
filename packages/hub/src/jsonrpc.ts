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

/**
 * Send a frame, and say whether it went.
 *
 * **`ws.send` reports failure by returning, not by throwing**, and every call
 * site here was written as though it threw. Bun answers with the bytes written,
 * `-1` when the frame is buffered behind backpressure, and **`0` when the
 * socket is gone and the frame was dropped**. Measured, because the whole
 * question is whether one particular case throws:
 *
 * ```
 * open socket    ws.send("hi")          →  2
 * after close    ws.send("after close") →  0, and no exception
 * ```
 *
 * So a `try`/`catch` around a send to a closed socket never runs its `catch`,
 * and the code after the send — the code that records the message as
 * delivered — runs as if the frame had arrived. § 8.9.4 draws exactly this
 * line: a delivery record is a claim that a participant received something,
 * and handing a frame to a dead socket is not that. `mailbox.test.ts` asserts
 * it for the mailbox path in *acknowledgement is what records delivery, not
 * hand-out*; the socket path had no equivalent and needed one.
 *
 * `-1` is a success. The frame is queued in Bun's outgoing buffer and flushes
 * when the socket drains; treating backpressure as a loss would re-queue
 * messages the recipient is about to receive, and duplicate them.
 */
export function sendFrame(ws: { send(data: string): number }, frame: string): boolean {
  return ws.send(frame) !== 0;
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

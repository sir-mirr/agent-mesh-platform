import { apiClient } from "./client.ts";

export interface SendMessagePayload {
  to: string;
  text: string;
  reply_to?: string;
}

/**
 * What `POST /api/v1/messages` actually puts in `message` — the object is built
 * at the `201` in `packages/http/src/main.ts`, and `status` is the stored
 * column's vocabulary rather than one this layer invented.
 *
 * `pending` means the hub accepted the message and the recipient has not acked
 * it; `failed` means the hub refused it. `delivered` and `read` are written by
 * the inbound path afterwards, so a fresh send never carries them — and `sent`,
 * which this file used to declare, is a word the server has never written
 * anywhere. A screen that switches on a word no route sends has one unreachable
 * branch and one that draws every case.
 */
export interface MessageReceipt {
  id: string;
  from: string;
  to: string;
  ts: string;
  status: "pending" | "delivered" | "read" | "failed";
  file_path?: string;
}

/**
 * Unwraps `{ ok, message }` and **throws when the envelope is absent** rather
 * than falling back to the flat body.
 *
 * The implicit fallback is what this function used to do: it declared the flat
 * shape, the caller read `res.id` off an envelope, every field came back
 * `undefined`, and the screen drew a receipt of local placeholders while
 * reporting success. Falling back quietly reproduces exactly that. A thrown
 * error reaches the person; a receipt of placeholders does not.
 */
export async function sendMessageApi(payload: SendMessagePayload): Promise<MessageReceipt> {
  const body = await apiClient<{ ok?: boolean; message?: MessageReceipt }>("/api/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const message = body?.message;
  if (!message || typeof message.id !== "string") {
    throw new Error("서버가 영수증을 주지 않았습니다 — 201 응답에 message 가 없습니다");
  }
  return message;
}

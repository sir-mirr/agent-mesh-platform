import { apiClient } from "./client.ts";

export interface SendMessagePayload {
  to: string;
  text: string;
  reply_to?: string;
}

export interface MessageResponse {
  id: string;
  from: string;
  to: string;
  ts: string;
  text?: string;
  content?: string;
  status: "sent" | "delivered" | "failed";
}

export async function sendMessageApi(payload: SendMessagePayload): Promise<MessageResponse> {
  return await apiClient<MessageResponse>("/api/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchMessagesForAgent(agentId: string): Promise<MessageResponse[]> {
  const res = await apiClient<any>(`/api/v1/messages/${encodeURIComponent(agentId)}`);
  return Array.isArray(res) ? res : res.messages ?? [];
}

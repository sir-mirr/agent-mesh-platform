import { apiClient } from "./client.ts";

export interface AuditEventItem {
  id: string;
  timestamp: string;
  sender: string;
  recipient: string;
  contentLength: number;
  rawContent: string;
  signatureVerified: boolean | null;
}

export async function fetchAuditEvents(): Promise<AuditEventItem[]> {
  const data = await apiClient<any>("/api/v1/audit/events");
  const list = Array.isArray(data) ? data : data.events ?? [];
  return list.map((item: any) => ({
    id: item.event_id || item.id || `evt_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: item.timestamp || item.ts || new Date().toISOString(),
    sender: item.sender || item.from_agent || item.from || "unknown",
    recipient: item.recipient || item.to_agent || item.to || "unknown",
    contentLength: item.content_length || (typeof item.content === "string" ? item.content.length : JSON.stringify(item.content || item.payload || "").length),
    rawContent: typeof item.content === "string" ? item.content : item.content ? JSON.stringify(item.content) : typeof item.payload === "string" ? item.payload : item.payload ? JSON.stringify(item.payload) : "[content withheld]",
    signatureVerified: item.signature_verified != null ? Boolean(item.signature_verified) : null,
  }));
}

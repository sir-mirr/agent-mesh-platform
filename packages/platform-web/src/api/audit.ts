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
  return list.map((item: any) => {
    const payload = item.payload || {};
    const msg = payload.message || payload;
    const sender = msg.from || msg.sender || item.sender || item.identity || item.producer_id || "unknown";
    const recipient = msg.to || msg.recipient || item.recipient || item.target || "unknown";
    const content = typeof msg.content === "string" ? msg.content : (typeof payload.content === "string" ? payload.content : (typeof item.content === "string" ? item.content : (payload ? JSON.stringify(payload) : "[content withheld]")));
    const contentLength = item.content_length ?? (typeof content === "string" ? content.length : 0);
    const timestamp = item.occurred_at || item.stored_at || item.timestamp || item.ts || "—";
    const signatureVerified = item.attestation != null ? Boolean(item.attestation.valid ?? true) : (item.signature_verified != null ? Boolean(item.signature_verified) : null);

    return {
      id: item.event_id || item.id || `evt_${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      sender,
      recipient,
      contentLength,
      rawContent: content,
      signatureVerified,
    };
  });
}

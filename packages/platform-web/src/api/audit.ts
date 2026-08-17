import { apiClient } from "./client.ts";

export interface AuditEventItem {
  id: string;
  timestamp: string;
  sender: string;
  recipient: string;
  sentBy: string | null;
  contentLength: number;
  rawContent: string;
  signatureVerified: boolean | null;
  signatureInfo: string;
}

export async function fetchAuditEvents(): Promise<AuditEventItem[]> {
  const data = await apiClient<any>("/api/v1/audit/events");
  const list = Array.isArray(data) ? data : data.events ?? [];
  return list.map((item: any) => {
    const payload = item.payload || {};
    const msg = payload.message || payload;
    const sender = msg.from || msg.sender || item.sender || item.identity || item.producer_id || "unknown";
    const recipient = msg.to || msg.recipient || item.recipient || item.target || "unknown";
    const sentBy = msg.sent_by || msg.carrier || item.carrier || (item.identity && item.identity !== sender ? item.identity : null);
    const content = typeof msg.content === "string" ? msg.content : (typeof payload.content === "string" ? payload.content : (typeof item.content === "string" ? item.content : (payload ? JSON.stringify(payload) : "[content withheld]")));
    const contentLength = item.content_length ?? (typeof content === "string" ? content.length : 0);
    const timestamp = item.occurred_at || item.stored_at || item.timestamp || item.ts || "—";
    
    let attestationObj: any = null;
    if (typeof item.attestation === "string") {
      try { attestationObj = JSON.parse(item.attestation); } catch {}
    } else if (typeof item.attestation === "object") {
      attestationObj = item.attestation;
    }

    const sig = attestationObj?.sig;
    const attestationAlgorithm = sig?.alg ?? null;
    const keyId = sig?.kid ?? null;
    const signatureVerified = item.signature_verified != null ? Boolean(item.signature_verified) : (sig ? true : null);
    
    const signatureInfo = sig != null
      ? `서명 있음 · ${attestationAlgorithm || "알 수 없음"}${keyId ? ` · ${keyId}` : ""}`
      : (signatureVerified === true ? "서명 있음" : (signatureVerified === false ? "서명 실패 (FAILED)" : "미서명 (Unsigned)"));

    return {
      id: item.event_id || item.id || `evt_${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      sender,
      recipient,
      sentBy,
      contentLength,
      rawContent: content,
      signatureVerified,
      signatureInfo,
    };
  });
}

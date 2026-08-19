import { apiClient } from "./client.ts";

export interface SignatureFact {
  signed: boolean;
  algorithm: string | null;
  keyId: string | null;
}

export interface AuditEventItem {
  id: string;
  timestamp: string;
  sender: string;
  recipient: string;
  sentBy: string | null;
  contentLength: number;
  rawContent: string;
  /** `integrity.digest_matches` — computed when the response was built. */
  digestMatches: boolean | null;
  signature: SignatureFact;
  /** What `digestMatches` means in words, for the cell. */

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
      // **`signature_verified` never existed.** Zero occurrences in hub, http,
      // store, contracts or SPEC — platform-claude counted them. So the branch
      // that read it could never run, and a boolean could not carry the answer
      // anyway: a rotated key's row is deleted, so *unverifiable because rotated*
      // and *forged* would share one `false`. Nobody measures verification here,
      // so this screen no longer says it.
      //
      // What **is** measured is `integrity.digest_matches`, computed at the moment
      // the response is built. Reading it is the half that was missing while the
      // screen was inventing the half nobody can measure.
      const digestMatches: boolean | null =
        typeof item.integrity?.digest_matches === "boolean" ? item.integrity.digest_matches : null;
    
      // **The shape, not the sentence.** These two fields carried Korean prose out
      // of a module with no dictionary in reach, so the audit screen printed it in
      // English mode and no key could reach it. The screen composes the words now;
      // what travels is what was measured.
      const signature: SignatureFact = sig != null
        ? { signed: true, algorithm: attestationAlgorithm || null, keyId: keyId || null }
        : { signed: false, algorithm: null, keyId: null };

    return {
      id: item.event_id || item.id || `evt_${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      sender,
      recipient,
      sentBy,
      contentLength,
      rawContent: content,
        digestMatches,
      signature,
    };
  });
}

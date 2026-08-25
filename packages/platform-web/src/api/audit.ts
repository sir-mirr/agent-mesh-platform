import { apiClient } from "./client.ts";

export interface SignatureFact {
  signed: boolean;
  algorithm: string | null;
  keyId: string | null;
}

export interface AuditEventItem {
  id: string;
  eventType: string | null;
  timestamp: string;
  identity: string | null;
  actor: string | null;
  readTarget: string | null;
  changeFrom: string | null;
  changeTo: string | null;
  isMessage: boolean;
  sender: string | null;
  recipient: string | null;
  sentBy: string | null;
  contentLength: number | null;
  rawContent: string | null;
  rawPayload: unknown;
  /** Whether the returned payload contains a message/content field at all. */
  containsContent: boolean;
  /** True when the server supplied its redaction sentinel instead of a body. */
  redacted: boolean;
  /** `integrity.digest_matches` — computed when the response was built. */
  digestMatches: boolean | null;
  signature: SignatureFact;
  /** What `digestMatches` means in words, for the cell. */

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

function payloadHasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(payloadHasContent);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => key === "content" || payloadHasContent(nested));
}

function payloadHasWithheldContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(payloadHasWithheldContent);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    (key === "content" && typeof nested === "string" && /^\[content withheld\b/i.test(nested))
    || payloadHasWithheldContent(nested));
}

export async function fetchAuditEvents(): Promise<AuditEventItem[]> {
  const data = await apiClient<any>("/api/v1/audit/events");
  const list = Array.isArray(data) ? data : data.events ?? [];
  return list.map((item: any, index: number) => {
    const rawPayload: unknown = item.payload ?? null;
    const payload = isRecord(rawPayload) ? rawPayload : {};
    const message = isRecord(payload.message) ? payload.message : null;
    const eventType = typeof item.event_type === "string"
      ? item.event_type
      : typeof payload.event_type === "string"
        ? payload.event_type
        : null;
    const isMessage = message !== null || Boolean(eventType?.includes(".message."));
    const sender = isMessage
      ? stringField(message?.from, message?.sender, item.sender, item.identity, item.producer_id)
      : null;
    const recipient = isMessage
      ? stringField(message?.to, message?.recipient, item.recipient, item.target)
      : null;
    const sentBy = isMessage
      ? stringField(
        message?.sent_by,
        message?.carrier,
        item.carrier,
        typeof item.identity === "string" && item.identity !== sender ? item.identity : null,
      )
      : null;
    const content = typeof message?.content === "string"
      ? message.content
      : typeof payload.content === "string"
        ? payload.content
        : typeof item.content === "string"
          ? item.content
          : null;
    const containsContent = payloadHasContent(rawPayload) || item.content !== undefined;
    const redacted = payloadHasWithheldContent(rawPayload)
      || (typeof item.content === "string" && /^\[content withheld\b/i.test(item.content));
    const measuredLength = item.content_length ?? message?.content_length ?? payload.content_length;
    const contentLength = typeof measuredLength === "number"
      ? measuredLength
      : content === null
        ? null
        : content.length;
    const timestamp = stringField(item.occurred_at, item.stored_at, item.timestamp, item.ts) ?? "—";
    const identity = stringField(item.identity, payload.identity, item.producer_id);
    const actor = stringField(payload.actor, item.actor, identity);
    const change = isRecord(payload.change) ? payload.change : {};
    
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
      id: item.event_id || item.id || `event-${index + 1}`,
      eventType,
      timestamp,
      identity,
      actor,
      readTarget: typeof change.read === "string" ? change.read : null,
      changeFrom: typeof change.from === "string" ? change.from : null,
      changeTo: typeof change.to === "string" ? change.to : null,
      isMessage,
      sender,
      recipient,
      sentBy,
      contentLength,
      rawContent: content,
      rawPayload,
      containsContent,
      redacted,
      digestMatches,
      signature,
    };
  });
}

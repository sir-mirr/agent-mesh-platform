import type { RestAuditEvent, RestAuditEventsResponse } from "@agent-mesh/contracts";

import { apiClient, listOf } from "./client.ts";

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
  const data = await apiClient<RestAuditEventsResponse>("/api/v1/audit/events");
  // The bare-array branch went — this route answers `{ ok, events, next_cursor }`.
  // A body without an `events` array is refused rather than drawn as an empty
  // log: an empty audit screen is indistinguishable from a quiet mesh, which
  // is the one thing an audit screen must not be.
  const list = listOf<RestAuditEvent>(data?.events, "/api/v1/audit/events", "events");
  return list.map((item, index: number) => {
    const rawPayload: unknown = item.payload ?? null;
    const payload = isRecord(rawPayload) ? rawPayload : {};
    const message = isRecord(payload.message) ? payload.message : null;
    const eventType = typeof item.event_type === "string"
      ? item.event_type
      : typeof payload.event_type === "string"
        ? payload.event_type
        : null;
    const isMessage = message !== null || Boolean(eventType?.includes(".message."));
    // **The chains stop at the payload.** These read `item.sender`,
    // `item.recipient`, `item.target` and `item.carrier` as later links, and
    // `GET /api/v1/audit/events` sends none of the four: its rows carry
    // `event_id schema_version event_type occurred_at correlation_id
    // causation_event_id producer_id identity recorded_by payload
    // payload_digest integrity attestation stored_at attachments`. A link that
    // cannot fire still reads as a shape the server might send, and the tests
    // never fed one either.
    //
    // `payload.*` reads stay: the payload is arbitrary JSON stored verbatim, so
    // what is inside it genuinely varies.
    const sender = isMessage
      ? stringField(message?.from, message?.sender, item.identity, item.producer_id)
      : null;
    const recipient = isMessage ? stringField(message?.to, message?.recipient) : null;
    const sentBy = isMessage
      ? stringField(
        message?.sent_by,
        message?.carrier,
        typeof item.identity === "string" && item.identity !== sender ? item.identity : null,
      )
      : null;
    // `item.content` and `item.content_length` were the third link of each of
    // these. Content lives in the payload; the row has no column for it.
    const content = typeof message?.content === "string"
      ? message.content
      : typeof payload.content === "string"
        ? payload.content
        : null;
    const containsContent = payloadHasContent(rawPayload);
    const redacted = payloadHasWithheldContent(rawPayload);
    const measuredLength = message?.content_length ?? payload.content_length;
    const contentLength = typeof measuredLength === "number"
      ? measuredLength
      : content === null
        ? null
        : content.length;
    // `item.timestamp` and `item.ts` are not columns of this row either. The two
    // that are — `occurred_at` (when it happened) and `stored_at` (when the
    // store took it) — stay in that order, because the first is the fact and
    // the second is the fallback.
    const timestamp = stringField(item.occurred_at, item.stored_at) ?? "—";
    const identity = stringField(item.identity, payload.identity, item.producer_id);
    const actor = stringField(payload.actor, identity);
    const change = isRecord(payload.change) ? payload.change : {};
    
    // The route parses `attestation` before sending it (`audit-query.ts`
    // `JSON.parse(row.attestation)`), so it arrives as an object or `null` and
    // never as a string. The `typeof === "string"` branch that used to be here
    // could not run.
    const attestationObj: Record<string, any> | null =
      item.attestation !== null && typeof item.attestation === "object"
        ? (item.attestation as Record<string, any>)
        : null;

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
      // `item.id` was the second link and is not a column; `event_id` is the
      // primary key and is always sent. The synthesised `event-N` stays as the
      // last resort for a row that arrived without one at all.
      id: item.event_id || `event-${index + 1}`,
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

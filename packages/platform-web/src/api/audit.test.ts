/**
 * Reading an audit row, which arrives in more shapes than it should.
 *
 * The mapping here is a chain of fallbacks — `msg.from || msg.sender ||
 * item.sender || item.identity || item.producer_id` — and a chain is exactly
 * the kind of code that keeps working while meaning something different. Two
 * of these fields have already been wrong on the screen: `signature_verified`
 * was read for months and **never existed anywhere** in hub, http, store,
 * contracts or SPEC; and this module used to return Korean prose from a place
 * with no dictionary in reach, so the audit screen printed Korean in English.
 * What travels now is what was measured, and the screen composes the words.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { fetchAuditEvents } from "./audit.ts";

const realFetch = globalThis.fetch;
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };
const answer = (body: unknown) => {
  stub(mock(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
};
afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchAuditEvents", () => {
  it("reads the message's own names first", async () => {
    answer({ events: [{ event_id: "e1", occurred_at: "t", identity: "carrier",
      payload: { message: { from: "a", to: "b", content: "hello" } } }] });
    const [row] = await fetchAuditEvents();
    expect(row!.sender).toBe("a");
    expect(row!.recipient).toBe("b");
    // The carrier is the identity that delivered it, and it is only `sentBy`
    // when it is not the sender — otherwise every row claims a proxy.
    expect(row!.sentBy).toBe("carrier");
    expect(row!.rawContent).toBe("hello");
    expect(row!.redacted).toBe(false);
    expect(row!.contentLength).toBe(5);
  });

  it("marks a server redaction token as data, not operator-facing content", async () => {
    answer({ events: [{ event_id: "e1", payload: { message: {
      from: "a", to: "b", content: "[content withheld — requires audit.read.content]", content_length: 4096,
    } } }] });
    const [row] = await fetchAuditEvents();
    expect(row!.redacted).toBe(true);
    expect(row!.contentLength).toBe(4096);
  });

  it("detects content fields recursively even when their value is not a message string", async () => {
    answer({ events: [{ event_id: "e1", payload: { nested: { content: { secret: true } } } }] });
    expect((await fetchAuditEvents())[0]!.containsContent).toBe(true);

    answer({ events: [{ event_id: "e2", payload: { nested: {
      content: "[content withheld — requires audit.read.content]",
    } } }] });
    expect((await fetchAuditEvents())[0]!.redacted).toBe(true);
  });

  it("does not call the sender its own carrier", async () => {
    answer({ events: [{ event_id: "e1", identity: "a", payload: { message: { from: "a", to: "b" } } }] });
    expect((await fetchAuditEvents())[0]!.sentBy).toBe(null);
  });

  it("does not invent message endpoints for an event that has no message", async () => {
    answer({ events: [{ event_id: "e1", payload: {} }] });
    const [row] = await fetchAuditEvents();
    expect({ isMessage: row!.isMessage, sender: row!.sender, recipient: row!.recipient })
      .toEqual({ isMessage: false, sender: null, recipient: null });
  });

  it("keeps an audit read's type, actor, target and original payload", async () => {
    const payload = {
      event_type: "mesh.identity.audit_read",
      actor: "platform-admin",
      change: { read: "list", query: {} },
    };
    answer({ events: [{ event_id: "e1", occurred_at: "t", identity: "platform-admin", payload }] });
    const [row] = await fetchAuditEvents();
    expect({
      eventType: row!.eventType,
      actor: row!.actor,
      readTarget: row!.readTarget,
      rawPayload: row!.rawPayload,
      isMessage: row!.isMessage,
    }).toEqual({
      eventType: "mesh.identity.audit_read",
      actor: "platform-admin",
      readTarget: "list",
      rawPayload: payload,
      isMessage: false,
    });
  });

  it("reports a signature as a fact, not as a sentence", async () => {
    // The attestation arrives as an object. `audit-query.ts` does the
    // `JSON.parse` before answering, so a string is not a shape this route
    // sends — this fixture used to send one, and the branch reading it could
    // not run against the server.
    answer({ events: [{ event_id: "e1", payload: {},
      attestation: { sig: { alg: "ed25519", kid: "sha256:aa" } } }] });
    const [row] = await fetchAuditEvents();
    expect(row!.signature).toEqual({ signed: true, algorithm: "ed25519", keyId: "sha256:aa" });
  });

  it("calls an unsigned row unsigned rather than unknown", async () => {
    answer({ events: [{ event_id: "e1", payload: {} }] });
    expect((await fetchAuditEvents())[0]!.signature)
      .toEqual({ signed: false, algorithm: null, keyId: null });
  });

  it("survives an attestation that is not JSON", async () => {
    // A string is not an attestation on this wire — the route parses the
    // column before answering, so what arrives is an object or `null`. This
    // used to check that a guarded `JSON.parse` survived a bad string; it now
    // checks that a string is not read as a signature, which is the same
    // promise against the shape the route actually sends.
    answer({ events: [{ event_id: "e1", payload: {}, attestation: "{not json" }] });
    expect((await fetchAuditEvents())[0]!.signature.signed).toBe(false);
  });

  it("leaves digestMatches null when the row carries no integrity claim", async () => {
    answer({ events: [{ event_id: "e1", payload: {} }] });
    // `null` is "nobody checked", which is not `false` — the cell says so.
    expect((await fetchAuditEvents())[0]!.digestMatches).toBe(null);
    answer({ events: [{ event_id: "e1", payload: {}, integrity: { digest_matches: false } }] });
    expect((await fetchAuditEvents())[0]!.digestMatches).toBe(false);
  });

  it("refuses a body it does not recognise instead of drawing an empty log", async () => {
    // This asked for a bare array to be read. The route has always answered
    // `{ ok, events, next_cursor }` — and an empty audit screen is
    // indistinguishable from a quiet mesh, which is the one thing an audit
    // screen must not be. So an unrecognised body is a failed read, not none.
    answer([{ event_id: "e1", payload: {} }]);
    expect(fetchAuditEvents()).rejects.toThrow(/does not know that shape/);
  });
});

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

  it("does not call the sender its own carrier", async () => {
    answer({ events: [{ event_id: "e1", identity: "a", payload: { message: { from: "a", to: "b" } } }] });
    expect((await fetchAuditEvents())[0]!.sentBy).toBe(null);
  });

  it("says unknown rather than guessing when no name is carried", async () => {
    answer({ events: [{ event_id: "e1", payload: {} }] });
    const [row] = await fetchAuditEvents();
    expect(row!.sender).toBe("unknown");
    expect(row!.recipient).toBe("unknown");
  });

  it("reports a signature as a fact, not as a sentence", async () => {
    answer({ events: [{ event_id: "e1", payload: {},
      attestation: JSON.stringify({ sig: { alg: "ed25519", kid: "sha256:aa" } }) }] });
    const [row] = await fetchAuditEvents();
    expect(row!.signature).toEqual({ signed: true, algorithm: "ed25519", keyId: "sha256:aa" });
  });

  it("takes the attestation as an object as well as a string", async () => {
    answer({ events: [{ event_id: "e1", payload: {}, attestation: { sig: { alg: "ed25519", kid: "k" } } }] });
    expect((await fetchAuditEvents())[0]!.signature.signed).toBe(true);
  });

  it("calls an unsigned row unsigned rather than unknown", async () => {
    answer({ events: [{ event_id: "e1", payload: {} }] });
    expect((await fetchAuditEvents())[0]!.signature)
      .toEqual({ signed: false, algorithm: null, keyId: null });
  });

  it("survives an attestation that is not JSON", async () => {
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

  it("takes a bare array as well as { events }", async () => {
    answer([{ event_id: "e1", payload: {} }]);
    expect(await fetchAuditEvents()).toHaveLength(1);
  });
});

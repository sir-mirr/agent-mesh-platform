/**
 * The audit query API (SPEC § 9.1), driven over the store it reads.
 *
 * Four things here are the whole reason this route is not a `SELECT`:
 *
 * - **The digest is recomputed over the bytes actually stored.** Reading back
 *   the digest written at ingest proves nothing: a row edited afterwards
 *   carries a digest edited with it. An audit store whose rows can change
 *   without detection is a log.
 * - **Content is withheld from a metadata holder**, and its length is not —
 *   length is metadata, and it is what an operator diagnosing a stuck queue
 *   needs.
 * - **Some keys never come back at all**, whatever the caller holds. The
 *   payload is stored verbatim so its digest stays checkable, so redaction has
 *   to happen on the way out.
 * - **The cursor is the ordering key**, not an offset. An offset shifts under
 *   concurrent appends and either repeats a page or skips one.
 *
 * This file owns the `aq-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { auditSchema, openStore } from "@agent-mesh/store";

import { getEvent, listEvents } from "./audit-query";

/** Writable, because the query module holds a read-only handle by design. */
const store = openStore("audit", { create: true });
auditSchema.migrate(store);

let n = 0;
const uniq = (p: string) => `aq-${p}-${++n}-${process.pid}`;

const insert = store.prepare(`
  INSERT INTO audit_events (
    event_id, schema_version, event_type, occurred_at, correlation_id,
    causation_event_id, producer_id, identity, recorded_by_kind, recorded_by_id,
    payload, payload_digest, attestation, stored_at
  ) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** One stored event. `digest` defaults to the honest one over the payload. */
function stored(over: {
  identity?: string;
  eventType?: string;
  correlationId?: string;
  /** Who recorded it (§ 8.9.4). Defaults to an adapter reporting itself. */
  recordedBy?: { kind: string; identity: string | null };
  payload?: unknown;
  digest?: string;
  attestation?: unknown;
  storedAt?: string;
  eventId?: string;
} = {}) {
  const eventId = over.eventId ?? uniq("evt");
  const payload = JSON.stringify(over.payload ?? { message: { content: "the body" } });
  const digest = over.digest ?? createHash("sha256").update(payload, "utf8").digest("hex");
  const identity = over.identity ?? uniq("who");
  insert.run(
    eventId,
    over.eventType ?? "mesh.message.sent",
    "2027-07-07T00:00:00.000Z",
    over.correlationId ?? uniq("corr"),
    "probe-producer",
    identity,
    // Both arms of this used to read `"adapter"`, so no caller could store a
    // hub- or http-recorded event and every filter test ran against one kind.
    over.recordedBy?.kind ?? "adapter",
    over.recordedBy === undefined ? identity : over.recordedBy.identity,
    payload,
    digest,
    over.attestation === undefined ? null : JSON.stringify(over.attestation),
    over.storedAt ?? `2027-07-07 00:00:${String(n % 60).padStart(2, "0")}`,
  );
  return { eventId, identity, payload, digest };
}

const event = (r: ReturnType<typeof getEvent>) => (r.body as any).event;
const events = (r: ReturnType<typeof listEvents>) => (r.body as any).events as any[];

describe("one event", () => {
  test("says which event it cannot find, rather than answering empty", () => {
    const missing = uniq("nothing");
    const r = getEvent(missing, true);
    expect(r.status).toBe(404);
    expect((r.body as any).error).toContain(missing);
  });

  test("returns the record with its stored fields", () => {
    const e = stored({ eventType: "mesh.message.delivered" });
    const r = getEvent(e.eventId, true);
    expect(r.status).toBe(200);
    expect(event(r)).toMatchObject({
      event_id: e.eventId,
      event_type: "mesh.message.delivered",
      identity: e.identity,
      payload_digest: e.digest,
    });
  });

  /**
   * **Recomputed, not read back.** The digest column and the payload column
   * are two things a row can carry, and only comparing them says whether the
   * bytes are the ones that were signed for.
   */
  test("recomputes the digest over the bytes it is returning", () => {
    const honest = stored();
    expect(event(getEvent(honest.eventId, true)).integrity).toEqual({ digest_matches: true });

    const tampered = stored({ digest: "0".repeat(64) });
    expect(event(getEvent(tampered.eventId, true)).integrity).toEqual({ digest_matches: false });
  });

  /**
   * **Present is not verified.** The hub verified the signature at ingest and
   * this route does not re-verify — it cannot always, because a superseded
   * key's row is deleted. So the field says the event arrived signed, which is
   * a measured fact and a different one.
   */
  test("returns the attestation as it was stored, parsed", () => {
    const signed = stored({ attestation: { covers: "mesh.send.params", sig: "abc" } });
    expect(event(getEvent(signed.eventId, true)).attestation)
      .toEqual({ covers: "mesh.send.params", sig: "abc" });
    expect(event(getEvent(stored().eventId, true)).attestation).toBeNull();
  });

  /** A payload that will not parse is `null` rather than a thrown query. */
  test("answers with a null payload rather than failing on one it cannot parse", () => {
    const broken = stored({ payload: undefined });
    // Overwrite with bytes that are not JSON, keeping the row otherwise intact.
    store.prepare(`UPDATE audit_events SET payload = '{ not json' WHERE event_id = ?`).run(broken.eventId);
    const r = getEvent(broken.eventId, true);
    expect(r.status).toBe(200);
    expect(event(r).payload).toBeNull();
  });
});

describe("what a metadata holder may see", () => {
  test("withholds the content, and gives its length", () => {
    const e = stored({ payload: { message: { content: "twenty characters!!!", to: "b" } } });
    const withheld = event(getEvent(e.eventId, false)).payload.message;

    expect(withheld.content).toContain("requires audit.read.content");
    expect(withheld.content_length).toBe("twenty characters!!!".length);
    // Everything that is not the body is still there.
    expect(withheld.to).toBe("b");
  });

  test("hands the content over to a holder who may read it", () => {
    const e = stored({ payload: { message: { content: "the actual body" } } });
    expect(event(getEvent(e.eventId, true)).payload.message.content).toBe("the actual body");
  });

  /** Nested arrays are walked too, or a list of messages would leak through. */
  test("withholds content nested inside an array", () => {
    const e = stored({ payload: { batch: [{ content: "one" }, { content: "two" }] } });
    const batch = event(getEvent(e.eventId, false)).payload.batch;
    expect(batch.map((m: any) => m.content_length)).toEqual([3, 3]);
    expect(batch.every((m: any) => m.content.includes("withheld"))).toBe(true);
  });

  /**
   * **Some keys never come back**, for anybody. The store holds whatever a
   * client put in the payload, and the digest is over those bytes — so this is
   * the only place it can be removed without breaking the attestation.
   */
  test("redacts secrets whatever the caller holds", () => {
    const e = stored({
      payload: { authorization: "Bearer real-token", private_key: "k", nested: { privatekey: "k2" } },
    });
    for (const withContent of [true, false]) {
      const payload = event(getEvent(e.eventId, withContent)).payload;
      expect(JSON.stringify(payload)).not.toContain("real-token");
      expect(JSON.stringify(payload)).not.toContain("k2");
    }
  });
});

describe("listing them", () => {
  test("narrows to one identity", () => {
    const mine = uniq("mine");
    const a = stored({ identity: mine });
    stored({ identity: uniq("theirs") });
    expect(events(listEvents({ identity: mine }, true)).map((e) => e.event_id)).toEqual([a.eventId]);
  });

  /**
   * An operator asking whether anybody read message content had to page the
   * whole trail and look. That is a question the trail exists to answer.
   */
  test("narrows to one event type, exactly", () => {
    const identity = uniq("who");
    const read = stored({ identity, eventType: "mesh.audit.content_read" });
    stored({ identity, eventType: "mesh.message.sent" });

    const found = events(listEvents({ identity, event_type: "mesh.audit.content_read" }, true));
    expect(found.map((e) => e.event_id)).toEqual([read.eventId]);
  });

  test("narrows to one correlation, and to one recorder identity", () => {
    const corr = uniq("corr");
    const a = stored({ correlationId: corr, recordedBy: { kind: "adapter", identity: "adapter-one" } });
    stored({ correlationId: corr, recordedBy: { kind: "adapter", identity: "adapter-two" } });

    expect(events(listEvents({ correlation_id: corr }, true))).toHaveLength(2);
    expect(events(listEvents({ correlation_id: corr, recorded_by_identity: "adapter-one" }, true))
      .map((e) => e.event_id)).toEqual([a.eventId]);
  });

  test("narrows to one recorder kind, which is the only way to ask for the hub's own", () => {
    // **What `?provider=` could not do.** It compared the recorder identity,
    // and § 8.9.4 events carry null there — so no value of it selected a hub
    // record, and an operator narrowing a trail lost the hub's observations
    // without being told. The identity filter still cannot reach them, which is
    // asserted here rather than left implied: that is why there are two filters
    // and not a renamed one.
    const corr = uniq("corr");
    const hub = stored({ correlationId: corr, recordedBy: { kind: "hub", identity: null } });
    const adapter = stored({ correlationId: corr, recordedBy: { kind: "adapter", identity: "adapter-one" } });
    const read = stored({ correlationId: corr, recordedBy: { kind: "http", identity: "agent-mesh-http" } });

    const byKind = (kind: string) =>
      events(listEvents({ correlation_id: corr, recorded_by_kind: kind }, true)).map((e) => e.event_id);
    expect(byKind("hub")).toEqual([hub.eventId]);
    expect(byKind("adapter")).toEqual([adapter.eventId]);
    expect(byKind("http")).toEqual([read.eventId]);

    // No identity reaches the hub record. Tried with every value the other two
    // rows hold, plus the word an operator would guess.
    for (const value of ["adapter-one", "agent-mesh-http", "hub"]) {
      expect(
        events(listEvents({ correlation_id: corr, recorded_by_identity: value }, true))
          .map((e) => e.event_id),
        `recorded_by_identity=${value} reached the hub record`,
      ).not.toContain(hub.eventId);
    }
  });

  test("narrows to a window of stored time", () => {
    const identity = uniq("who");
    stored({ identity, storedAt: "2027-01-01 00:00:00" });
    const inside = stored({ identity, storedAt: "2027-06-15 12:00:00" });
    stored({ identity, storedAt: "2027-12-31 23:59:59" });

    const found = events(listEvents({ identity, from: "2027-02-01", to: "2027-07-01" }, true));
    expect(found.map((e) => e.event_id)).toEqual([inside.eventId]);
  });

  test("orders by stored time, oldest first", () => {
    const identity = uniq("who");
    const third = stored({ identity, storedAt: "2027-03-03 00:00:00" });
    const first = stored({ identity, storedAt: "2027-01-01 00:00:00" });
    const second = stored({ identity, storedAt: "2027-02-02 00:00:00" });

    expect(events(listEvents({ identity }, true)).map((e) => e.event_id))
      .toEqual([first.eventId, second.eventId, third.eventId]);
  });
});

describe("paging through them", () => {
  test("refuses a cursor it cannot read", () => {
    for (const cursor of ["nonsense", "|no-timestamp", ""]) {
      const r = listEvents({ cursor, identity: uniq("who") }, true);
      // An empty cursor is absent rather than malformed.
      if (cursor === "") expect(r.status).toBe(200);
      else expect({ cursor, status: r.status }).toEqual({ cursor, status: 400 });
    }
  });

  test("hands back a cursor only while there is another page", () => {
    const identity = uniq("who");
    for (let i = 0; i < 3; i++) stored({ identity, storedAt: `2027-04-0${i + 1} 00:00:00` });

    const first = listEvents({ identity, limit: "2" }, true);
    expect(events(first)).toHaveLength(2);
    expect((first.body as any).next_cursor).toBeTruthy();

    const second = listEvents({ identity, limit: "2", cursor: (first.body as any).next_cursor }, true);
    expect(events(second)).toHaveLength(1);
    expect((second.body as any).next_cursor).toBeNull();
  });

  /**
   * **Two events in the same millisecond.** `stored_at` alone gives the cursor
   * no way to say which it has already returned, so a page boundary landing
   * between them either skips one or repeats it. The row-value comparison is
   * what makes the tie-break correct.
   */
  test("does not skip or repeat an event that shares the boundary timestamp", () => {
    const identity = uniq("who");
    const at = "2027-05-05 05:05:05";
    const ids = ["aq-tie-a", "aq-tie-b", "aq-tie-c"].map((suffix) =>
      stored({ identity, storedAt: at, eventId: `${suffix}-${process.pid}` }).eventId,
    ).sort();

    const first = listEvents({ identity, limit: "1" }, true);
    const rest = listEvents(
      { identity, limit: "10", cursor: (first.body as any).next_cursor },
      true,
    );
    expect([...events(first), ...events(rest)].map((e) => e.event_id)).toEqual(ids);
  });

  test("clamps the page size rather than passing it through", () => {
    const identity = uniq("who");
    for (let i = 0; i < 3; i++) stored({ identity });
    for (const limit of ["0", "-5", "not a number"]) {
      expect(events(listEvents({ identity, limit }, true)).length).toBeGreaterThan(0);
    }
    expect(events(listEvents({ identity, limit: "1" }, true))).toHaveLength(1);
  });
});

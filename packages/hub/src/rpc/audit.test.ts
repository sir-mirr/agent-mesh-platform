/**
 * What `mesh.audit.prepare_blobs` and `mesh.audit.append` refuse, called directly.
 *
 * This module read **18.63% — 345 lines nothing had executed**, which is the
 * shape `receive.test.ts` beside it describes: the logic runs inside the hub,
 * a separate process, so no in-process instrument ever followed it. The
 * difference here is that it did not need a process *or* a database. Every
 * refusal below returns before the first statement touches a store, so the
 * whole validation surface of both methods is reachable from a plain test.
 *
 * **In-process on purpose, and that is the measurement.** `receive.test.ts`
 * spawns a child because it owns a temporary state directory and cleaning it up
 * would leave every later caller of `db.ts`'s `const` handles with
 * `SQLITE_IOERR`. A child is the right answer there and the wrong one here:
 * work done in a child is not counted by the parent's coverage instrument, so
 * a child-process test of a refusal raises confidence and not the number. These
 * tests write nothing, so they need no directory of their own and can run in
 * the shared one the preload sets.
 *
 * What is deliberately **not** here: the `missing` branch of
 * `prepare_blobs`, which calls `nonces.issueGrant` and inserts a row into the
 * run's shared `agents.db`. Covering twelve lines by writing into a database
 * other files are counting rows in is how a suite becomes order-dependent, and
 * this file exists because of a defect that shape already caused once.
 */
import { describe, expect, test } from "bun:test";

import { AUDIT_LIMITS, MAX_SCHEMA_VERSION } from "./audit-limits";
import { wsIdentities } from "../presence";
import { INVALID_PARAMS, INVALID_REQUEST } from "../jsonrpc";
import { AUDIT_MISSING_BLOBS, handleAuditAppend, handlePrepareBlobs } from "./audit";

/** A connection the hub considers authenticated, and one it does not. */
const connected = (identity = "audit-test-caller") => {
  const ws = {};
  wsIdentities.set(ws, identity);
  return ws;
};
const anonymous = () => ({});

type Answer = {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
};
const parse = (s: string): Answer => JSON.parse(s) as Answer;

/** `append` is signed over the bytes, so it takes the raw request too. */
const append = (ws: object, params: Record<string, any>, raw = `{"params":${JSON.stringify(params)}}`) =>
  parse(handleAuditAppend(ws, params, 7, raw, null));
const prepare = (ws: object, params: Record<string, any>) =>
  parse(handlePrepareBlobs(ws, params, 7));

const SHA = "a".repeat(64);

/**
 * A fresh event id for every call.
 *
 * The first version reused `"e1"`, and one test passed every check with no
 * attachments — so it reached the commit and **stored** the event. Three later
 * tests then got `AUDIT_EVENT_CONFLICT` instead of the refusal they were about,
 * and the file's own header had already named that shape. A refusal test that
 * depends on a row being absent from a shared database is order-dependent; a
 * unique id needs nothing to be true of the store.
 */
let n = 0;
const eid = () => `audit-test-${++n}`;

/**
 * One attachment whose bytes are certainly not on disk.
 *
 * Used by the *accepting* tests below, and not as decoration: a request that
 * passes every check commits, and a test asserting "this field was accepted"
 * must not also write a row. Stopping at `AUDIT_MISSING_BLOBS` proves the
 * field got past its own check without the call reaching the store.
 */
const ABSENT = [{ sha256: "f".repeat(64), size: 3, name: "absent.txt" }];

describe("mesh.audit.prepare_blobs refuses", () => {
  test("a caller that never connected", () => {
    const a = prepare(anonymous(), { event_id: "e1", blobs: [] });
    expect(a.error?.code).toBe(INVALID_REQUEST);
    expect(a.error?.message).toContain("mesh.connect");
  });

  test("no event_id", () => {
    expect(prepare(connected(), { blobs: [] }).error?.code).toBe(INVALID_PARAMS);
  });

  test("an event_id that is not a string", () => {
    expect(prepare(connected(), { event_id: 12, blobs: [] }).error?.message).toContain("event_id");
  });

  test("blobs that are not an array", () => {
    expect(prepare(connected(), { event_id: "e1", blobs: {} }).error?.message).toContain("must be an array");
  });

  test("more attachments than the advertised limit", () => {
    const over = Array.from({ length: AUDIT_LIMITS.max_attachments_per_event + 1 }, () => ({
      sha256: SHA, size: 1, name: "a.txt",
    }));
    const a = prepare(connected(), { event_id: "e1", blobs: over });
    expect(a.error?.message).toContain("too many attachments");
    // The number is in the message because an operator reading a refusal needs
    // to know which side of the limit they were on.
    expect(a.error?.message).toContain(String(AUDIT_LIMITS.max_attachments_per_event));
  });

  test("a blob entry that is not an object", () => {
    expect(prepare(connected(), { event_id: "e1", blobs: ["nope"] }).error?.message)
      .toContain("must be an object");
  });

  test("a digest that is not 64 lowercase hex", () => {
    for (const bad of ["A".repeat(64), "a".repeat(63), "z".repeat(64), 12]) {
      const a = prepare(connected(), { event_id: "e1", blobs: [{ sha256: bad, size: 1, name: "a" }] });
      expect(a.error?.message).toContain("64 lowercase hex");
    }
  });

  test("a size that is not a non-negative integer", () => {
    for (const bad of [-1, 1.5, "3", NaN]) {
      const a = prepare(connected(), { event_id: "e1", blobs: [{ sha256: SHA, size: bad, name: "a" }] });
      expect(a.error?.message).toContain("non-negative integer");
    }
  });

  test("a blob over max_blob_bytes", () => {
    const a = prepare(connected(), {
      event_id: "e1",
      blobs: [{ sha256: SHA, size: AUDIT_LIMITS.max_blob_bytes + 1, name: "a" }],
    });
    expect(a.error?.message).toContain("max_blob_bytes");
  });

  /**
   * The key retains the extension (§ 15.2), so the digest alone does not say
   * where the bytes land — which is why an absent name is a refusal and not a
   * default.
   */
  test("a blob with no name", () => {
    for (const bad of [undefined, "", 3]) {
      const a = prepare(connected(), { event_id: "e1", blobs: [{ sha256: SHA, size: 1, name: bad }] });
      expect(a.error?.message).toContain("name is required");
    }
  });

  /**
   * Each blob is under `max_blob_bytes` and the event is over
   * `max_attachments_bytes_per_event` — the limit that only a sum can breach,
   * and the one a per-blob check cannot see.
   */
  test("blobs that are each small enough and too large together", () => {
    // Sized from the limits rather than written down: two at `max_blob_bytes`
    // do not reach the per-event total, so the count comes from the ratio. A
    // constant here would stop testing the sum the day either limit moved.
    const each = AUDIT_LIMITS.max_blob_bytes;
    const count = Math.floor(AUDIT_LIMITS.max_attachments_bytes_per_event / each) + 1;
    expect(count).toBeLessThanOrEqual(AUDIT_LIMITS.max_attachments_per_event);
    expect(count * each).toBeGreaterThan(AUDIT_LIMITS.max_attachments_bytes_per_event);
    const a = prepare(connected(), {
      event_id: eid(),
      blobs: Array.from({ length: count }, (_, i) => ({
        sha256: String.fromCharCode(97 + i).repeat(64),
        size: each,
        name: `f${i}.txt`,
      })),
    });
    expect(a.error?.message).toContain("max_attachments_bytes_per_event");
  });
});

describe("mesh.audit.append refuses", () => {
  const base = () => ({
    schema_version: 1,
    event_id: eid(),
    event_type: "t",
    occurred_at: "2026-01-01T00:00:00Z",
  });

  test("a caller that never connected", () => {
    const a = append(anonymous(), base());
    expect(a.error?.code).toBe(INVALID_REQUEST);
  });

  test("a schema_version that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, "1", undefined]) {
      const a = append(connected(), { ...base(), schema_version: bad });
      expect(a.error?.message).toContain("positive integer");
    }
  });

  /**
   * Newer than this hub understands is refused rather than stored. Nothing is
   * lost — the client's outbox drains after the hub is upgraded — and storing
   * an event it cannot validate would record "validated" as a falsehood.
   */
  test("a schema_version newer than this hub validates", () => {
    const a = append(connected(), { ...base(), schema_version: MAX_SCHEMA_VERSION + 1 });
    expect(a.error?.code).toBe(INVALID_PARAMS);
    expect(a.error?.message).toContain(String(MAX_SCHEMA_VERSION));
  });

  test("the three required strings, each on its own", () => {
    for (const field of ["event_id", "event_type", "occurred_at"] as const) {
      for (const bad of [undefined, "", 5]) {
        const a = append(connected(), { ...base(), [field]: bad });
        expect(a.error?.message).toContain(field);
      }
    }
  });

  test("a producer_id that is not a string, or is over 64 chars", () => {
    for (const bad of [5, "x".repeat(65)]) {
      const a = append(connected(), { ...base(), producer_id: bad });
      expect(a.error?.message).toContain("producer_id");
    }
  });

  /**
   * Absent is allowed and exactly 64 is the boundary the check permits; the
   * field is optional and only its shape is examined. Each call carries an
   * attachment that is not on disk, so it refuses for that instead of
   * committing — the field is proved past its own check without a write.
   */
  test("but accepts producer_id absent or exactly 64 chars", () => {
    for (const good of [undefined, "x".repeat(64)]) {
      const a = append(connected(), { ...base(), producer_id: good, attachments: ABSENT });
      expect(a.error?.code).toBe(AUDIT_MISSING_BLOBS);
      expect(a.error?.message).not.toContain("producer_id");
    }
  });

  test("attachments that are not an array", () => {
    expect(append(connected(), { ...base(), attachments: "no" }).error?.message)
      .toContain("must be an array");
  });

  test("more attachments than the advertised limit", () => {
    const over = Array.from({ length: AUDIT_LIMITS.max_attachments_per_event + 1 }, () => ({
      sha256: SHA, size: 1, name: "a.txt",
    }));
    expect(append(connected(), { ...base(), attachments: over }).error?.message)
      .toContain("too many attachments");
  });

  test("an attachment that is not an object", () => {
    expect(append(connected(), { ...base(), attachments: [7] }).error?.message)
      .toContain("must be an object");
  });

  test("an attachment missing any of sha256, size, name", () => {
    for (const bad of [{ size: 1, name: "a" }, { sha256: SHA, name: "a" }, { sha256: SHA, size: 1 }]) {
      expect(append(connected(), { ...base(), attachments: [bad] }).error?.message)
        .toContain("requires sha256, size and name");
    }
  });

  /**
   * A blob that is not on disk is transient, not permanent: nothing commits, so
   * a retry after the upload is not a partial repair. The refusal names every
   * missing digest, because a client told only "some are missing" must re-upload
   * all of them.
   */
  test("attachments whose bytes are not on disk, naming each", () => {
    const a = append(connected(), {
      ...base(),
      attachments: [
        { sha256: SHA, size: 1, name: "a.txt" },
        { sha256: "c".repeat(64), size: 2, name: "b.txt" },
      ],
    });
    expect(a.error?.code).toBe(AUDIT_MISSING_BLOBS);
    expect(a.error?.data?.code).toBe("AUDIT_MISSING_BLOBS");
    expect(a.error?.data?.missing_sha256).toEqual([SHA, "c".repeat(64)]);
  });
});

describe("what every refusal carries", () => {
  /**
   * The id round-trips. A client matching answers to requests by id gets the
   * wrong answer if a refusal drops it, and a refusal is exactly when it cannot
   * afford to.
   */
  test("the request id, on both methods", () => {
    expect(parse(handlePrepareBlobs(anonymous(), {}, "req-1")).id).toBe("req-1");
    expect(parse(handleAuditAppend(anonymous(), {}, "req-2", "{}", null)).id).toBe("req-2");
  });

  test("a null id when the request had none", () => {
    expect(parse(handlePrepareBlobs(anonymous(), {}, undefined)).id).toBeNull();
  });
});

/**
 * The audit list, driven against a store handed in rather than found.
 *
 * Every case here is either a filter the console offers an operator or a way
 * the page can lie: a cursor that pages over a message, a `has_more` that is
 * guessed rather than measured, an unbounded `limit`, or a failed query
 * reported as an empty audit.
 *
 * This file owns the `ca-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DEFAULT_LIMIT, MAX_LIMIT, likeContains, listChatAudits, pageLimit } from "./chat-audits";

type Row = { id: string; from: string; to: string; content: string; ts: string };

function store(rows: Row[]): () => Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT,
    reply_to TEXT, status TEXT, ts TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, reply_to, status, ts) VALUES (?, ?, ?, ?, NULL, 'sent', ?)",
  );
  for (const r of rows) insert.run(r.id, r.from, r.to, r.content, r.ts);
  return () => db;
}

const at = (n: number) => `2027-04-0${n}T00:00:00.000Z`;

/** Three messages, one per day, between two pairs of identities. */
const three = () =>
  store([
    { id: "m1", from: "alpha", to: "beta", content: "first light", ts: at(1) },
    { id: "m2", from: "beta", to: "gamma", content: "second wind", ts: at(2) },
    { id: "m3", from: "alpha", to: "gamma", content: "third rail", ts: at(3) },
  ]);

const ids = (r: ReturnType<typeof listChatAudits>) =>
  (r.body as { messages: Array<{ id: string }> }).messages.map((m) => m.id);

describe("filtering", () => {
  test("returns the newest first when nothing is asked for", () => {
    const r = listChatAudits(three(), {});
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(["m3", "m2", "m1"]);
  });

  test("narrows to one sender", () => {
    expect(ids(listChatAudits(three(), { from_agent: "alpha" }))).toEqual(["m3", "m1"]);
  });

  /** The other end of the conversation is a separate filter, not the same one. */
  test("narrows to one recipient", () => {
    expect(ids(listChatAudits(three(), { to_agent: "gamma" }))).toEqual(["m3", "m2"]);
  });

  test("combines the two ends", () => {
    expect(ids(listChatAudits(three(), { from_agent: "alpha", to_agent: "gamma" })))
      .toEqual(["m3"]);
  });

  test("searches the body, not the identities", () => {
    expect(ids(listChatAudits(three(), { search: "wind" }))).toEqual(["m2"]);
    expect(ids(listChatAudits(three(), { search: "alpha" }))).toEqual([]);
  });

  /**
   * **An empty value is not a filter.** A console that clears its search box
   * sends `?search=`, and reading that as "match the empty string" would be
   * harmless while reading it as a filter on `''` returns nothing — the same
   * screen as an audit that holds nothing.
   */
  test("treats a cleared box as no filter at all", () => {
    expect(ids(listChatAudits(three(), { from_agent: "", to_agent: "", search: "" })))
      .toEqual(["m3", "m2", "m1"]);
  });

  /**
   * **`search` is a literal substring (D-743).** The value is bound, so the
   * unescaped version was over-matching rather than injection — but `%`
   * matched any run, and an operator searching for `50%` was handed every
   * message in the audit. On this screen the wrong direction to fail in is
   * *more content than was asked for*, against the one capability that exists
   * to keep it narrow. Decided by the console's owner (fe-codex), adopted as
   * D-743.
   */
  test("treats LIKE wildcards as the characters they are", () => {
    const db = store([
      { id: "p1", from: "x", to: "y", content: "at 50% capacity", ts: at(1) },
      { id: "p2", from: "x", to: "y", content: "no percentage here", ts: at(2) },
      { id: "p3", from: "x", to: "y", content: "an a_b identifier", ts: at(3) },
      { id: "p4", from: "x", to: "y", content: "an axb identifier", ts: at(4) },
      { id: "p5", from: "x", to: "y", content: "a back\\slash", ts: at(5) },
    ]);
    expect(ids(listChatAudits(db, { search: "%" }))).toEqual(["p1"]);
    expect(ids(listChatAudits(db, { search: "50%" }))).toEqual(["p1"]);
    expect(ids(listChatAudits(db, { search: "a_b" }))).toEqual(["p3"]);
    expect(ids(listChatAudits(db, { search: "\\" }))).toEqual(["p5"]);
  });

  test("escapes the escape character before the wildcards it introduces", () => {
    expect(likeContains("plain")).toBe("%plain%");
    expect(likeContains("50%")).toBe("%50\\%%");
    expect(likeContains("a_b")).toBe("%a\\_b%");
    expect(likeContains("\\")).toBe("%\\\\%");
    expect(likeContains("\\%")).toBe("%\\\\\\%%");
  });
});

describe("paging", () => {
  test("measures has_more rather than guessing it", () => {
    const all = listChatAudits(three(), {});
    expect((all.body as { has_more: boolean }).has_more).toBe(false);

    const page = listChatAudits(three(), { limit: "2" });
    expect(ids(page)).toEqual(["m3", "m2"]);
    expect((page.body as { has_more: boolean }).has_more).toBe(true);
    expect((page.body as { oldest_id: string }).oldest_id).toBe("m2");
  });

  test("names no cursor when the page is empty", () => {
    const r = listChatAudits(three(), { from_agent: "nobody" });
    expect((r.body as { oldest_id: string | null }).oldest_id).toBeNull();
    expect((r.body as { has_more: boolean }).has_more).toBe(false);
  });

  test("continues strictly below the cursor", () => {
    expect(ids(listChatAudits(three(), { before_id: "m2" }))).toEqual(["m1"]);
  });

  /**
   * **Two messages sharing an instant must not page over each other.** The
   * cursor anchors on `ts` with `id` as the tiebreak; on `ts` alone the second
   * of a pair written in the same millisecond is skipped, and nothing in the
   * response says a message was lost.
   */
  test("does not skip a message that shares the cursor's instant", () => {
    const db = store([
      { id: "a1", from: "x", to: "y", content: "one", ts: at(1) },
      { id: "a2", from: "x", to: "y", content: "two", ts: at(2) },
      { id: "a3", from: "x", to: "y", content: "three", ts: at(2) },
    ]);
    expect(ids(listChatAudits(db, {}))).toEqual(["a3", "a2", "a1"]);
    expect(ids(listChatAudits(db, { before_id: "a3" }))).toEqual(["a2", "a1"]);
  });

  /**
   * A client holding a message that has since been deleted gets the top of the
   * list, not a refusal — the cursor is a convenience, and losing it is not an
   * error the operator can do anything about.
   */
  test("pages from the top when the cursor names a message that is gone", () => {
    expect(ids(listChatAudits(three(), { before_id: "no-such-id" }))).toEqual(["m3", "m2", "m1"]);
  });
});

describe("the page size", () => {
  test("defaults when absent, unreadable, or not positive", () => {
    for (const raw of [undefined, "", "abc", "0", "-5"]) {
      expect(pageLimit(raw)).toBe(DEFAULT_LIMIT);
    }
  });

  /** Text, so `NaN` is reachable here — unlike the same guard behind a JSON body. */
  test("is clamped rather than trusted", () => {
    expect(pageLimit("1")).toBe(1);
    expect(pageLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
    expect(pageLimit("1000000")).toBe(MAX_LIMIT);
  });

  test("is the size the query actually asks for", () => {
    expect(ids(listChatAudits(three(), { limit: "1" }))).toEqual(["m3"]);
    expect(ids(listChatAudits(three(), { limit: "abc" }))).toEqual(["m3", "m2", "m1"]);
  });
});

describe("when the store will not answer", () => {
  /**
   * **A failed query is not an empty audit.** Returning `{ messages: [] }`
   * from the catch would tell an operator the mesh had no traffic, which is
   * the one answer they cannot check.
   */
  test("refuses with the reason, rather than an empty page", () => {
    const realError = console.error;
    const said: string[] = [];
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    let r: ReturnType<typeof listChatAudits>;
    try {
      r = listChatAudits(() => new Database(":memory:"), {});   // no `messages` table
    } finally {
      console.error = realError;
    }
    expect(r!.status).toBe(500);
    const body = r!.body as { error: string; detail: string };
    expect(body.error).toBe("Failed to query chat audits");
    expect(body.detail).toContain("messages");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("[chat-audits] query failed");
  });

  test("refuses the same way when the handle itself cannot be opened", () => {
    const realError = console.error;
    console.error = () => {};
    let r: ReturnType<typeof listChatAudits>;
    try {
      r = listChatAudits(() => { throw new Error("hub.db is not there"); }, {});
    } finally {
      console.error = realError;
    }
    expect(r!.status).toBe(500);
    expect((r!.body as { detail: string }).detail).toContain("hub.db is not there");
  });
});

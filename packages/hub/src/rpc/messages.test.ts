/**
 * `mesh.fetch_messages` — recent history with one peer (SPEC § 8.4).
 *
 * Read 7.14%: fifty-two lines the hub runs and nothing in this process had.
 * There is no cursor — § 8.4 dropped `before` as unimplemented — so `limit` is
 * the only reach a caller has, and what that clamp does is the whole of the
 * method's behaviour beyond a query.
 *
 * The run's shared state directory, unique identities, no cleanup.
 */
import { describe, expect, test } from "bun:test";

import { INVALID_PARAMS, INVALID_REQUEST } from "../jsonrpc";
import { db } from "../db";
import { wsIdentities } from "../presence";
import { handleFetchMessages } from "./messages";

let n = 0;
const nextId = (p: string) => `fm-${p}-${++n}-${process.pid}`;

const connected = (identity: string) => {
  const ws = {};
  wsIdentities.set(ws, identity);
  return ws;
};

/** `ts` ascending, so the newest is the last one written. */
const say = (from: string, to: string, content: string, offsetSeconds: number) =>
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
     VALUES (?, ?, ?, ?, 'delivered', datetime('now', ? || ' seconds'))`,
  ).run(nextId("msg"), from, to, content, String(offsetSeconds));

type Answer = {
  result?: { messages: Array<Record<string, any>> };
  error?: { code: number; message: string };
};
const fetchMessages = (ws: object, params: Record<string, any>): Answer =>
  JSON.parse(handleFetchMessages(ws, params, 1));

describe("mesh.fetch_messages refuses", () => {
  test("a caller with no connection", () => {
    const a = fetchMessages({}, { agent_id: "b" });
    expect(a.error?.code).toBe(INVALID_REQUEST);
    expect(a.error?.message).toContain("mesh.connect");
  });

  test("a missing or non-string agent_id", () => {
    const ws = connected(nextId("caller"));
    for (const bad of [undefined, "", 7, {}]) {
      const a = fetchMessages(ws, { agent_id: bad });
      expect(a.error?.code).toBe(INVALID_PARAMS);
      expect(a.error?.message).toContain("agent_id is required");
    }
  });
});

describe("what it returns", () => {
  /**
   * Both directions of one conversation. The query is symmetric on purpose —
   * "history with a peer" is not "what they sent me" — and a one-sided version
   * would read as an empty conversation to whoever spoke last.
   */
  test("the conversation, not one side of it, newest first", () => {
    const me = nextId("me");
    const peer = nextId("peer");
    say(me, peer, "mine-older", -30);
    say(peer, me, "theirs-newer", -10);

    const a = fetchMessages(connected(me), { agent_id: peer });
    expect(a.result?.messages.map((m) => m.content)).toEqual(["theirs-newer", "mine-older"]);
  });

  /**
   * The wire names, which are not the column names. A row carries `from_agent`
   * and `to_agent`; § 8.4 sends `from` and `to`, and a client reading the
   * column names off a database dump would build against fields this never
   * sends.
   */
  test("the wire's field names rather than the table's", () => {
    const me = nextId("me");
    const peer = nextId("peer");
    say(peer, me, "hello", -5);

    const [m] = fetchMessages(connected(me), { agent_id: peer }).result!.messages;
    expect(Object.keys(m!).sort()).toEqual(
      ["content", "from", "id", "reply_to", "sent_by", "status", "to", "ts"],
    );
    expect(m!.from).toBe(peer);
    expect(m!.to).toBe(me);
  });

  test("nothing, for a peer this caller has never spoken to", () => {
    const a = fetchMessages(connected(nextId("lonely")), { agent_id: nextId("stranger") });
    expect(a.result?.messages).toEqual([]);
  });

  /**
   * Another pair's conversation is not this caller's history. The query is
   * scoped to the caller on both sides, so naming a peer does not reach
   * anything the caller was not part of.
   */
  test("and never a conversation the caller was not in", () => {
    const me = nextId("me");
    const a = nextId("a");
    const b = nextId("b");
    say(a, b, "not-for-me", -5);
    expect(fetchMessages(connected(me), { agent_id: a }).result?.messages).toEqual([]);
  });
});

describe("the limit, which is the only reach a caller has", () => {
  const withHistory = (count: number) => {
    const me = nextId("me");
    const peer = nextId("peer");
    for (let i = 0; i < count; i++) say(peer, me, `m${i}`, -(count - i));
    return { ws: connected(me), peer };
  };

  test("defaults to twenty when absent, and when it is nonsense", () => {
    const { ws, peer } = withHistory(25);
    for (const limit of [undefined, "not-a-number", null, {}]) {
      expect(fetchMessages(ws, { agent_id: peer, limit }).result?.messages).toHaveLength(20);
    }
  });

  test("is taken as given inside the range", () => {
    const { ws, peer } = withHistory(25);
    expect(fetchMessages(ws, { agent_id: peer, limit: 5 }).result?.messages).toHaveLength(5);
    expect(fetchMessages(ws, { agent_id: peer, limit: "7" }).result?.messages).toHaveLength(7);
  });

  /**
   * Zero and a negative take different paths, and the difference is `||`.
   *
   * `limit: 0` is falsy, so `parseInt(...) || 20` reads it as *unspecified* and
   * the default applies. `limit: -1` is truthy, survives that, and lands on the
   * `Math.max(_, 1)` floor. Neither answers an empty conversation, which is the
   * property that matters; pinned as two cases because a reader who assumed one
   * rule for both would be wrong, and that reader was me.
   */
  test("reads zero as unspecified, and a negative as too small", () => {
    const { ws, peer } = withHistory(25);
    expect(fetchMessages(ws, { agent_id: peer, limit: 0 }).result?.messages).toHaveLength(20);
    for (const limit of [-1, -100]) {
      expect(fetchMessages(ws, { agent_id: peer, limit }).result?.messages).toHaveLength(1);
    }
  });

  /**
   * **The store has to be able to answer more than the ceiling**, or the ceiling
   * is not what is being measured. The first version of this asked for 100000
   * against three rows and asserted three — true whether the clamp exists or
   * not, and the registered mutation said so by surviving. 205 rows make the
   * two answers differ.
   */
  test("and down to two hundred, whatever is asked for", () => {
    const { ws, peer } = withHistory(205);
    expect(fetchMessages(ws, { agent_id: peer, limit: 100000 }).result?.messages).toHaveLength(200);
    expect(fetchMessages(ws, { agent_id: peer, limit: 201 }).result?.messages).toHaveLength(200);
  });
});

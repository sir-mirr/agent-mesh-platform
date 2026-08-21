/**
 * What `mesh.connect` refuses, and what a refused proxy claim must not receive.
 *
 * `connect.ts` read 18.46% — 159 lines nothing had executed — for the reason
 * `audit.test.ts` beside it names: the path runs inside the hub, a separate
 * process, and no in-process instrument had followed it. `performConnect` is an
 * exported function over this module's own handles, so it does not need one.
 *
 * The test worth the most here is not a refusal. **§ 8.2 says a proxy claim the
 * caller is not entitled to is dropped rather than failing the connect** — the
 * http server declares every approved person at once, and refusing the whole
 * connection over one entry would take the entire web surface down. That
 * decision is only safe if the dropped entry is also dropped from the *replay*:
 * handing this socket another identity's queued mail and marking it delivered
 * is interception dressed as routing, and the rightful recipient would never
 * receive it. The comment above the replay loop says `granted, not declared`;
 * nothing asked whether the code agreed.
 *
 * Uses the run's shared state directory rather than one of its own. A file that
 * owns a temporary directory and removes it leaves every later caller of
 * `db.ts`'s `const` handles with `SQLITE_IOERR` — `delivery-landing.test.ts`
 * lost an hour to exactly that. Every identity here is unique instead, so
 * nothing depends on what the store does or does not already hold.
 */
import { describe, expect, test } from "bun:test";

import { AUDIT_LIMITS, MAX_SCHEMA_VERSION } from "./audit-limits";
import { INVALID_PARAMS } from "../jsonrpc";
import { agentsDb, db } from "../db";
import { onlineAgents, proxyMap, wsIdentities } from "../presence";
import { deliverPending, handleConnect, handleRegister, performConnect } from "./connect";

let n = 0;
const nextId = (prefix: string) => `${prefix}-${++n}-${process.pid}`;

/** A socket whose frames land, and which records what it was asked to close with. */
function socket() {
  const sent: string[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return {
    data: { observed: "203.0.113.7" },
    sent,
    closed,
    send(frame: string) { sent.push(frame); return frame.length; },
    close(code: number, reason: string) { closed.push({ code, reason }); },
  };
}

const register = (identity: string, type = "ai-claude") =>
  agentsDb.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, ?)`).run(identity, type);

/** A type that carries no key of its own, which is what `mayProxy` requires. */
const selfSigningFreeType = (type: string) => {
  agentsDb
    .prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES (?, 0)`)
    .run(type);
  return type;
};

const allowProxy = (identity: string) =>
  agentsDb.prepare(`UPDATE agents SET can_proxy = 1 WHERE identity = ?`).run(identity);

const queue = (to: string, id: string) =>
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
     VALUES (?, 'a-sender', ?, 'queued', 'pending', datetime('now'))`,
  ).run(id, to);

const statusOf = (id: string) =>
  (db.prepare(`SELECT status FROM messages WHERE id = ?`).get(id) as { status: string } | undefined)?.status;

type Answer = {
  id: string | number | null;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
};
const connect = (ws: object, params: Record<string, any>, id: string | number = 1): Answer =>
  JSON.parse(performConnect(ws, params, id, "connect"));

describe("mesh.connect refuses", () => {
  test("no identity, and an identity that is not a string", () => {
    for (const bad of [undefined, "", 42, {}]) {
      const a = connect(socket(), { identity: bad });
      expect(a.error?.code).toBe(INVALID_PARAMS);
      expect(a.error?.message).toContain("identity is required");
    }
  });

  /**
   * Registration is `POST /api/v1/agents` (SPEC § 10.1). Connecting an unknown
   * identity used to auto-create a typeless row, which showed as "Unknown" in
   * the console for ever, so this refuses and names the route that fixes it.
   */
  test("an identity that was never provisioned, and closes the socket after", async () => {
    const identity = nextId("never-registered");
    const ws = socket();
    const a = connect(ws, { identity });

    expect(a.error?.code).toBe(-32011);
    expect(a.error?.data?.code).toBe("IDENTITY_NOT_REGISTERED");
    expect(a.error?.data?.identity).toBe(identity);
    // The refusal names the route rather than only the rule — an operator
    // reading it should not have to look up what to do next.
    expect(a.error?.message).toContain("/api/agents");

    // The close is on a timer so the error frame goes out first.
    expect(ws.closed).toEqual([]);
    await Bun.sleep(40);
    expect(ws.closed).toEqual([{ code: 1008, reason: "identity not registered" }]);
  });

  /**
   * First established owner wins, however late the collision arrives. The
   * refusal carries both connection generations because a race is otherwise
   * unattributable, and nothing else — no address, no payload, no credential.
   */
  test("a second socket claiming a live identity, keeping the incumbent", () => {
    const identity = nextId("duplicate");
    register(identity);
    const incumbent = socket();
    expect(connect(incumbent, { identity }).result?.ok).toBe(true);

    const contender = socket();
    const a = connect(contender, { identity });
    expect(a.error?.code).toBe(-32010);
    expect(a.error?.data?.code).toBe("DUPLICATE_IDENTITY");
    expect(a.error?.data?.ownership).toBe("incumbent_retained");
    expect(a.error?.data?.source_metadata).toBe("server_connection_sequence");
    expect(typeof a.error?.data?.incumbent_connection_generation).toBe("number");
    expect(a.error?.data?.contender_connection_generation)
      .toBeGreaterThan(a.error?.data?.incumbent_connection_generation);

    // The map still points at the socket that was already there.
    expect(onlineAgents.get(identity)).toBe(incumbent as any);
    expect(wsIdentities.get(contender)).toBeUndefined();
  });
});

describe("what a connect answers", () => {
  /**
   * Advertised so a client can tell a hub that accepts audit from one that does
   * not, and size a batch without guessing (§ 8.9.1). `schema_version_max` is
   * additive to the contract's shape: `version` is the protocol version and
   * this is the highest event schema, and a client keying off the wrong one
   * would gate the whole audit surface on a field that moves for another reason.
   */
  test("the audit limits, with the event schema ceiling beside them", () => {
    const identity = nextId("plain");
    register(identity);
    const a = connect(socket(), { identity });
    expect(a.result?.ok).toBe(true);
    expect(a.result?.identity).toBe(identity);
    expect(a.result?.capabilities?.audit).toEqual({
      ...AUDIT_LIMITS,
      schema_version_max: MAX_SCHEMA_VERSION,
    });
  });

  test("mesh.register answers the same shape as mesh.connect", () => {
    const a = nextId("via-connect");
    const b = nextId("via-register");
    register(a);
    register(b);
    const viaConnect = JSON.parse(handleConnect(socket(), { identity: a }, 1)) as Answer;
    const viaRegister = JSON.parse(handleRegister(socket(), { identity: b }, 1)) as Answer;
    expect(Object.keys(viaRegister.result ?? {}).sort()).toEqual(Object.keys(viaConnect.result ?? {}).sort());
    expect(viaRegister.result?.capabilities).toEqual(viaConnect.result?.capabilities);
  });

  test("mail queued while the identity was away is replayed on connect", () => {
    const identity = nextId("has-mail");
    register(identity);
    const message = nextId("msg");
    queue(identity, message);

    const ws = socket();
    expect(connect(ws, { identity }).result?.ok).toBe(true);
    expect(ws.sent.some((f) => f.includes(message))).toBe(true);
    expect(statusOf(message)).toBe("delivered");
  });
});

describe("proxy claims", () => {
  test("an entry the caller may not act for is dropped, and the connect stands", () => {
    const proxy = nextId("unentitled-proxy");
    const subject = nextId("subject");
    register(proxy);
    register(subject);

    const ws = socket();
    const a = connect(ws, { identity: proxy, proxy_for: [subject] });
    // Not a refusal: the http server declares every approved person at once,
    // and one bad entry may not take the whole web surface down.
    expect(a.result?.ok).toBe(true);
    expect(proxyMap.get(subject)).toBeUndefined();
  });

  /**
   * **The one that matters.** A refused claim must not be replayed to: doing so
   * hands this socket another identity's queued mail and marks it delivered, so
   * the rightful recipient never receives it. § 8.2 says a refused entry is not
   * wired into the socket's routing, and the replay is routing.
   */
  test("and its queued mail is neither sent to that socket nor marked delivered", () => {
    const proxy = nextId("unentitled-proxy");
    const subject = nextId("subject-with-mail");
    register(proxy);
    register(subject);
    const message = nextId("not-yours");
    queue(subject, message);

    const ws = socket();
    expect(connect(ws, { identity: proxy, proxy_for: [subject] }).result?.ok).toBe(true);

    expect(ws.sent.some((f) => f.includes(message))).toBe(false);
    expect(statusOf(message)).toBe("pending");
  });

  test("an entitled entry is wired, and its queued mail does arrive", () => {
    const type = selfSigningFreeType("in-process-proxyable");
    const proxy = nextId("entitled-proxy");
    const subject = nextId("proxied-subject");
    register(proxy);
    register(subject, type);
    allowProxy(proxy);
    const message = nextId("forwarded");
    queue(subject, message);

    const ws = socket();
    const a = connect(ws, { identity: proxy, proxy_for: [subject] });
    expect(a.result?.ok).toBe(true);
    expect(proxyMap.get(subject)).toBe(ws as any);
    expect(ws.sent.some((f) => f.includes(message))).toBe(true);
    expect(statusOf(message)).toBe("delivered");
  });

  test("entries that are not non-empty strings are skipped rather than fatal", () => {
    const proxy = nextId("odd-entries");
    register(proxy);
    const ws = socket();
    const a = connect(ws, { identity: proxy, proxy_for: ["", 5, null, {}] });
    expect(a.result?.ok).toBe(true);
  });

  test("a proxy_for that is not an array is ignored, not refused", () => {
    const proxy = nextId("not-an-array");
    register(proxy);
    expect(connect(socket(), { identity: proxy, proxy_for: "everyone" }).result?.ok).toBe(true);
  });
});

/**
 * The replay itself, driven directly.
 *
 * `ws.send` reports a dropped frame by returning 0 rather than by throwing, so
 * both endings have to be checked: a socket that quietly drops, and one that
 * fails outright. Either way the row stays `pending` — a row marked
 * `delivered` is not replayed again, so a wrong claim here is not recoverable
 * and § 8.9.4's delivery record would be a claim about a recipient that never
 * received anything.
 */
describe("replaying a queue to a socket that is going away", () => {
  test("a dropped frame stops the replay and leaves the rest queued", () => {
    const identity = nextId("dropping");
    register(identity);
    const first = nextId("first");
    const second = nextId("second");
    queue(identity, first);
    queue(identity, second);

    deliverPending(identity, { ...socket(), send: () => 0 });

    expect(statusOf(first)).toBe("pending");
    expect(statusOf(second)).toBe("pending");
  });

  test("a socket that throws stops it the same way", () => {
    const identity = nextId("throwing");
    register(identity);
    const first = nextId("first");
    const second = nextId("second");
    queue(identity, first);
    queue(identity, second);

    expect(() =>
      deliverPending(identity, {
        ...socket(),
        send: () => { throw new Error("socket write after close"); },
      }),
    ).not.toThrow();

    expect(statusOf(first)).toBe("pending");
    expect(statusOf(second)).toBe("pending");
  });

  /**
   * **A failure ends the replay, it does not skip a message.** The queue is one
   * conversation in order, so carrying on past a frame that failed hands the
   * recipient a later message while an earlier one is still waiting — and the
   * earlier one is the harder to notice missing.
   */
  test("a socket that fails once keeps what landed and stops there", () => {
    const identity = nextId("half-open");
    register(identity);
    const first = nextId("first");
    const second = nextId("second");
    const third = nextId("third");
    queue(identity, first);
    queue(identity, second);
    queue(identity, third);
    let frames = 0;

    deliverPending(identity, {
      ...socket(),
      send: (frame: string) => {
        if (++frames === 2) throw new Error("socket write after close");
        return frame.length;
      },
    });

    expect(statusOf(first)).toBe("delivered");
    expect(statusOf(second)).toBe("pending");
    expect(statusOf(third)).toBe("pending");
  });

  test("an identity with nothing queued asks the socket for nothing", () => {
    const identity = nextId("empty-queue");
    register(identity);
    const ws = socket();

    deliverPending(identity, ws);

    expect(ws.sent).toEqual([]);
  });
});

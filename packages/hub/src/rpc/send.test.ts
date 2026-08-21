/**
 * `mesh.send`'s refusals, called directly (SPEC § 8.2).
 *
 * The happy path is exercised from the mailbox surface next door; what is here
 * is every reason a send does not happen, and the **order** they happen in,
 * which is a property rather than an accident:
 *
 * - **Egress policy (§ 12) first**, before the dormancy clock is read and
 *   before anything is written: a send the policy forbids must not stamp the
 *   silence being measured, nor reach the queue.
 * - **Dormancy (§ 8.11.2) next**, and also before the entitlement check, for
 *   the same reason — a refused attempt must not reset the clock.
 * - **Entitlement last**, because a proxy claiming another identity is asking
 *   the most specific question and the cheapest checks should refuse first.
 *
 * Refused rather than accepted-and-dropped throughout. Telling an unauthorised
 * sender that the target exists is a real cost, and it is smaller than a mesh
 * where messages disappear with no error anywhere.
 *
 * This file owns the `hs-` prefix.
 */
import { describe, expect, test } from "bun:test";

import { MAILBOX_ERROR, MESH_ERROR } from "@agent-mesh/contracts";
import { groups } from "@agent-mesh/store";

import { agentsDb, db } from "../db";
import { onlineAgents, wsIdentities, wsProxies } from "../presence";
import { handleSend } from "./send";

let n = 0;
const uniq = (p: string) => `hs-${p}-${++n}-${process.pid}`;

type Answer = { result?: Record<string, any>; error?: { code: number; message: string; data?: any } };

const send = (ws: object, params: Record<string, unknown>): Answer =>
  JSON.parse(handleSend(ws, params, 1));

/** A socket the hub considers connected as `identity`. */
function connected(identity: string, proxyFor: string[] = []) {
  const ws = {};
  wsIdentities.set(ws, identity);
  if (proxyFor.length > 0) wsProxies.set(ws, new Set(proxyFor));
  return ws;
}

function agent(identity = uniq("agent"), type = "ai-claude") {
  agentsDb.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, ?)`).run(identity, type);
  return identity;
}

describe("before anything is written", () => {
  test("refuses a socket that never connected", () => {
    const answered = send({}, { to: agent(), content: "hello" });
    expect(answered.error!.message).toContain("mesh.connect");
  });

  test("refuses a send that names no recipient, and one with no content", () => {
    const ws = connected(agent());
    expect(send(ws, { content: "hello" }).error!.message).toContain("params.to");
    expect(send(ws, { to: agent() }).error!.message).toContain("params.content");
  });

  /** Empty content is content: a caller may legitimately send an empty string. */
  test("takes an empty string as content", () => {
    const ws = connected(agent());
    expect(send(ws, { to: agent(), content: "" }).error).toBeUndefined();
  });

  /**
   * The key is how a retry is told from a new send. One that is not a string,
   * is empty, or is longer than the column holds cannot do that job, and the
   * refusal is what stops it being stored as if it could.
   */
  test("refuses an idempotency key it cannot use", () => {
    const ws = connected(agent());
    const to = agent();
    for (const client_message_id of [7, "", "x".repeat(129), null]) {
      const answered = send(ws, { to, content: "hello", client_message_id });
      expect({ key: String(client_message_id).slice(0, 12), refused: !!answered.error })
        .toEqual({ key: String(client_message_id).slice(0, 12), refused: true });
    }
  });

  test("takes one at the limit", () => {
    const ws = connected(agent());
    expect(send(ws, { to: agent(), content: "hello", client_message_id: "x".repeat(128) }).error)
      .toBeUndefined();
  });
});

describe("the egress policy", () => {
  /** Two groups with no rule between them. */
  function walledOff() {
    const from = uniq("group-from");
    const to = uniq("group-to");
    for (const groupId of [from, to]) {
      groups.createGroup(agentsDb, { groupId, createdBy: "send-test" });
    }
    const sender = agent();
    const recipient = agent();
    groups.moveTo(agentsDb, { identity: sender, groupId: from, movedBy: "send-test" });
    groups.moveTo(agentsDb, { identity: recipient, groupId: to, movedBy: "send-test" });
    return { sender, recipient, from, to };
  }

  test("refuses a send across groups with no rule, naming the pair", () => {
    const w = walledOff();
    const answered = send(connected(w.sender), { to: w.recipient, content: "over the wall" });

    expect(answered.error!.code).toBe(MAILBOX_ERROR.EGRESS_DENIED);
    expect(answered.error!.data).toMatchObject({
      code: "EGRESS_DENIED", from_group: w.from, to_group: w.to,
    });
    // The pair, not the identities: an operator acts on a rule to widen, not a
    // sender to chase.
    expect(answered.error!.message).toContain(w.from);
    expect(answered.error!.message).toContain(w.to);
  });

  test("allows it once a rule exists", () => {
    const w = walledOff();
    groups.allowEgress(agentsDb, { fromGroup: w.from, toGroup: w.to, grantedBy: "send-test" });
    expect(send(connected(w.sender), { to: w.recipient, content: "through the gate" }).error)
      .toBeUndefined();
  });

  /**
   * **A rule is one-way.** Allowing `a → b` says nothing about `b → a`, and
   * reading it both ways would quietly widen every rule an operator wrote.
   */
  test("does not open the other direction", () => {
    const w = walledOff();
    groups.allowEgress(agentsDb, { fromGroup: w.from, toGroup: w.to, grantedBy: "send-test" });
    const back = send(connected(w.recipient), { to: w.sender, content: "back over" });
    expect(back.error!.code).toBe(MAILBOX_ERROR.EGRESS_DENIED);
  });

  /**
   * **Nothing is written when the policy refuses.** § 12 puts this check before
   * the queue precisely so a forbidden send leaves no row — accepted-and-dropped
   * is the failure mode the refusal exists to replace.
   */
  test("writes no message when it refuses", async () => {
    const { db } = await import("../db");
    const w = walledOff();
    const before = (db.prepare(`SELECT count(*) AS n FROM messages WHERE to_agent = ?`)
      .get(w.recipient) as { n: number }).n;

    send(connected(w.sender), { to: w.recipient, content: "over the wall" });

    const after = (db.prepare(`SELECT count(*) AS n FROM messages WHERE to_agent = ?`)
      .get(w.recipient) as { n: number }).n;
    expect({ before, after }).toEqual({ before, after: before });
  });
});

describe("claiming another identity", () => {
  /** A proxy the store allows, and a subject that signs for nothing itself. */
  function proxyAndSubject() {
    const proxy = agent();
    agentsDb.prepare(`UPDATE agents SET can_proxy = 1 WHERE identity = ?`).run(proxy);
    agentsDb
      .prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES ('hs-proxied', 0)`)
      .run();
    const subject = agent(uniq("subject"), "hs-proxied");
    return { proxy, subject };
  }

  test("sends as an identity it is entitled to and declared", () => {
    const { proxy, subject } = proxyAndSubject();
    const answered = send(connected(proxy, [subject]), {
      to: agent(), content: "on their behalf", from: subject,
    });
    expect(answered.error).toBeUndefined();
  });

  /**
   * **Entitlement and declaration are two questions.** The store says which
   * identities this caller *may* act for; `proxy_for` says which it *claimed*
   * on connect. A socket entitled to ten has not thereby claimed all ten, and
   * a send as an undeclared one is a socket acting outside what it announced.
   */
  test("refuses an identity it is entitled to but did not declare", () => {
    const { proxy, subject } = proxyAndSubject();
    const answered = send(connected(proxy), {
      to: agent(), content: "undeclared", from: subject,
    });
    expect(answered.error!.code).toBe(MESH_ERROR.NOT_ENTITLED);
    expect(answered.error!.message).toContain("proxy_for");
  });

  /** A subject torn down since the socket connected is refused from that moment. */
  test("refuses an identity that has been torn down", () => {
    const { proxy, subject } = proxyAndSubject();
    agentsDb.prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ?`).run(subject);
    const answered = send(connected(proxy, [subject]), {
      to: agent(), content: "too late", from: subject,
    });
    expect(answered.error!.message).toContain("deleted");
  });

  /** And one that holds its own key signs for itself; nobody speaks for it. */
  test("refuses an identity that signs for itself", () => {
    const { proxy } = proxyAndSubject();
    const selfSigning = agent(uniq("self-signing"), "ai-claude");
    agentsDb
      .prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES ('ai-claude', 1)`)
      .run();
    const answered = send(connected(proxy, [selfSigning]), {
      to: agent(), content: "not yours to send", from: selfSigning,
    });
    expect(answered.error!.message).toContain("signs for itself");
  });

  /**
   * § 8.10a. A socket may send *as* somebody else only if that identity is one
   * it is entitled to act for — and only if it said so on connect. The second
   * check is not redundant: entitlement is what the store allows, `proxy_for`
   * is what this connection declared, and a socket that can act for ten
   * identities has not thereby claimed all ten.
   */
  test("refuses a sender it is not entitled to act for", () => {
    const proxy = agent();
    const claimed = agent();
    const answered = send(connected(proxy, [claimed]), {
      to: agent(), content: "on their behalf", from: claimed,
    });
    expect(answered.error!.code).toBe(MESH_ERROR.NOT_ENTITLED);
    expect(answered.error!.message).toContain(claimed);
  });

  /**
   * **Whether the identity exists is asked after whether this caller may act
   * for it.** A socket with no proxy grant is told it is not entitled, not
   * whether the name it guessed is real — otherwise this refusal would answer
   * *does this identity exist* to anyone who asks.
   */
  test("does not say whether an identity it may not act for exists", () => {
    const proxy = agent();
    const real = agent();
    const ghost = uniq("never-provisioned");

    const said = [real, ghost].map((claimed) =>
      send(connected(proxy, [claimed]), { to: agent(), content: "on their behalf", from: claimed })
        .error!.message.replace(claimed, "<name>"),
    );
    expect(said[0]).toBe(said[1]);
    expect(said[0]).toContain("not entitled");
  });
});

/**
 * § 8.11.2. A key that has been silent for the dormancy window and then sends
 * from a network it has never been seen on is refused until an operator has
 * looked — the shape a stolen credential has, and the one thing the mesh can
 * notice about it without asking anybody.
 */
describe("a dormant identity arriving from somewhere new", () => {
  /** Silent since long before the window, with one network on record. */
  function dormant(seenOn: string): string {
    const identity = agent();
    agentsDb.prepare("UPDATE agents SET last_send_at = '2020-01-01 00:00:00' WHERE identity = ?").run(identity);
    agentsDb.prepare("INSERT INTO agent_sources (identity, observed) VALUES (?, ?)").run(identity, seenOn);
    return identity;
  }

  /** A socket carrying the address the upgrade saw. */
  const from = (identity: string, observed: string) => {
    const ws = { observed };
    wsIdentities.set(ws, identity);
    return ws;
  };

  test("is refused, and told what an operator has to review", () => {
    const identity = dormant("198.51.100.4");

    const answered = send(from(identity, "203.0.113.7"), { to: agent(), content: "hello" });

    expect(answered.error!.data.code).toBe("SOURCE_CHANGED");
    expect(answered.error!.message).toContain("has not been seen on");
  });

  test("the same network it has always used is not new", () => {
    const identity = dormant("198.51.100.4");

    const answered = send(from(identity, "198.51.100.9"), { to: agent(), content: "hello" });

    expect(answered.error).toBeUndefined();
  });

  test("a refused send does not stamp the clock it is measured against", () => {
    const identity = dormant("198.51.100.4");

    send(from(identity, "203.0.113.7"), { to: agent(), content: "hello" });

    const row = agentsDb.prepare("SELECT last_send_at FROM agents WHERE identity = ?").get(identity) as
      { last_send_at: string };
    expect(row.last_send_at).toBe("2020-01-01 00:00:00");
  });
});

/**
 * What happens after the refusals: the write, and the frame.
 *
 * Both failure paths here were added for defects that took the hub down or
 * lied about where a message went, and neither had ever run in a process a
 * coverage report can see — one needs storage to refuse a write, the other a
 * socket that fails on the way out.
 */
describe("when the write or the delivery fails", () => {
  /** Storage that refuses, which is what a full volume looks like from here. */
  function withUnwritableMessages<T>(body: () => T): T {
    db.exec("ALTER TABLE messages RENAME TO messages_unavailable");
    try {
      return body();
    } finally {
      db.exec("ALTER TABLE messages_unavailable RENAME TO messages");
    }
  }

  /**
   * Unguarded this threw out of the WebSocket message handler and the send
   * simply never answered — routing stopping because storage filled, which is
   * the inversion § 15.6 exists to forbid.
   */
  test("a write that fails is answered, as a transient the caller can retry", () => {
    const ws = connected(agent());
    const to = agent();

    const answered = withUnwritableMessages(() => send(ws, { to, content: "hello" }));

    expect(answered.error!.message).toContain("could not persist message");
    expect(answered.error!.data.retryable).toBe(true);
  });

  test("the hub keeps taking sends afterwards", () => {
    const ws = connected(agent());
    const to = agent();
    withUnwritableMessages(() => send(ws, { to, content: "hello" }));

    expect(send(ws, { to, content: "and again" }).error).toBeUndefined();
  });

  /** A socket in the map is somebody who connected, not somebody who received. */
  function online(identity: string, socket: { send(data: string): number }) {
    onlineAgents.set(identity, socket);
    return () => onlineAgents.delete(identity);
  }

  test("a frame the socket drops is queued, not recorded as delivered", () => {
    const to = agent();
    const offline = online(to, { send: () => 0 });
    try {
      const answered = send(connected(agent()), { to, content: "hello" });

      expect(answered.error).toBeUndefined();
      expect(answered.result!.status).toBe("pending");
    } finally {
      offline();
    }
  });

  test("a socket that throws on the way out is queued the same way", () => {
    const to = agent();
    const broken = online(to, { send: () => { throw new Error("socket write after close"); } });
    try {
      const answered = send(connected(agent()), { to, content: "hello" });

      expect(answered.error).toBeUndefined();
      expect(answered.result!.status).toBe("pending");
    } finally {
      broken();
    }
  });

  test("a frame that lands is delivered", () => {
    const to = agent();
    const sent: string[] = [];
    const offline = online(to, { send: (data: string) => sent.push(data) });
    try {
      const answered = send(connected(agent()), { to, content: "hello" });

      expect(answered.result!.status).toBe("delivered");
      expect(JSON.parse(sent[0]!).method).toBe("mesh.message");
    } finally {
      offline();
    }
  });
});

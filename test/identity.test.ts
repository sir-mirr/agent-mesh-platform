/**
 * Increment 1 — the storage split, the type registry and soft delete.
 *
 * The assertions are the "done when" conditions from
 * docs/implementation-plan-0.2.md steps 1 and 5, which is why several of them
 * check that something is refused rather than that it works.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { connectRpc, loginAsAdmin, newPublicKey, openTestDb, provision, provisionProxy, startMesh, teardown, type Mesh } from "./harness";

let mesh: Mesh;

const del = (identity: string) =>
  teardown(mesh.http, identity);

/** Read `agents.db` directly to assert on what was actually stored. */
function agentsDb(): Database {
  return openTestDb(join(mesh.stateDir, "agents.db"), { readonly: true });
}

beforeAll(async () => {
  // Teardown (§ 9.3) is served by the http server behind the admin JWT, so
  // these need it up even though everything else here is hub-only.
  mesh = await startMesh();
});

afterAll(() => mesh?.stop());

describe("storage split", () => {
  test("identity lives in agents.db, messages in hub.db", () => {
    expect(existsSync(join(mesh.stateDir, "agents.db"))).toBe(true);
    expect(existsSync(join(mesh.stateDir, "hub.db"))).toBe(true);

    const db = agentsDb();
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain("agents");
    expect(tables).toContain("agent_types");
    expect(tables).toContain("agent_keys");
    expect(tables).toContain("agent_key_events");
    expect(tables).not.toContain("messages");

    const hub = openTestDb(join(mesh.stateDir, "hub.db"), { readonly: true });
    const hubTables = (hub.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as Array<{ name: string }>).map((t) => t.name);
    expect(hubTables).toContain("messages");
    expect(hubTables).not.toContain("agents");
  });
});

/**
 * § 3.1 — the hub's baseline invariants.
 *
 * These are the properties everything else assumes and nothing else asserts:
 * which file holds which table, who may create a schema, and that the
 * deprecated alias is an alias rather than a second way to register.
 */
describe("hub baseline invariants", () => {
  test("audit never shares a file with messages", () => {
    // § 3.1 states the reason: one file means audit growth exhausting the disk
    // also stops message routing — a recording feature taking down the
    // communication feature.
    const audit = openTestDb(join(mesh.stateDir, "audit.db"), { readonly: true });
    const auditTables = (audit.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as Array<{ name: string }>).map((t) => t.name);
    audit.close();

    expect(auditTables).toContain("audit_events");
    expect(auditTables).toContain("audit_event_blobs");
    expect(auditTables).not.toContain("messages");
    expect(auditTables).not.toContain("agents");
  });

  test("an event and its blob references share one file, because they commit together", () => {
    // § 8.9.3 requires one transaction, and SQLite gives no atomic commit
    // across attached databases in WAL mode.
    const audit = openTestDb(join(mesh.stateDir, "audit.db"), { readonly: true });
    const tables = (audit.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'audit_%'`,
    ).all() as Array<{ name: string }>).map((t) => t.name);
    audit.close();
    expect(tables.sort()).toEqual(["audit_event_blobs", "audit_events"]);
  });

  test("the agents table carries every column § 3.1 names", () => {
    const cols = (agentsDb().prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const required of ["identity", "type", "description", "created_at", "last_seen"]) {
      expect(cols, `missing ${required}`).toContain(required);
    }
  });

  test("mesh.register is an alias, not a second way to register", () => {
    // § 3.1: the hub MUST NOT register identities outside POST /api/v1/agents,
    // and the deprecated alias explicitly does not insert rows. If it did, a
    // caller could mint an identity by connecting as one.
    return (async () => {
      const rpc = await connectRpc(mesh.hub);
      const res = await rpc.call("mesh.register", { identity: "never-provisioned", type: "service" });
      rpc.close();

      expect(res.error).toMatchObject({ code: -32011 });
      // bun:sqlite returns null for no row, not undefined. The point is that
      // there is no row: connecting must not be a way to mint an identity.
      expect(agentsDb().prepare(`SELECT identity FROM agents WHERE identity = ?`)
        .get("never-provisioned")).toBeNull();
    })();
  });

  test("mesh.register does not overwrite type or description either", async () => {
    // § 8.1a: type and description on a register call MUST be ignored rather
    // than persisted — an older client that still sends them must not be able
    // to relabel an identity by reconnecting.
    await provision(mesh.hub, "alias-agent", "service", "original description");
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.register", {
      identity: "alias-agent", type: "ai-claude", description: "rewritten",
    });
    rpc.close();

    expect(agentsDb().prepare(`SELECT type, description FROM agents WHERE identity = ?`)
      .get("alias-agent")).toEqual({ type: "service", description: "original description" });
  });
});

describe("agent type registry", () => {
  test("accepts every seeded type", async () => {
    for (const type of ["ai-claude", "ai-codex", "ai-antigravity", "service", "human"]) {
      expect((await provision(mesh.hub, `seed-${type}`, type)).status).toBe(201);
    }
  });

  test("rejects an unregistered type and names the ones it knows", async () => {
    const res = await provision(mesh.hub, "type-reject", "ai-nonesuch");
    expect(res.status).toBe(400);
    // The error lists the registry rather than a constant, so it stays true
    // as the table grows.
    expect((await res.json()).error).toContain("ai-antigravity");
  });

  test("a type added to the table is accepted with no code change", async () => {
    // This is the whole point of § 10.3: a new runtime is a row, not a release.
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    db.prepare(
      `INSERT INTO agent_types (type, description, requires_key) VALUES (?, ?, 1)`,
    ).run("ai-invented", "added at runtime");
    db.close();

    expect((await provision(mesh.hub, "invented-agent", "ai-invented")).status).toBe(201);
  });

  test("seeds mark AI runtimes as requiring a key and services as not", () => {
    const rows = agentsDb()
      .prepare(`SELECT type, requires_key FROM agent_types ORDER BY type`)
      .all() as Array<{ type: string; requires_key: number }>;
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.requires_key]));
    expect(byType["ai-claude"]).toBe(1);
    expect(byType["ai-codex"]).toBe(1);
    expect(byType["ai-antigravity"]).toBe(1);
    expect(byType["service"]).toBe(0);
    expect(byType["human"]).toBe(0);
  });
});

describe("agent_keys constraints", () => {
  test("the database refuses two approved keys for one identity", () => {
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    const insert = db.prepare(
      `INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, ?)`,
    );
    insert.run("fp-approved-1", "constraint-agent", "k1", "approved");

    // The partial unique index is the enforcement — not a check in application
    // code, which would be a second chance to get it wrong.
    expect(() => insert.run("fp-approved-2", "constraint-agent", "k2", "approved")).toThrow();
    // A pending one alongside is fine: that is how rotation is proposed.
    expect(() => insert.run("fp-pending-1", "constraint-agent", "k3", "pending")).not.toThrow();
    expect(() => insert.run("fp-pending-2", "constraint-agent", "k4", "pending")).toThrow();
    db.close();
  });

  test("rejects a status outside the four the contract defines", () => {
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    expect(() =>
      db.prepare(
        `INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, ?)`,
      ).run("fp-bad", "status-agent", "k", "maybe"),
    ).toThrow();
    db.close();
  });
});

describe("soft delete", () => {
  test("marks the identity deleted and leaves its messages alone", async () => {
    await provision(mesh.hub, "doomed", "service");
    await provision(mesh.hub, "survivor", "service");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "survivor" });
    await rpc.call("mesh.send", { to: "doomed", content: "sent before teardown" });
    rpc.close();

    const res = await del("doomed");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: "soft-deleted" });

    // The row survives — a key that is gone cannot verify a past signature.
    const row = agentsDb()
      .prepare(`SELECT identity, deleted_at FROM agents WHERE identity = 'doomed'`)
      .get() as { identity: string; deleted_at: string | null };
    expect(row.identity).toBe("doomed");
    expect(row.deleted_at).not.toBeNull();

    // And the message it received is still there.
    const messages = openTestDb(join(mesh.stateDir, "hub.db"), { readonly: true })
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE to_agent = 'doomed'`)
      .get() as { n: number };
    expect(messages.n).toBeGreaterThan(0);
  });

  test("a deleted identity cannot connect", async () => {
    await provision(mesh.hub, "gone-connect", "service");
    await del("gone-connect");

    const rpc = await connectRpc(mesh.hub);
    expect((await rpc.call("mesh.connect", { identity: "gone-connect" })).error)
      .toMatchObject({ code: -32011 });
    rpc.close();
  });

  test("a deleted identity disappears from list_agents", async () => {
    await provision(mesh.hub, "gone-listed", "service");
    await provision(mesh.hub, "still-listed", "service");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "still-listed" });
    expect((await rpc.call("mesh.list_agents", {})).result.agents.map((a: any) => a.id))
      .toContain("gone-listed");

    await del("gone-listed");

    const after = (await rpc.call("mesh.list_agents", {})).result.agents.map((a: any) => a.id);
    expect(after).not.toContain("gone-listed");
    expect(after).toContain("still-listed");
    rpc.close();
  });

  test("sending to a deleted identity is refused rather than queued forever", async () => {
    await provision(mesh.hub, "gone-recipient", "service");
    await provision(mesh.hub, "sender-agent", "service");
    await del("gone-recipient");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "sender-agent" });

    const res = await rpc.call("mesh.send", { to: "gone-recipient", content: "hello?" });
    expect(res.error).toMatchObject({ code: -32602 });

    // An identity that merely does not exist is still queued (SPEC § 3.1) —
    // it may be provisioned later.
    expect((await rpc.call("mesh.send", { to: "not-yet-created", content: "later" })).result)
      .toMatchObject({ status: "pending" });
    rpc.close();
  });

  test("re-registering a deleted identity is refused", async () => {
    await provision(mesh.hub, "no-reuse", "service");
    await del("no-reuse");

    const res = await provision(mesh.hub, "no-reuse", "service", "back again");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("cannot be re-registered");
  });

  test("revokes the identity's keys and records why", async () => {
    await provision(mesh.hub, "keyed-agent", "service");
    const db = openTestDb(join(mesh.stateDir, "agents.db"));
    db.prepare(
      `INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, ?)`,
    ).run("fp-teardown", "keyed-agent", "pk", "approved");
    db.close();

    await del("keyed-agent");

    const read = agentsDb();
    expect(read.prepare(`SELECT status FROM agent_keys WHERE fingerprint = 'fp-teardown'`).get())
      .toEqual({ status: "revoked" });
    // The history is what lets a verifier judge past signatures by date.
    expect(read.prepare(
      `SELECT action, reason FROM agent_key_events WHERE identity = 'keyed-agent'`,
    ).get()).toMatchObject({ action: "revoked", reason: "teardown" });
  });

  test("teardown is idempotent and distinguishes never-existed from already-gone", async () => {
    await provision(mesh.hub, "twice-deleted", "service");

    expect((await del("twice-deleted")).body).toMatchObject({ action: "soft-deleted" });
    expect((await del("twice-deleted")).body).toMatchObject({ action: "already-deleted" });
    expect((await del("never-existed")).body).toMatchObject({ action: "not-found" });
  });

  test("no longer reports messages_removed, because it removes none", async () => {
    await provision(mesh.hub, "no-counts", "service");
    const body = (await del("no-counts")).body;
    expect(body).not.toHaveProperty("messages_removed");
    expect(body).not.toHaveProperty("agents_removed");
  });
});

/**
 * SPEC § 8.2 — the hub records the socket that transmitted an envelope
 * alongside the identity it claims to be from.
 *
 * The override itself is not new: it is how the http server forwards for a
 * logged-in web user. What was missing is that it erased the transmitter, so a
 * proxied message was stored as though the claimed sender wrote it. Entitlement
 * (step 6) decides whether an override is permitted; these assert that the
 * answer is recorded either way, which does not depend on entitlement existing.
 */
describe("transmitter recording", () => {
  const messageRow = (id: string) =>
    openTestDb(join(mesh.stateDir, "hub.db"), { readonly: true })
      .prepare(`SELECT from_agent, to_agent, sent_by FROM messages WHERE id = ?`)
      .get(id) as { from_agent: string; to_agent: string; sent_by: string | null };

  test("an ordinary send records the sender as both", async () => {
    await provision(mesh.hub, "plain-sender", "service");
    await provision(mesh.hub, "plain-recipient", "service");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "plain-sender" });
    const sent = await rpc.call("mesh.send", { to: "plain-recipient", content: "no proxy here" });
    rpc.close();

    expect(messageRow(sent.result.id)).toEqual({
      from_agent: "plain-sender", to_agent: "plain-recipient", sent_by: "plain-sender",
    });
  });

  test("a proxied send keeps both identities apart", async () => {
    await provisionProxy(mesh.hub, "proxy-socket", "service", mesh.http);
    // A person: type `human`, so no key of their own and nobody to sign for
    // them. That is the only case the override exists for (SPEC § 8.2).
    await provision(mesh.hub, "web-user", "human");
    await provision(mesh.hub, "proxy-recipient", "service");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "proxy-socket", proxy_for: ["web-user"] });
    const sent = await rpc.call("mesh.send", {
      to: "proxy-recipient", from: "web-user", content: "forwarded on their behalf",
    });
    rpc.close();

    // Before this was recorded the row read `from_agent = web-user` with nothing
    // to say a different socket produced it.
    expect(messageRow(sent.result.id)).toEqual({
      from_agent: "web-user", to_agent: "proxy-recipient", sent_by: "proxy-socket",
    });
  });

  test("params cannot set the transmitter", async () => {
    await provision(mesh.hub, "honest-socket", "service");
    await provision(mesh.hub, "liar-recipient", "service");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "honest-socket" });
    const sent = await rpc.call("mesh.send", {
      to: "liar-recipient", sent_by: "someone-else", content: "claiming to be another socket",
    });
    rpc.close();

    // The whole point: it comes from the connection, not the request body.
    expect(messageRow(sent.result.id).sent_by).toBe("honest-socket");
  });

  test("the recipient is told, live and on replay", async () => {
    await provisionProxy(mesh.hub, "live-proxy", "service", mesh.http);
    await provision(mesh.hub, "live-user", "human");
    await provision(mesh.hub, "live-recipient", "service");
    await provision(mesh.hub, "queued-recipient", "service");

    const recipient = await connectRpc(mesh.hub);
    await recipient.call("mesh.connect", { identity: "live-recipient" });

    const proxy = await connectRpc(mesh.hub);
    await proxy.call("mesh.connect", { identity: "live-proxy", proxy_for: ["live-user"] });
    await proxy.call("mesh.send", { to: "live-recipient", from: "live-user", content: "live" });
    // ...and one to a recipient that is offline, so it is replayed rather than pushed.
    await proxy.call("mesh.send", { to: "queued-recipient", from: "live-user", content: "queued" });
    proxy.close();

    await Bun.sleep(100);
    const pushed = recipient.notifications().find((n) => n.method === "mesh.message");
    expect(pushed.params).toMatchObject({ from: "live-user", sent_by: "live-proxy" });
    recipient.close();

    // A replay must carry it too, or reconnecting launders the attribution away.
    const late = await connectRpc(mesh.hub);
    await late.call("mesh.connect", { identity: "queued-recipient" });
    await Bun.sleep(100);
    const replayed = late.notifications().find((n) => n.method === "mesh.message");
    expect(replayed.params).toMatchObject({ from: "live-user", sent_by: "live-proxy" });
    late.close();
  });

  test("fetch_messages carries it", async () => {
    await provisionProxy(mesh.hub, "hist-proxy", "service", mesh.http);
    await provision(mesh.hub, "hist-user", "human");
    await provision(mesh.hub, "hist-peer", "service");

    const proxy = await connectRpc(mesh.hub);
    await proxy.call("mesh.connect", { identity: "hist-proxy", proxy_for: ["hist-user"] });
    await proxy.call("mesh.send", { to: "hist-peer", from: "hist-user", content: "for history" });
    proxy.close();

    const peer = await connectRpc(mesh.hub);
    await peer.call("mesh.connect", { identity: "hist-peer" });
    const res = await peer.call("mesh.fetch_messages", { agent_id: "hist-user" });
    peer.close();

    expect(res.result.messages[0]).toMatchObject({ from: "hist-user", sent_by: "hist-proxy" });
  });
});

describe("teardown requires an admin (§ 9.3)", () => {
  /**
   * The route moved because the hub cannot authenticate anyone. These assert
   * the move actually bought something: before it, the whole attack was one
   * unauthenticated `curl -X DELETE`, and the names to aim at were listable
   * from `mesh.list_agents`.
   */
  const target = (id: string) => `${mesh.http.url}/api/v1/admin/agents/${id}`;

  test("the hub refuses, and says where the operation went", async () => {
    await provision(mesh.hub, "hub-refuses", "service");
    const res = await fetch(`${mesh.hub.url}/api/agents/hub-refuses`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("TEARDOWN_REQUIRES_ADMIN");
    // A 404 would read as a typo and invite a retry against a path that will
    // never exist.
    expect(body.error).toContain("/api/v1/admin/agents/");

    // And it did nothing.
    const still = await fetch(`${mesh.hub.url}/api/v1/agents/hub-refuses/keys`);
    expect(still.status).toBe(200);
  });

  test("no session is 401", async () => {
    await provision(mesh.hub, "unauth-safe", "service");
    expect((await fetch(target("unauth-safe"), { method: "DELETE" })).status).toBe(401);
    expect((await fetch(`${mesh.hub.url}/api/v1/agents/unauth-safe/keys`)).status).toBe(200);
  });

  test("a valid non-admin session is 403", async () => {
    await provision(mesh.hub, "viewer-safe", "service");
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const payload = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
      github_id: 7, github_login: "viewer", role: "user", iat: now, exp: now + 3600,
    })}`;
    const token = `${payload}.${createHmac("sha256", "integration-test-secret").update(payload).digest("base64url")}`;

    const res = await fetch(target("viewer-safe"), {
      method: "DELETE",
      headers: { cookie: `mesh_token=${token}` },
    });
    expect(res.status).toBe(403);
    expect((await fetch(`${mesh.hub.url}/api/v1/agents/viewer-safe/keys`)).status).toBe(200);
  });

  test("a forged admin claim is refused, not decoded", async () => {
    // `role` is a claim inside the token. A server reading it without verifying
    // the signature would hand teardown to anyone who can base64.
    await provision(mesh.hub, "forged-safe", "service");
    const forged = Buffer.from(
      JSON.stringify({ github_id: 1, github_login: "x", role: "admin" }),
    ).toString("base64url");
    const res = await fetch(target("forged-safe"), {
      method: "DELETE",
      headers: { cookie: `mesh_token=eyJhbGciOiJIUzI1NiJ9.${forged}.not-a-signature` },
    });
    expect(res.status).toBe(401);
    expect((await fetch(`${mesh.hub.url}/api/v1/agents/forged-safe/keys`)).status).toBe(200);
  });

  test("an admin session tears it down, and the key event names them", async () => {
    // § 10.2 requires every key transition to say who caused it. The
    // unauthenticated route could only ever write the service's own name.
    const key = newPublicKey();
    await provision(mesh.hub, "admin-torn", "ai-claude", null, key);
    const res = await teardown(mesh.http, "admin-torn");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "soft-deleted" });

    const db = agentsDb();
    expect(db.prepare(`SELECT status FROM agent_keys WHERE identity = 'admin-torn'`).get())
      .toMatchObject({ status: "revoked" });
    expect(
      // Scoped to the revocation: the first row for this identity is the key
      // proposal, which is written by the unauthenticated provisioning route
      // and correctly carries no operator.
      db.prepare(
        `SELECT actor, reason FROM agent_key_events
          WHERE identity = 'admin-torn' AND action = 'revoked'`,
      ).get(),
    ).toMatchObject({ actor: "admin", reason: "teardown" });
    db.close();
  });
});

describe("the agent type registry is writable through the admin surface (§ 10.3)", () => {
  /**
   * § 10.3 said types are added "through the http admin surface" and no such
   * route existed, so the only way to add one was SQL against `agents.db`. The
   * registry was dynamic on the read side and manual on the write side, which
   * is how the client came to be blocked on a type nobody could provision.
   */
  const url = (p = "") => `${mesh.http.url}/api/v1/admin/agent-types${p}`;
  const admin = () => loginAsAdmin(mesh.http);

  test("a new type is accepted for provisioning as soon as it is added", async () => {
    // The whole point: the 400 from `POST /api/v1/agents` lists the registry,
    // so adding a row has to change what registration accepts with no restart
    // and no code change.
    const before = await provision(mesh.hub, "typed-early", "ai-testruntime", null, newPublicKey());
    expect(before.status).toBe(400);
    // The refusal lists the registry, not the rejected value — which is the
    // check that it is reading the table rather than a constant.
    const listed = (await before.json()).error as string;
    expect(listed).toContain("type must be one of");
    expect(listed).not.toContain("ai-testruntime");

    const add = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await admin() },
      body: JSON.stringify({ type: "ai-testruntime", description: "fixture runtime" }),
    });
    expect(add.status).toBe(201);
    // Defaults to requiring a key: the exception is a type that needs none.
    expect((await add.json()).type).toMatchObject({ type: "ai-testruntime", requires_key: 1 });

    const after = await provision(mesh.hub, "typed-early", "ai-testruntime", null, newPublicKey());
    expect(after.status).toBe(201);
  });

  test("adding is create-only", async () => {
    // `requires_key` is the field worth updating, and lowering it retroactively
    // lets every identity of that type connect unsigned.
    const cookie = await admin();
    const body = JSON.stringify({ type: "ai-onceonly", requires_key: 1 });
    const first = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", cookie }, body });
    expect(first.status).toBe(201);

    const second = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "ai-onceonly", requires_key: 0 }),
    });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("TYPE_EXISTS");

    const listed = await (await fetch(url(), { headers: { cookie } })).json();
    expect(listed.types.find((t: any) => t.type === "ai-onceonly")).toMatchObject({ requires_key: 1 });
  });

  test("removal is refused while an identity carries the type", async () => {
    const cookie = await admin();
    await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "ai-inuse" }),
    });
    await provision(mesh.hub, "holds-the-type", "ai-inuse", null, newPublicKey());

    const res = await fetch(url("/ai-inuse"), { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("TYPE_IN_USE");
    expect(body.identities).toContain("holds-the-type");
  });

  test("a soft-deleted identity still blocks removal", async () => {
    // § 9.3 keeps the row so past signatures stay interpretable, and the row
    // names a type. Dropping it would dangle the classification on a record the
    // audit trail still points at.
    const cookie = await admin();
    await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "ai-tombstoned" }),
    });
    await provision(mesh.hub, "torn-but-typed", "ai-tombstoned", null, newPublicKey());
    expect((await teardown(mesh.http, "torn-but-typed", cookie)).body.action).toBe("soft-deleted");

    const res = await fetch(url("/ai-tombstoned"), { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(409);
    expect((await res.json()).identities).toContain("torn-but-typed");
  });

  test("an unused type can be removed", async () => {
    const cookie = await admin();
    await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "ai-unused" }),
    });
    const res = await fetch(url("/ai-unused"), { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    // `deleted`, one word across all four delete routes (SPEC § 9.2a).
    expect((await res.json()).action).toBe("deleted");

    const listed = await (await fetch(url(), { headers: { cookie } })).json();
    expect(listed.types.some((t: any) => t.type === "ai-unused")).toBe(false);
  });

  test("every route needs an admin, and none of them acts without one", async () => {
    const before = await (await fetch(url(), { headers: { cookie: await admin() } })).json();

    expect((await fetch(url())).status).toBe(401);
    expect((await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ai-sneaked" }),
    })).status).toBe(401);
    expect((await fetch(url("/service"), { method: "DELETE" })).status).toBe(401);

    const after = await (await fetch(url(), { headers: { cookie: await admin() } })).json();
    expect(after.types.map((t: any) => t.type).sort()).toEqual(before.types.map((t: any) => t.type).sort());
  });
});

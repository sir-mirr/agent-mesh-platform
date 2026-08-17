/**
 * Replay of the shared cross-repository scenarios (SPEC § 17).
 *
 * The scenarios themselves live in `@agent-mesh/contracts`, not here. That is
 * the whole point: the client repository runs the same list against its own
 * transport, and "both sides pass" is only a claim worth making when the list is
 * one artefact rather than two that resemble each other.
 *
 * ## What this file is
 *
 * An interpreter for the verb set, and nothing else. It holds no assertions of
 * its own — every expectation comes out of the scenario data — because a runner
 * that adds its own checks is a runner whose green does not mean what the other
 * side's green means.
 *
 * The one thing it does add is `expectStored`, which reads SQLite directly.
 * Those are the scenarios about traces rather than responses: a source recorded,
 * an audit read logged, a type change kept. The client cannot run them (no
 * database), so it skips them by verb — which is why the verb is named for the
 * kind of check rather than for a particular table.
 *
 * ## Scenarios are ordered and share a mesh
 *
 * One mesh for the file, run in declaration order. Scenarios name each other's
 * identities on purpose — `E2E-RECEIVE-001` sends from `e2e-a`, provisioned by
 * `E2E-SEND-001` — because a mesh that only ever sees one conversation is not
 * the thing being tested. The cost is that a failure early can cascade, which is
 * why the report prints the first failing step and stops that scenario rather
 * than every consequence of it.
 *
 * The exception is a scenario carrying `mesh` (§ 17.4): it gets one of its own,
 * shaped as it asked, and provisions everything it names.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { E2E_SCENARIOS, type Scenario, type Step } from "@agent-mesh/contracts";
import {
  callHttp,
  connectRpc,
  loginAsAdmin,
  newKeyPair,
  startMesh,
  type KeyPair,
  type Mesh,
  type Signer,
} from "./harness";

/**
 * The mesh the current scenario is running against, and its admin session.
 *
 * Mutable rather than a parameter threaded through every verb: a scenario
 * declaring `mesh` gets its own, and the alternative was passing a context
 * object into eight cases that mostly ignore it.
 */
let mesh: Mesh;
let adminCookie: string;

/** The shared one, kept for the whole file. Restored after a scenario borrows. */
let shared: Mesh;
let sharedCookie: string;

/** Key material per identity, so a later step can sign as an earlier one. */
const keys = new Map<string, KeyPair>();

beforeAll(async () => {
  shared = await startMesh();
  sharedCookie = await loginAsAdmin(shared.http);
  mesh = shared;
  adminCookie = sharedCookie;
});

afterAll(() => shared?.stop());

/**
 * Run `body` against a mesh shaped as the scenario asked for.
 *
 * Started per scenario rather than pooled by config: two scenarios sharing a
 * short-lease mesh would share its identities too, and the ones that need a
 * different shape are exactly the ones whose timing another scenario would
 * disturb.
 */
async function onOwnMesh(req: NonNullable<Scenario["mesh"]>, body: () => Promise<void>) {
  const env: Record<string, string> = {};
  if (req.receiveLeaseSeconds !== undefined) {
    env.AGENT_MESH_RECEIVE_LEASE_SECONDS = String(req.receiveLeaseSeconds);
  }
  const own = await startMesh({ env });
  mesh = own;
  adminCookie = await loginAsAdmin(own.http);
  try {
    await body();
  } finally {
    mesh = shared;
    adminCookie = sharedCookie;
    own.stop();
  }
}

const signer = (identity: string): Signer => {
  const k = keys.get(identity);
  if (!k) throw new Error(`no key for ${identity} — provision it with key: true first`);
  return { kid: k.fingerprint, privateKey: k.privateKey };
};

/**
 * The batch a `receive` leased, so the next one can settle it.
 *
 * Per identity rather than global: § 8.10.1 scopes a lease to the caller, and a
 * single slot here would let one scenario acknowledge another's messages.
 */
const leased = new Map<string, string[]>();

/**
 * JSON-RPC over HTTP for every verb that has an RPC form.
 *
 * The socket transport is covered thoroughly elsewhere; what these scenarios are
 * for is the surface the *client* speaks, and § 8.10 is that surface. Running
 * both would double the file to re-measure a path `hub.test.ts` already pins.
 */
async function rpc(identity: string, method: string, params: unknown) {
  return callHttp(mesh.hub, signer(identity), method, params);
}

async function runStep(step: Step, ctx: string): Promise<void> {
  switch (step.do) {
    case "provision": {
      // `reuseKeyOf` deliberately does **not** overwrite the map: the scenario
      // using it is about a *refused* registration, and recording the thief as
      // holding the key would let a later step sign as an identity the hub
      // never accepted.
      const key = step.key ? newKeyPair() : undefined;
      if (key) keys.set(step.identity, key);
      const borrowed = step.reuseKeyOf ? keys.get(step.reuseKeyOf) : undefined;
      if (step.reuseKeyOf && !borrowed) {
        throw new Error(`${ctx}: ${step.reuseKeyOf} holds no key to reuse`);
      }
      const publicKey = key?.publicKey ?? borrowed?.publicKey;
      const res = await fetch(`${mesh.hub.url}/api/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identity: step.identity,
          type: step.type,
          ...(publicKey ? { public_key: publicKey } : {}),
          ...(step.extra ?? {}),
        }),
      });
      if (step.expect) {
        expect(res.status, `${ctx} status`).toBe(step.expect.status);
        if (step.expect.code) {
          expect((await res.json()).code, `${ctx} code`).toBe(step.expect.code);
        }
      }
      return;
    }

    case "approve":
    case "revoke": {
      const k = keys.get(step.identity);
      if (!k) throw new Error(`${ctx}: ${step.identity} holds no key to decide on`);
      const res = await fetch(
        `${mesh.http.url}/api/v1/admin/keys/${step.do === "approve" ? "approve" : "revoke"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: adminCookie },
          body: JSON.stringify({
            fingerprint: k.fingerprint,
            ...(step.do === "revoke" ? { reason: step.reason } : {}),
          }),
        },
      );
      // Not scenario data: a decision that did not take makes every later step
      // measure the wrong state, and the confusing failure is worth one line
      // here to avoid.
      expect(res.status, `${ctx}: ${step.do} did not take`).toBeLessThan(300);
      return;
    }

    case "connect": {
      // Over a socket, not `/api/v1/rpc`. § 8.10 refuses `mesh.connect` there
      // by design — a socketless caller has no session to establish — so the
      // first run of this file failed on a correct refusal. The verb means what
      // it says: open a lane.
      const client = await connectRpc(mesh.hub, signer(step.identity));
      try {
        const body = await client.call("mesh.connect", { identity: step.identity });
        assertRpc(body, step.expect, ctx);
      } finally {
        // Closed immediately: these scenarios are about what connecting
        // *decides*, and a socket left open keeps the identity online for every
        // later scenario, which quietly changes what delivery measures.
        client.close();
      }
      return;
    }

    case "send": {
      const out = await rpc(step.from, "mesh.send", {
        to: step.to,
        content: step.content,
        ...(step.clientMessageId ? { client_message_id: step.clientMessageId } : {}),
      });
      assertRpc(out.body, step.expect, ctx);
      return;
    }

    case "receive": {
      const ack = step.ackPrevious ? (leased.get(step.identity) ?? []) : [];
      const out = await rpc(step.identity, "mesh.receive", ack.length ? { ack_ids: ack } : {});
      expect(out.body.error, `${ctx}: receive failed`).toBeUndefined();
      const messages: Array<{ id: string }> = out.body.result?.messages ?? [];
      leased.set(step.identity, messages.map((m) => m.id));
      if (step.expectCount !== undefined) {
        expect(messages.length, `${ctx}: message count`).toBe(step.expectCount);
      }
      return;
    }

    case "http": {
      // `as` decides the credential, and `"none"` is a real case rather than an
      // omission — § 9.2 has unauthenticated routes and a scenario about one of
      // them has to be able to say so.
      const res = await fetch(`${base(step.path)}${step.path}`, {
        method: step.method,
        headers: {
          "content-type": "application/json",
          ...(step.as === "admin" ? { cookie: adminCookie } : {}),
        },
        ...(step.body ? { body: JSON.stringify(step.body) } : {}),
      });
      if (step.expect) {
        expect(res.status, `${ctx} status`).toBe(step.expect.status);
        if (step.expect.code) {
          expect((await res.json()).code, `${ctx} code`).toBe(step.expect.code);
        }
      }
      return;
    }

    case "sleep":
      await Bun.sleep(step.seconds * 1000);
      return;

    case "expectStored":
      return expectStored(step, ctx);
  }
}

/** Admin surfaces are on the http server; everything else on the hub. */
const base = (path: string) =>
  path.startsWith("/api/v1/admin") || path.startsWith("/api/v1/audit")
    ? mesh.http.url
    : mesh.hub.url;

function assertRpc(body: any, expected: Step extends never ? never : any, ctx: string): void {
  if (!expected) return;
  if (expected.error === null) {
    expect(body.error, `${ctx}: expected success, got ${JSON.stringify(body.error)}`).toBeUndefined();
    return;
  }
  if (expected.error !== undefined) {
    expect(body.error?.code, `${ctx}: error code`).toBe(expected.error);
  }
  if (expected.dataCode) {
    expect(body.error?.data?.code, `${ctx}: data.code`).toBe(expected.dataCode);
  }
}

/**
 * The trace checks.
 *
 * Read-only handles opened per call rather than held: the services are writing
 * to these files, and a handle kept across a scenario is a handle holding a
 * snapshot from before the step that was supposed to write.
 */
function expectStored(step: Extract<Step, { do: "expectStored" }>, ctx: string): void {
  const open = (file: string) => new Database(`${mesh.stateDir}/${file}`, { readonly: true });

  switch (step.what) {
    case "sourceRecorded": {
      const db = open("agents.db");
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM agent_sources WHERE identity = ?`)
        .get(step.identity) as { n: number };
      db.close();
      expect(row.n, `${ctx}: no observed source recorded`).toBeGreaterThan(0);
      return;
    }
    case "auditReadLogged": {
      // Into `audit_events` rather than a table of its own. § 11.0.1 puts the
      // record where every other event goes, so an operator reviewing the trail
      // sees reads of it in the same place — a separate table would be a second
      // trail somebody has to remember to look at.
      const db = open("audit.db");
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'mesh.identity.audit_read'`,
        )
        .get() as { n: number };
      db.close();
      expect(row.n, `${ctx}: audit read left no trace`).toBeGreaterThan(0);
      return;
    }
    case "typeChangeRecorded": {
      const db = open("audit.db");
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events
            WHERE event_type = 'mesh.identity.type_changed' AND identity = ?`,
        )
        .get(step.identity) as { n: number };
      db.close();
      expect(row.n, `${ctx}: type change left no audit event`).toBeGreaterThan(0);
      return;
    }
  }
}

describe("shared scenarios (SPEC § 17)", () => {
  // `for` rather than `test.each` so the clause and the reason are in the name.
  // A failure reads as the contract clause it broke, which is the only thing
  // that makes a red run in the other repository comparable to a red run here.
  for (const scenario of E2E_SCENARIOS as readonly Scenario[]) {
    const run = async () => {
      for (const [i, step] of scenario.steps.entries()) {
        await runStep(step, `${scenario.id} step ${i + 1} (${step.do})`);
      }
    };
    // Timeout scaled to what the scenario declares it will wait for. A fixed
    // one would have to be as long as the slowest scenario, which hides a hang
    // in all the others.
    const budget = scenario.steps.reduce(
      (ms, s) => ms + (s.do === "sleep" ? s.seconds * 1000 : 0),
      30_000,
    );
    test(
      `${scenario.id} — ${scenario.clause}`,
      async () => (scenario.mesh ? onOwnMesh(scenario.mesh, run) : run()),
      budget,
    );
  }
});

/**
 * The list itself is contract, so its shape is pinned here.
 *
 * A scenario without a clause is one nobody can trace back, and this is the
 * cheapest place to refuse it. The duplicate check exists because the ids are
 * how the two repositories compare runs: two scenarios sharing an id make one of
 * the two reports silently about the wrong thing.
 */
describe("the scenario list", () => {
  test("every scenario cites a clause and states what it protects", () => {
    for (const s of E2E_SCENARIOS) {
      expect(s.clause, `${s.id} has no clause`).toMatch(/§/);
      expect(s.why.length, `${s.id} has no stated reason`).toBeGreaterThan(40);
      expect(s.steps.length, `${s.id} has no steps`).toBeGreaterThan(0);
    }
  });

  test("ids are unique", () => {
    const ids = E2E_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("this runner implements every verb the list uses", () => {
    // The check that matters. A scenario added on the client's side with a verb
    // this runner does not handle would otherwise pass here by falling out of
    // the `switch` — a green run for a scenario that never ran.
    const implemented = new Set([
      "provision", "approve", "revoke", "connect", "send", "receive", "http", "sleep", "expectStored",
    ]);
    const used = new Set(E2E_SCENARIOS.flatMap((s) => s.steps.map((st) => st.do)));
    const missing = [...used].filter((v) => !implemented.has(v));
    expect(missing, `verbs used by the list but not run here: ${missing.join(", ")}`).toEqual([]);
  });
});

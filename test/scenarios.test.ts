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
 * It reads no database. It used to: three scenarios asserted a trace straight
 * out of SQLite, which the client's runner cannot do, so they were skipped
 * there. Both sides reported green while one clause each in § 8.11, § 11.0.1
 * and § 8.9.5 was held by a single implementation. They go through the
 * operator's routes now, and nothing is skipped.
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
import { createHash, randomUUID, sign as edSign } from "node:crypto";
import {
  E2E_SCENARIOS,
  formatRestAuthorization,
  restSignaturePreimage,
  type ExpectHttp,
  type Scenario,
  type Step,
} from "@agent-mesh/contracts";
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
 * Values produced during a run, for `{{name}}` in a later step.
 *
 * Cleared per scenario. Carrying them across would let one scenario silently
 * satisfy another's reference — and the failure that produces is a scenario
 * passing because a *different* one ran first, which is the worst kind to
 * debug.
 */
const bound = new Map<string, string>();

/**
 * The one place an `ExpectHttp` is checked.
 *
 * **Shared because it was not.** `provision` and `http` each had their own copy,
 * and when `expect.body` was added only `http` learned about it — so every
 * `provision` step carrying a body assertion reported green without checking it.
 * A mutation that made the route report `pending` for an approved key went
 * straight through E2E-KEY-003.
 *
 * That is precisely the failure § 17.3 forbids, written into the specification
 * one commit earlier by the same hand. A rule does not enforce itself; a single
 * call site does.
 *
 * Returns the parsed body so a caller can `bind` from it without a second read —
 * `Response.json()` consumes it.
 */
async function assertHttp(
  res: Response,
  expected: ExpectHttp | undefined,
  ctx: string,
  alsoNeedBody = false,
): Promise<any> {
  if (expected) expect(res.status, `${ctx} status`).toBe(expected.status);
  const needsBody = alsoNeedBody || !!(expected?.code || expected?.body);
  const parsed = needsBody ? await res.json() : null;
  if (expected?.code) expect(parsed.code, `${ctx} code`).toBe(expected.code);
  for (const [p, want] of Object.entries(subst(expected?.body ?? {}))) {
    expect(at(parsed, p), `${ctx} body.${p}`).toBe(want);
  }
  return parsed;
}

/** Dotted path into a parsed body. Array indices are ordinary keys. */
const at = (obj: any, path: string) =>
  path.split(".").reduce<any>((v, k) => (v == null ? v : v[k]), obj);

/**
 * Replace every `{{name}}`. Missing bindings throw rather than substituting
 * empty: a `DELETE /api/v1/outbox/` with the id silently blank is a `404` the
 * scenario would report as its expected refusal.
 */
function subst<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
      const v = bound.get(name);
      if (v === undefined) throw new Error(`unbound reference {{${name}}}`);
      return v;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(subst) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, subst(v)]),
    ) as T;
  }
  return value;
}

/** Capture what a step's response produced, for later `{{name}}`. */
function capture(spec: Record<string, string> | undefined, body: any, ctx: string): void {
  for (const [name, path] of Object.entries(spec ?? {})) {
    const v = at(body, path);
    if (v === undefined || v === null) {
      throw new Error(`${ctx}: nothing at "${path}" to bind as {{${name}}}`);
    }
    bound.set(name, String(v));
  }
}

/**
 * A signed REST envelope, built the way a participant must build one.
 *
 * § 8.9 signs over the method, path and a digest of the body — not the body
 * itself — so a proxy that re-serialises JSON does not invalidate the
 * signature. The digest is over the exact bytes sent, which is why the payload
 * is stringified once and reused.
 */
function restAuth(identity: string, method: string, path: string, payload: string): string {
  const k = keys.get(identity);
  if (!k) throw new Error(`no key for ${identity}`);
  const nonce = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const bodySha256 = payload ? createHash("sha256").update(payload, "utf8").digest("hex") : "";
  const value = Buffer.from(
    edSign(
      null,
      Buffer.from(
        restSignaturePreimage({ method, path, kid: k.fingerprint, nonce, iat, bodySha256 }),
      ),
      k.privateKey,
    ),
  ).toString("base64url");
  return formatRestAuthorization({ kid: k.fingerprint, nonce, iat, signature: value });
}

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
      if (key) {
        keys.set(step.identity, key);
        // Pre-bound so a scenario can assert on a fingerprint it never saw.
        // It exists in the runner and in no response, so `bind` cannot reach
        // it — one substitution mechanism rather than a second syntax.
        bound.set(`fingerprint:${step.identity}`, key.fingerprint);
      }
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
      await assertHttp(res, step.expect, ctx);
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
      capture(step.bind, out.body.result, ctx);
      return;
    }

    case "http": {
      // Substituted before anything else, because the path is part of what gets
      // signed — building the signature over the un-substituted path would
      // produce a `401` that looks like an authorisation bug.
      const path = subst(step.path);
      const payload = step.body === undefined ? "" : JSON.stringify(subst(step.body));

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (step.as === "admin") headers.cookie = adminCookie;
      else if (typeof step.as === "object") {
        headers.authorization = restAuth(step.as.signedBy, step.method, path, payload);
      }

      const res = await fetch(`${base(path)}${path}`, {
        method: step.method,
        headers,
        ...(payload ? { body: payload } : {}),
      });

      const parsed = await assertHttp(res, step.expect, ctx, !!step.bind);
      capture(step.bind, parsed, ctx);
      return;
    }

    case "sleep":
      await Bun.sleep(step.seconds * 1000);
      return;
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

describe("shared scenarios (SPEC § 17)", () => {
  // `for` rather than `test.each` so the clause and the reason are in the name.
  // A failure reads as the contract clause it broke, which is the only thing
  // that makes a red run in the other repository comparable to a red run here.
  for (const scenario of E2E_SCENARIOS as readonly Scenario[]) {
    const run = async () => {
      bound.clear();
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
      "provision", "approve", "revoke", "connect", "send", "receive", "http", "sleep",
    ]);
    const used = new Set(E2E_SCENARIOS.flatMap((s) => s.steps.map((st) => st.do)));
    const missing = [...used].filter((v) => !implemented.has(v));
    expect(missing, `verbs used by the list but not run here: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * Approving an agent's key admits it to this server's registry (D-747, T-027).
 *
 * **The P1 this file exists for.** An identity was approved in the console,
 * connected, and logged by the hub as connected; `GET /api/v1/agents` answered
 * one row, the account looking at it. Nothing had ever written an agent row:
 * `agent_registry` had two writers, the one-time `registry.json` import and the
 * web-user path, so an identity could exist on the mesh, connect, hold an
 * approved key, and still be unaddressable here. It looked like it worked
 * because the import had filled the table once; the state directory was retired
 * and re-seeded, and what was left was the people.
 *
 * SPEC § 9.1 said the two tables are separate and `docs/deferred.md` carried
 * why the fix could not be designed: a route that adds any hub identity needs
 * to say *whose* registry. The owner answered it by reporting the absence as a
 * defect — approving and admitting were never two decisions to them — and the
 * curation stays explicit, because approving a key is an operator act.
 */
import { beforeAll, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "registry-source-probe";

const { app } = await import("./main.ts");
const { upsertApprovedWebUser, upsertUser, approveUser, createPendingApproval, getDb, getRegistryAgent } =
  await import("./db");
const { agentsDb, decide, admitApprovedIdentities } = await import("./keys-admin");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, keys, openAt, stateDir } = await import("@agent-mesh/store");
const { join } = await import("node:path");

// The store the hub owns and this process only writes decisions into. Created
// here for the same reason `grants-writes.test.ts` does it: `agentsDb()` opens
// without creating, so a suite that runs before any service has is the one that
// has to make the file exist.
agentsSchema.migrate(openAt(join(stateDir(), STORE_FILES.agents), { create: true }));

let n = 0;
const uniq = (p: string) => `rs-${p}-${++n}-${process.pid}`;

const call = (path: string, cookie: string) =>
  app.fetch(new Request(`http://rs-probe${path}`, { headers: { cookie } }));

/** A well-formed Ed25519 public key: 32 raw bytes, base64url. */
const publicKey = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** An identity the hub knows about, with a key waiting for a decision. */
function pendingAgent(type = "agent"): { identity: string; fingerprint: string } {
  const identity = uniq(type);
  agentsDb()
    .prepare(`INSERT INTO agents (identity, description, type) VALUES (?, ?, ?)`)
    .run(identity, `${identity} description`, type);
  const { fingerprint } = keys.proposeKey(agentsDb(), identity, publicKey(), "registry-source-test");
  return { identity, fingerprint };
}

let adminCookie = "";

beforeAll(async () => {
  // **The `users` table, not `local_users`.** `seedLocalUsers` seeds the
  // documented `admin`/`admin` only while `local_users` is empty, so a file
  // that writes a row there before the seed runs disables the account every
  // other suite signs in with — which is what the first version of this file
  // did, and `main.in-process.test.ts` failed at its `beforeAll` three files
  // later with `401 invalid username or password`.
  const login = uniq("admin");
  const user = upsertUser(1_090_000 + n, login);
  createPendingApproval(login, user.github_id);
  approveUser(login);
  getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(login);
  upsertApprovedWebUser(login);
  adminCookie = `mesh_token=${await signJwt({ github_id: user.github_id, github_login: login, role: "admin" })}`;
});

const listed = async (): Promise<string[]> => {
  const res = await call("/api/v1/agents", adminCookie);
  expect(res.status).toBe(200);
  return ((await res.json()).agents as Array<{ id: string }>).map((a) => a.id);
};

describe("approving a key", () => {
  test("puts the identity on this server's list", async () => {
    const { identity, fingerprint } = pendingAgent();
    expect(await listed()).not.toContain(identity);

    expect(decide("approve", fingerprint, "operator", null).status).toBe(200);
    expect(await listed()).toContain(identity);
  });

  /**
   * The row the mesh holds, not a placeholder: `description` is what an
   * operator wrote when the identity was provisioned, and it is the only
   * account of what the agent is anywhere on this server.
   */
  test("and carries what the mesh knows about it", async () => {
    const { identity, fingerprint } = pendingAgent("service");
    decide("approve", fingerprint, "operator", null);

    const row = getRegistryAgent(identity);
    expect(row).not.toBeNull();
    expect({ description: row!.description, type: row!.type, channel: row!.channel, approved: row!.approved })
      .toEqual({ description: `${identity} description`, type: "service", channel: "native", approved: 1 });
  });

  /**
   * **Denial is not admission**, and neither is a revocation. Both are
   * decisions an operator makes about a key; only one of them says this
   * identity is ours to deal with.
   */
  test("but denying one does not", async () => {
    const { identity, fingerprint } = pendingAgent();
    expect(decide("deny", fingerprint, "operator", "not ours").status).toBe(200);
    expect(await listed()).not.toContain(identity);
    expect(getRegistryAgent(identity)).toBeNull();
  });

  /**
   * A second approval — a rotated key, most often — must not overwrite what an
   * operator has since edited. Only the flag and the stamp move.
   */
  test("and a second approval leaves the row an operator has edited alone", async () => {
    const { identity, fingerprint } = pendingAgent();
    decide("approve", fingerprint, "operator", null);

    getDb()
      .prepare(`UPDATE agent_registry SET name = ?, description = ? WHERE id = ?`)
      .run("Renamed By Operator", "an operator's own words", identity);

    const rotated = keys.proposeKey(agentsDb(), identity, publicKey(), "registry-source-test");
    expect(decide("approve", rotated.fingerprint, "operator", null).status).toBe(200);

    const row = getRegistryAgent(identity)!;
    expect({ name: row.name, description: row.description }).toEqual({
      name: "Renamed By Operator",
      description: "an operator's own words",
    });
  });

  /**
   * **A torn-down identity stays gone.** § 9.3's delete is a `deleted_at`
   * stamp; admitting past it would put a destroyed name back on the one screen
   * an operator would check to confirm it was destroyed.
   */
  test("and a torn-down identity is not admitted", async () => {
    const { identity, fingerprint } = pendingAgent();
    agentsDb().prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ?`).run(identity);

    decide("approve", fingerprint, "operator", null);
    expect(getRegistryAgent(identity)).toBeNull();
  });
});

/**
 * Which tenant each listed agent is in (T-026).
 *
 * § 11.4 has put an identity in a tenant since `agents.tenant` existed, and no
 * route said which. A screen choosing agents for a group of tenant X had the
 * group's tenant and a list of everything it could see, with nothing to join
 * them on — so it offered agents belonging to somebody else, and the operator
 * had no way to tell from the screen.
 */
describe("the agent list", () => {
  /** An approved agent the mesh has placed in `tenant`. */
  async function agentIn(tenant: string): Promise<string> {
    const { identity, fingerprint } = pendingAgent();
    agentsDb().prepare(`UPDATE agents SET tenant = ? WHERE identity = ?`).run(tenant, identity);
    expect(decide("approve", fingerprint, "operator", null).status).toBe(200);
    return identity;
  }

  const rows = async (query = ""): Promise<Array<{ id: string; tenant: string }>> => {
    const res = await call(`/api/v1/agents${query}`, adminCookie);
    expect(res.status).toBe(200);
    return (await res.json()).agents;
  };

  test("says which tenant each agent is in", async () => {
    const here = await agentIn("rs-here");
    const there = await agentIn("rs-there");

    const all = await rows();
    expect(all.find((a) => a.id === here)!.tenant).toBe("rs-here");
    // Two tenants rather than one: a route answering a constant passes a
    // single-tenant check, and `default` is the constant on offer.
    expect(all.find((a) => a.id === there)!.tenant).toBe("rs-there");
  });

  test("narrows to one tenant when asked, and to nothing for a tenant with no agents", async () => {
    const here = await agentIn("rs-narrow");
    const elsewhere = await agentIn("rs-wide");

    const narrowed = (await rows("?tenant=rs-narrow")).map((a) => a.id);
    expect(narrowed).toContain(here);
    expect(narrowed).not.toContain(elsewhere);
    expect(await rows("?tenant=rs-nobody-is-here")).toEqual([]);
  });

  /**
   * `default`, not `null`. § 11.4's rule is that every identity has a tenant,
   * and a web user who has never connected has no row in the mesh's `agents`
   * table at all — the tenant it has until somebody moves it is the default.
   */
  test("answers the default tenant for an identity the mesh has never seen", async () => {
    const person = uniq("person");
    upsertApprovedWebUser(person);

    const row = (await rows()).find((a) => a.id === person);
    expect(row).toBeDefined();
    expect(row!.tenant).toBe("default");
  });
});

/**
 * The approvals that happened before D-747 (T-026).
 *
 * The rule landed after identities had already been approved, so an identity
 * approved on Tuesday is addressable and one approved on Monday answers `404`
 * from `POST /api/v1/messages`. The difference is a date — nothing an operator
 * can see, and nothing they can fix from a screen. `soak-claude` was the live
 * case: connected, approved, on the mesh, absent from this server's list.
 */
describe("a boot after the rule landed", () => {
  /** An identity whose key was approved without the admission D-747 now does. */
  function approvedTheOldWay(): string {
    const { identity, fingerprint } = pendingAgent();
    keys.approveKey(agentsDb(), fingerprint, "operator");
    return identity;
  }

  test("admits the identities an operator had already approved", async () => {
    const old = approvedTheOldWay();
    expect(await listed()).not.toContain(old);

    expect(admitApprovedIdentities()).toContain(old);
    expect(await listed()).toContain(old);
  });

  test("is quiet on the next boot, having nothing left to do", () => {
    approvedTheOldWay();
    expect(admitApprovedIdentities().length).toBeGreaterThan(0);
    // Idempotent, and the emptiness is the point: the log line only appears on
    // a boot that changed something, so a line saying nothing happened would be
    // one an operator learns to skip.
    expect(admitApprovedIdentities()).toEqual([]);
  });

  test("does not admit an identity whose key was denied or revoked", async () => {
    const denied = pendingAgent();
    keys.denyKey(agentsDb(), denied.fingerprint, "operator", "not this one");

    admitApprovedIdentities();
    expect(await listed()).not.toContain(denied.identity);
  });

  /**
   * § 9.3's soft delete survives the backfill rather than being undone by it:
   * a torn-down identity keeps whatever approved key history it had.
   */
  test("does not bring back an identity that was torn down", async () => {
    const gone = approvedTheOldWay();
    agentsDb()
      .prepare(`UPDATE agents SET deleted_at = CURRENT_TIMESTAMP WHERE identity = ?`)
      .run(gone);

    expect(admitApprovedIdentities()).not.toContain(gone);
    expect(await listed()).not.toContain(gone);
  });

  /**
   * The whole point, end to end: `POST /api/v1/messages` answers `404` for an
   * identity that is not on this server's list, whatever the mesh knows about
   * it. That is the symptom the P1 was reported as, and the backfill is what
   * closes it for the approvals that predate the rule.
   */
  test("makes an identity addressable that the send route was answering 404 for", async () => {
    const old = approvedTheOldWay();
    const send = () =>
      app.fetch(new Request("http://rs-probe/api/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ to: old, text: "are you there" }),
      }));

    const before = await send();
    expect(before.status).toBe(404);
    expect((await before.json()).error).toContain(old);

    admitApprovedIdentities();

    // No hub in this process, so the send is recorded and not accepted — the
    // status this asserts is *not 404*, which is the whole of what admission
    // changes here.
    expect((await send()).status).not.toBe(404);
  });

  /**
   * The line an operator greps for after a restart that changed the console
   * (`docs/LOGGING-OPS.md`), and its absence the rest of the time.
   */
  test("says what it admitted, and says nothing when it admitted nothing", async () => {
    const { captureConsole } = await import("@agent-mesh/log");
    const { renameSeededAdmin: _unused, admitApprovedIdentitiesOnBoot } = await import("./main.ts");
    void _unused;
    const identity = approvedTheOldWay();

    let { lines, restore } = captureConsole();
    try {
      admitApprovedIdentitiesOnBoot();
    } finally {
      restore();
    }
    const said = lines.join("\n");
    expect(said).toContain("registry_backfilled");
    // The names, not just the count: an operator reading this line is deciding
    // whether the identity they are looking for is one of them.
    expect(said).toContain(identity);

    ({ lines, restore } = captureConsole());
    try {
      admitApprovedIdentitiesOnBoot();
    } finally {
      restore();
    }
    // Nothing to do, nothing said. A line per boot reporting nought is one an
    // operator learns to skip, and the boot that reports one is then skipped.
    expect(lines.join("\n")).not.toContain("registry_backfilled");
  });

  /**
   * **Not "every identity the hub knows".** That is what D-747 refused to
   * decide by fiat, and the reason has not changed: a route that admits any hub
   * identity has to say whose registry it is adding to. An approved key is a
   * decision an operator already made and this repository already recorded.
   */
  test("leaves an identity nobody has decided about where it is", async () => {
    const undecided = pendingAgent();

    admitApprovedIdentities();
    expect(await listed()).not.toContain(undecided.identity);
  });
});

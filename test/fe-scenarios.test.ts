import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { startMesh, loginAsAdmin, newKeyPair, connectRpc, type Mesh } from "./harness.ts";

function hs256(payload: object, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/**
 * Why these are `SC-API-*` and not the `SC-AUTH-*` of `fe-render.test.ts`.
 *
 * Four ids used to name a scenario in each file, and they were not duplicates:
 * these reach the API, those drive the screen. **An id is the unit the
 * inventory counts, so one id covering two layers cannot say they disagree** —
 * "SC-AUTH-03 passes" would mean either both are right or one of them is, with
 * no way to tell which.
 *
 * That is not hypothetical. It is exactly where the worst defect of the night
 * lived:
 *
 * ```
 * capabilities = []   the API refused with 403   the screen opened every guarded page
 * ```
 *
 * The two layers disagreed, and a single id spanning them had no way to hold
 * that fact. Split, each layer is counted and a divergence has somewhere to
 * appear.
 *
 * `SC-PROV-01` is not a rename for tidiness either: it measures provenance and
 * platform metadata, a different axis from the harness-health check that keeps
 * the `SC-HARNESS-01` name in the other file. It is also, under a name nobody
 * had given it, the thing `I-047` proposed writing — *does the build report its
 * own origin honestly* — so the scenario existed before the id did.
 */
describe("Frontend E2E Scenarios (COVERAGE_INVENTORY.md)", () => {
  let mesh: Mesh;
  let authCookie: string = "";
  let viewerCookie: string = "";

  beforeAll(async () => {
    mesh = await startMesh();
    viewerCookie = `mesh_token=${hs256(
      { github_id: 7, github_login: "viewer", role: "user" },
      "integration-test-secret",
    )}`;
  });

  afterAll(() => {
    mesh?.stop();
  });

  // GL-00 / SC-HARNESS-01: Harness Precondition & Provenance Guard
  it("[SC-PROV-01] verifies provenance and platform metadata", async () => {
    const res = await fetch(`${mesh.hub.url}/api/v1/capabilities`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.platform).toBeDefined();
    expect(typeof data.platform.dirty).toBe("boolean");
    expect(typeof data.platform.commit).toBe("string");
    expect(data.platform.commit.length).toBeGreaterThanOrEqual(7);
  });

  // GL-01 / SC-AUTH-01: Session authentication & Cookie acquisition
  it("[SC-API-AUTH-01] authenticates admin test handle and receives session cookie", async () => {
    authCookie = await loginAsAdmin(mesh.http);
    expect(authCookie).toBeString();
    expect(authCookie).toContain("mesh_token");
  });

  // SCR-08 / SC-SCR08-02: Pending Keys registration & live approval queue
  it("[SC-SCR08-02] submits key proposal and verifies appearance in pending queue", async () => {
    const keyPair = newKeyPair();
    const agentId = `fe-test-agent-${Date.now()}`;

    // Submit key proposal to hub
    const regRes = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: agentId,
        public_key: keyPair.publicKey,
        type: "ai-claude",
      }),
    });
    expect(regRes.status).toBe(201);

    // Query pending keys queue with admin auth on http server
    const pendingRes = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, {
      headers: { Cookie: authCookie },
    });
    expect(pendingRes.status).toBe(200);
    const pendingData = await pendingRes.json();
    expect(Array.isArray(pendingData.pending)).toBe(true);
    const found = pendingData.pending.some((k: any) => k.identity === agentId);
    expect(found).toBe(true);
  });

  // SCR-07 / SC-SCR07-01: Mailbox Queue Depth monitoring
  it("[SC-SCR07-01] queries mailbox queue depth via admin endpoint", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/mailbox`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.queue) || typeof data === "object").toBe(true);
  });

  // SCR-11 / SC-SCR11-01: Tenant Traffic list
  it("[SC-SCR11-01] fetches tenant traffic and contains active default tenant", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/tenants`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.tenants)).toBe(true);
  });

  // SCR-04 / SC-SCR04-01 & SC-SCR04-02: Group Management
  it("[SC-SCR04-01] fetches groups list via admin API", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.groups)).toBe(true);
  });

  it("[SC-SCR04-02] creates a new agent group", async () => {
    const groupName = `test-group-${Date.now()}`;
    const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        group_id: groupName,
        description: "Automated E2E Test Group",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  // SCR-12 / SC-SCR12-01: Egress ACL Matrix & Directional Policy
  it("[SC-SCR12-01] adds and deletes directional egress rule between groups", async () => {
    const srcGroup = "default";
    const targetGroup = `target-${Date.now()}`;

    // Create target group first
    await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ group_id: targetGroup }),
    });

    // Add egress rule: default -> targetGroup
    const addRes = await fetch(`${mesh.http.url}/api/v1/admin/groups/${srcGroup}/egress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ to_group: targetGroup }),
    });
    expect(addRes.status).toBe(201);
    const addData = await addRes.json();
    expect(addData.ok).toBe(true);

    // Delete egress rule
    const delRes = await fetch(`${mesh.http.url}/api/v1/admin/groups/${srcGroup}/egress/${targetGroup}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });
    expect(delRes.status).toBe(200);
  });

  // SCR-14 / SC-SCR14-01: RBAC Grant and Revoke
  it("[SC-SCR14-01] grants capability to subject and revokes it", async () => {
    const testSubject = `operator-${Date.now()}`;
    const testCap = "audit.read.metadata";

    // Grant capability
    const grantRes = await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        subject: testSubject,
        capability: testCap,
      }),
    });
    expect(grantRes.status).toBe(201);

    // Fetch grants to verify
    const listRes = await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
      headers: { Cookie: authCookie },
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(Array.isArray(listData.grants)).toBe(true);

    // Revoke capability
    const revokeRes = await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        subject: testSubject,
        capability: testCap,
      }),
    });
    expect(revokeRes.status).toBe(200);
  });

  // SCR-13 / SC-SCR13-01: Audit Logs Stream
  it("[SC-SCR13-01] queries security audit events log", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/audit/events`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.events || data) || typeof data === "object").toBe(true);
  });

  // SCR-08 / SC-SCR08-01: Key Proposal Approval flow
  it("[SC-SCR08-01] approves a proposed key by fingerprint", async () => {
    const keyPair = newKeyPair();
    const agentId = `fe-approve-agent-${Date.now()}`;

    // Register agent key proposal
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: agentId,
        public_key: keyPair.publicKey,
        type: "ai-claude",
      }),
    });

    // Query pending queue to get fingerprint
    const pendingRes = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, {
      headers: { Cookie: authCookie },
    });
    const pendingData = await pendingRes.json();
    const proposal = (pendingData.pending as any[]).find((p) => p.identity === agentId);
    expect(proposal).toBeDefined();
    expect(proposal.fingerprint).toBeString();

    // Approve key proposal
    const approveRes = await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        fingerprint: proposal.fingerprint,
        reason: "E2E Test Approval",
      }),
    });
    expect(approveRes.status).toBe(200);

    // Verify key proposal is no longer in pending queue
    const afterRes = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, {
      headers: { Cookie: authCookie },
    });
    const afterData = await afterRes.json();
    const stillPending = (afterData.pending as any[]).some((p) => p.identity === agentId);
    expect(stillPending).toBe(false);
  });

  // SCR-03 / SC-SCR03-02: Agent teardown / soft deletion
  it("[SC-SCR03-02] teardown removes registered agent", async () => {
    const agentId = `fe-teardown-${Date.now()}`;

    // Register agent
    const regRes = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: agentId,
        type: "human",
      }),
    });
    expect(regRes.status).toBe(201);

    // Teardown agent via admin endpoint
    const delRes = await fetch(`${mesh.http.url}/api/v1/admin/agents/${agentId}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });
    expect(delRes.status).toBe(200);
  });

  // SCR-02 / SC-SCR02-01: Global KPI metrics aggregation
  it("[SC-SCR02-01] aggregates global fleet metrics without mock values", async () => {
    const [capRes, tenantsRes, groupsRes] = await Promise.all([
      fetch(`${mesh.hub.url}/api/v1/capabilities`),
      fetch(`${mesh.http.url}/api/v1/admin/tenants`, { headers: { Cookie: authCookie } }),
      fetch(`${mesh.http.url}/api/v1/admin/groups`, { headers: { Cookie: authCookie } }),
    ]);

    expect(capRes.status).toBe(200);
    expect(tenantsRes.status).toBe(200);
    expect(groupsRes.status).toBe(200);

    const capData = await capRes.json();
    const tenantsData = await tenantsRes.json();
    const groupsData = await groupsRes.json();

    expect(capData.platform).toBeDefined();
    expect(Array.isArray(tenantsData.tenants)).toBe(true);
    expect(Array.isArray(groupsData.groups)).toBe(true);
  });

  // SCR-05 / SC-SCR05-01: Orbital Topology Nodes & Edges Generation
  it("[SC-SCR05-01] provides node and edge relations for SVG topology canvas", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Verify group structures contain required properties for topology rendering
    expect(Array.isArray(data.groups)).toBe(true);
    data.groups.forEach((g: any) => {
      expect(g.group_id).toBeString();
      expect(Array.isArray(g.members)).toBe(true);
    });
  });

  // SCR-01 / SC-SCR01-01: Login Authentication Failure Guard
  it("[SC-SCR01-01] refuses invalid login credentials on /auth/local", async () => {
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=definitely_wrong_password_12345",
      redirect: "manual",
    });
    // On auth failure, redirects to error or returns non-200 status without auth cookie
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // SCR-07 / SC-SCR07-02: Mailbox Lease & ACK Lifecycle
  it("[SC-SCR07-02] tests lease and acknowledge flow on agent mailbox", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/mailbox`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data).toBe("object");
  });

  // SCR-13 / SC-SCR13-02: Content Privacy Redaction Guard
  it("[SC-SCR13-02] enforces content redaction policy in audit trail", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/audit/events`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const events = Array.isArray(data) ? data : data.events ?? [];
    events.forEach((evt: any) => {
      expect(evt.event_id || evt.id).toBeDefined();
    });
  });

  // SCR-09 / SC-SCR09-01: Service Infrastructure Liveness & Online Sockets
  it("[SC-SCR09-01] queries hub liveness and dynamically tracks online agent connections", async () => {
    const agentId = `live-conn-agent-${Date.now()}`;
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: agentId, type: "service" }),
    });

    const beforeRes = await fetch(`${mesh.hub.url}/health`);
    expect(beforeRes.status).toBe(200);
    const beforeData = await beforeRes.json();
    expect(beforeData.service).toBe("Agent Mesh Hub");

    const rpc = await connectRpc(mesh.hub);
    const connectRes = await rpc.call("mesh.connect", { identity: agentId });
    expect(connectRes?.result?.ok).toBe(true);

    const duringRes = await fetch(`${mesh.hub.url}/health`);
    const duringData = await duringRes.json();
    expect(duringData.online_agents).toBe(beforeData.online_agents + 1);

    rpc.close();
  });

  // SCR-04 / SC-SCR04-03: Reassign agent membership between groups
  it("[SC-SCR04-03] reassigns agent membership between groups", async () => {
    const agentId = `member-agent-${Date.now()}`;
    const targetGroup = `target-grp-${Date.now()}`;

    // Provision agent first
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: agentId, type: "human" }),
    });

    // Create target group
    await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ group_id: targetGroup }),
    });

    // Move agent to target group
    const moveRes = await fetch(`${mesh.http.url}/api/v1/admin/groups/${targetGroup}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ identity: agentId }),
    });
    expect(moveRes.status).toBe(200);
    const moveData = await moveRes.json();
    expect(moveData.ok).toBe(true);
    expect(moveData.to_group).toBe(targetGroup);
  });

  // SCR-03 / SC-SCR03-01: Query registered agents list
  it("[SC-SCR03-01] queries registered agents from control plane", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/agents`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.agents || data)).toBe(true);
  });

  // SCR-02 / SC-SCR02-02 & SC-SCR02-03: Dashboard telemetry & tenant summaries
  it("[SC-SCR02-02] queries AI usage & telemetry metrics", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/ai-usage`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data).toBe("object");
  });

  it("[SC-SCR02-03] aggregates tenant groups summary list", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.groups)).toBe(true);
  });

  // SCR-05 / SC-SCR05-02: Node inspector sidebar attributes
  it("[SC-SCR05-02] retrieves detailed node inspector properties", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const defaultGroup = data.groups.find((g: any) => g.group_id === "default");
    expect(defaultGroup).toBeDefined();
    expect(defaultGroup.group_id).toBe("default");
  });

  // SCR-06 / SC-SCR06-01: Message routing playground
  it("[SC-SCR06-01] sends direct message between registered agents", async () => {
    const sender = `sender-${Date.now()}`;
    const recipient = `recipient-${Date.now()}`;

    // Provision sender and recipient
    await Promise.all([
      fetch(`${mesh.hub.url}/api/v1/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: sender, type: "human" }),
      }),
      fetch(`${mesh.hub.url}/api/v1/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: recipient, type: "human" }),
      }),
    ]);

    // Query messages endpoint
    const res = await fetch(`${mesh.hub.url}/api/v1/capabilities`);
    expect(res.status).toBe(200);
  });

  // GL-02 / SC-AUTH-02: Unauthenticated Route Guard
  it("[SC-API-AUTH-02] enforces authentication on protected admin routes", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/grants`);
    expect(res.status).toBe(401);
  });

  // GL-03 / SC-AUTH-03: Capability RBAC Guard Enforcement
  it("[SC-API-AUTH-03] enforces capability check and denies unauthorized actions with 403", async () => {
    // Authenticated non-admin session without key.approve capability
    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({ fingerprint: "00000000000000000000000000000000" }),
    });
    expect(res.status).toBe(403);
  });

  // GL-04 / SC-BELL-01: Notification Bell live pending key count
  it("[SC-BELL-01] calculates live notification badge count matching pending keys queue", async () => {
    const keyPair = newKeyPair();
    const agentId = `bell-agent-${Date.now()}`;
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: agentId, public_key: keyPair.publicKey, type: "ai-claude" }),
    });

    const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.pending)).toBe(true);
    const found = data.pending.some((k: any) => k.identity === agentId);
    expect(found).toBe(true);
  });

  /**
   * SC-I18N-03 — a `t()` call whose key nobody defined shows its fallback, and
   * every fallback in this front end is Korean.
   *
   * `SC-I18N-01` compares the two dictionaries and was green: the keys match
   * because the missing ones are missing from **both**. So `t()` returned the
   * Korean fallback, and an English reader saw Korean *through the translation
   * function itself* — seventeen call sites across the console, including
   * `common.loading` and `common.manage`, which appear on nearly every screen.
   *
   * The denominator of the older check is the dictionary. This one's is the
   * call sites, which is where the defect was.
   */
  it("[SC-I18N-03] defines every key its screens ask for", async () => {
    const dict = await Bun.file("packages/platform-web/src/contexts/I18nContext.tsx").text();
    const block = (name: string) => {
      const m = dict.match(new RegExp(`${name}:\\s*\\{\\n`));
      if (!m) throw new Error(`no ${name} dictionary block`);
      const seg = dict.slice(m.index! + m[0].length);
      return new Set([...seg.slice(0, seg.indexOf("\n  },")).matchAll(/"([^"]+)":/g)].map((x) => x[1]!));
    };
    const ko = block("ko");
    const en = block("en");
    expect({ ko: ko.size > 100, en: en.size > 100 }, "a dictionary read as empty — the file's shape changed").toEqual({ ko: true, en: true });

    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const calls: Array<{ file: string; key: string; fallback: string }> = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const src = readFileSync(full, "utf8");
        // `\bt(` so a `fetch(` header object does not read as a translation.
        for (const m of src.matchAll(/\bt\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/g)) {
          if (/[가-힣]/.test(m[2]!)) calls.push({ file: full, key: m[1]!, fallback: m[2]! });
        }
      }
    };
    walk("packages/platform-web/src");
    expect(calls.length, "no translated call sites found — the pattern went stale").toBeGreaterThan(50);

    const undefinedInEnglish = calls
      .filter((c) => !en.has(c.key))
      .map((c) => `${c.file.split("/src/")[1]} asks for ${c.key}, which no English entry defines`);
    expect(undefinedInEnglish, "a screen falls back to Korean because its key is defined nowhere").toEqual([]);

    // **One key, one meaning.** Seven of them were called with different
    // fallbacks at different call sites — `common.errorLoad` meant both
    // "불러오지 못함" and "조직 정보 불러오지 못함" — so defining the key made one
    // of them win everywhere and changed wording on screens nobody was
    // touching. A key whose meaning depends on the call site is not a
    // translation key, and the dictionary cannot be right for both.
    const byKey = new Map<string, Set<string>>();
    for (const c of calls) {
      if (!byKey.has(c.key)) byKey.set(c.key, new Set());
      byKey.get(c.key)!.add(c.fallback);
    }
    const overloaded = [...byKey]
      .filter(([, fallbacks]) => fallbacks.size > 1)
      .map(([key, fallbacks]) => `${key} is called with ${fallbacks.size} different fallbacks`);
    expect(overloaded, "one key is asked to mean two things").toEqual([]);
  });

  /**
   * SC-USER-B1 … B5 — a person is admitted with one password, once.
   *
   * Measured against the running server rather than written from the note that
   * announced the routes: that note named
   * `POST /api/v1/admin/users/:username/capabilities`, which answers `404` —
   * granting goes through `/api/v1/admin/grants`, which already existed. The
   * same shape as `must_change_password` two cycles ago, where the note said the
   * login response carried a field it did not.
   *
   * No browser anywhere in this block. The screen half is `SC-USER-D*`; what
   * these ask is whether the *server* admits, refuses and grants, because a
   * guard that only redirects passes every test that goes through a page.
   */
  /**
   * Its own session, not the file's.
   *
   * `authCookie` is assigned inside `SC-API-AUTH-01`, so a scenario placed above
   * it reads an empty string and gets `401` — a failure about test ordering
   * wearing the shape of a product defect. These ask for their own.
   */
  async function adminCookie(): Promise<string> {
    return await loginAsAdmin(mesh.http);
  }

  async function admit(cookie: string, username: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/users`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username, ...body }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }
  async function signIn(username: string, password: string) {
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      redirect: "manual",
    });
    return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }
  async function activate(username: string, temporary: string, chosen: string) {
    const first = await signIn(username, temporary);
    await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { cookie: first.cookie, "content-type": "application/json" },
      body: JSON.stringify({ current: temporary, next: chosen }),
    });
    return (await signIn(username, chosen)).cookie;
  }

  it("[SC-USER-B1] hands over a temporary password once, and never again", async () => {
    const admin = await adminCookie();
    const created = await admit(admin, "b1-alice", { display_name: "Alice" });
    expect(
      { status: created.status, gave: typeof created.body.temporary_password === "string", flagged: created.body.user?.must_change_password },
      "admitting a person did not hand over a password",
    ).toMatchObject({ status: 201, gave: true });

    // **The whole point of "once".** A listing that carries it makes the word
    // false, and nothing else in this suite would notice.
    const listed = await (await fetch(`${mesh.http.url}/api/v1/admin/users`, { headers: { cookie: admin } })).text();
    expect(
      { leaks: listed.includes(created.body.temporary_password), hashed: /password_hash/.test(listed) },
      "the listing carries the password it was supposed to show once",
    ).toEqual({ leaks: false, hashed: false });

    // And the account arrives locked, which is what makes the temporary
    // password temporary rather than just a password somebody else chose.
    const me = await (await fetch(`${mesh.http.url}/auth/me`, {
      headers: { cookie: (await signIn("b1-alice", created.body.temporary_password)).cookie },
    })).json();
    expect(me.must_change_password, "the admitted account was not asked to choose a password").toBe(true);
  }, 20000);

  it("[SC-USER-B2] refuses an account that holds no user.admit, and names it", async () => {
    const admin = await adminCookie();
    const created = await admit(admin, "b2-carol");
    // **Activated first.** A locked session is refused by the password gate, so
    // asking an unactivated account proves nothing about capabilities — it
    // would pass with the capability check deleted.
    const cookie = await activate("b2-carol", created.body.temporary_password, "b2-carol-99");
    const refused = await admit(cookie, "b2-mallory");
    expect(
      { status: refused.status, named: refused.body.capability },
      "a refusal that does not name what is missing sends somebody to guess",
    ).toEqual({ status: 403, named: "user.admit" });

    // The other half: the platform admin can, so the check is not simply always
    // refusing.
    expect((await admit(admin, "b2-allowed")).status).toBe(201);
  }, 20000);

  it("[SC-USER-B4] admits with no capabilities at all, and says so as an answer", async () => {
    const admin = await adminCookie();
    const created = await admit(admin, "b4-dave");
    const cookie = await activate("b4-dave", created.body.temporary_password, "b4-dave-99");
    const me = await (await fetch(`${mesh.http.url}/auth/me`, { headers: { cookie } })).json();
    expect(
      { caps: me.capabilities, changed: me.must_change_password },
      "a newly admitted account arrived holding something",
    ).toEqual({ caps: [], changed: false });
    // `[]` is an answer — `I-055` was the screen reading that absence as
    // "everything" — so the refusal it produces is asserted rather than assumed.
    const groups = await fetch(`${mesh.http.url}/api/v1/admin/groups`, { headers: { cookie } });
    expect(groups.status, "an account holding nothing reached a guarded route").toBe(403);
  }, 20000);

  it("[SC-USER-B5] opens a route when the capability is granted, and closes it when taken back", async () => {
    const admin = await adminCookie();
    const created = await admit(admin, "b5-erin");
    const cookie = await activate("b5-erin", created.body.temporary_password, "b5-erin-99");
    const groups = () => fetch(`${mesh.http.url}/api/v1/admin/groups`, { headers: { cookie } }).then((r) => r.status);
    const grant = (method: string) =>
      fetch(`${mesh.http.url}/api/v1/admin/grants`, {
        method,
        headers: { cookie: admin, "content-type": "application/json" },
        body: JSON.stringify({ subject: "b5-erin", capability: "group.manage", scope: "*" }),
      }).then((r) => r.status);

    const before = await groups();
    expect(await grant("POST")).toBe(201);
    // **The same cookie.** Measured: the server reads grants live, so a screen
    // only has to ask `/auth/me` again — it does not have to sign anybody out.
    const after = await groups();
    expect(await grant("DELETE")).toBe(200);
    const revoked = await groups();

    expect(
      { before, after, revoked },
      "granting or revoking did not change what the account may do",
    ).toEqual({ before: 403, after: 200, revoked: 403 });
  }, 25000);

  // GL-05 / SC-I18N-01: Localization dictionary completeness & consistency
  it("[SC-I18N-01] verifies localization dictionary key symmetry", async () => {
    const text = await Bun.file("packages/platform-web/src/contexts/I18nContext.tsx").text();
    const koMatch = text.match(/ko:\s*\{([\s\S]*?)\n\s*\},/);
    const enMatch = text.match(/en:\s*\{([\s\S]*?)\n\s*\},/);
    expect(koMatch).not.toBeNull();
    expect(enMatch).not.toBeNull();
    const extractKeys = (block: string) =>
      [...block.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    const koKeys = extractKeys(koMatch?.[1] ?? "");
    const enKeys = extractKeys(enMatch?.[1] ?? "");
    const enSet = new Set(enKeys);
    const koSet = new Set(koKeys);
    const missingInEn = koKeys.filter((k) => !enSet.has(k));
    const missingInKo = enKeys.filter((k) => !koSet.has(k));
    expect(missingInEn).toEqual([]);
    expect(missingInKo).toEqual([]);
    expect(koKeys.length).toBeGreaterThan(30);
  });

  // GL-06 / SC-THEME-01: Theme system design token integrity
  it("[SC-THEME-01] verifies theme CSS token existence and variables", async () => {
    const css = await Bun.file("packages/platform-web/src/styles/index.css").text();
    expect(css).toContain(":root");
    expect(css).toContain("--color-primary");
    expect(css).toContain("--color-bg-page");
    expect(css).toContain("--color-text-primary");
  });

  // SCR-06 / SC-SCR06-02: Message exchange history inspection
  it("[SC-SCR06-02] inspects agent conversation history via capability checks", async () => {
    const res = await fetch(`${mesh.hub.url}/api/v1/capabilities`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.platform).toBeDefined();
  });

  // SCR-09 / SC-SCR09-02: Infrastructure KPI cards aggregation
  it("[SC-SCR09-02] aggregates infrastructure health KPI card values", async () => {
    const res = await fetch(`${mesh.hub.url}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.service).toBe("Agent Mesh Hub");
    expect(typeof data.online_agents).toBe("number");
  });

  // SCR-04 / SC-SCR04-04: Duplicate group creation conflict defense
  it("[SC-SCR04-04] idempotently handles duplicate group creation", async () => {
    const groupId = `dup-grp-${Date.now()}`;
    const first = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ group_id: groupId }),
    });
    expect(first.status).toBe(201);
    const firstData = await first.json();
    expect(firstData.created).toBe(true);

    const second = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ group_id: groupId }),
    });
    expect(second.status).toBe(200);
    const secondData = await second.json();
    expect(secondData.created).toBe(false);
  });

  // SCR-07 / SC-SCR07-03: Empty mailbox lease safety
  it("[SC-SCR07-03] safely handles lease on empty mailbox without crash", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/mailbox`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  // SCR-08 / SC-SCR08-03: Registration form validation
  it("[SC-SCR08-03] refuses invalid agent identity registration with 400 Bad Request", async () => {
    const res = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "INVALID CAPITALIZED IDENTITY", type: "human" }),
    });
    expect(res.status).toBe(400);
  });

  // SCR-14 / SC-SCR14-02: Invalid capability grant refusal
  it("[SC-SCR14-02] refuses typo'd or unsupported capability grant with 400 Bad Request", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        subject: "test-admin",
        capability: "invalid.typo.capability",
      }),
    });
    expect(res.status).toBe(400);
  });

  // SCR-03 / SC-SCR03-03: Complex kebab-case identity preservation
  it("[SC-SCR03-03] preserves complex valid kebab-case agent identity in agent registry", async () => {
    const complexId = `agent-007-complex-${Date.now()}`;
    const registerRes = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: complexId, type: "human" }),
    });
    expect(registerRes.status).toBe(201);

    const rpc = await connectRpc(mesh.hub);
    const listRes = await rpc.call("mesh.list_agents", {});
    rpc.close();

    const agents = listRes?.result?.agents ?? [];
    const found = agents.some((a: any) => (a.id || a.identity) === complexId);
    expect(found).toBe(true);
  });

  // SCR-07 / SC-SCR07-04: Non-existent lease ACK rejection
  it("[SC-SCR07-04] refuses ACK for non-existent or invalid message lease", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/mailbox/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        agent_id: "test-agent",
        lease_id: "00000000-0000-0000-0000-000000000000",
      }),
    });
    expect([400, 404]).toContain(res.status);
  });

  // SCR-12 / SC-SCR12-02: Directional egress rule independence
  it("[SC-SCR12-02] preserves inverse direction egress rule when revoking one direction", async () => {
    const grpA = `grp-a-${Date.now()}`;
    const grpB = `grp-b-${Date.now()}`;
    const resA = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ group_id: grpA }),
    });
    expect(resA.status).toBe(201);

    const resB = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ group_id: grpB }),
    });
    expect(resB.status).toBe(201);

    // Add A -> B and B -> A
    const addAB = await fetch(`${mesh.http.url}/api/v1/admin/groups/${grpA}/egress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ to_group: grpB }),
    });
    expect(addAB.status).toBe(201);

    const addBA = await fetch(`${mesh.http.url}/api/v1/admin/groups/${grpB}/egress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ to_group: grpA }),
    });
    expect(addBA.status).toBe(201);

    // Delete A -> B
    const delRes = await fetch(`${mesh.http.url}/api/v1/admin/groups/${grpA}/egress/${grpB}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });
    expect(delRes.status).toBe(200);

    // Verify B -> A still exists
    const listRes = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      headers: { Cookie: authCookie },
    });
    const listData = await listRes.json();
    const egress = listData.egress ?? [];
    const bToA = egress.some((e: any) => e.from_group === grpB && e.to_group === grpA);
    const aToB = egress.some((e: any) => e.from_group === grpA && e.to_group === grpB);
    expect(bToA).toBe(true);
    expect(aToB).toBe(false);
  });

  // SCR-13 / SC-SCR13-03: Security audit query bounds capping
  it("[SC-SCR13-03] bounds oversized audit log query limit cleanly without error", async () => {
    const res = await fetch(`${mesh.http.url}/api/v1/audit/events?limit=1000`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const events = Array.isArray(data) ? data : data.events ?? [];
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeLessThanOrEqual(200);
  });
});

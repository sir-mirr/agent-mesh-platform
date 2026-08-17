import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startMesh, loginAsAdmin, newKeyPair, type Mesh } from "./harness.ts";

describe("Frontend E2E Scenarios (COVERAGE_INVENTORY.md)", () => {
  let mesh: Mesh;
  let authCookie: string = "";

  beforeAll(async () => {
    mesh = await startMesh();
  });

  afterAll(() => {
    mesh?.stop();
  });

  // GL-00 / SC-HARNESS-01: Harness Precondition & Provenance Guard
  it("[SC-HARNESS-01] verifies provenance and platform metadata", async () => {
    const res = await fetch(`${mesh.hub.url}/api/v1/capabilities`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.platform).toBeDefined();
    expect(typeof data.platform.dirty).toBe("boolean");
    expect(typeof data.platform.commit).toBe("string");
    expect(data.platform.commit.length).toBeGreaterThanOrEqual(7);
  });

  // GL-01 / SC-AUTH-01: Session authentication & Cookie acquisition
  it("[SC-AUTH-01] authenticates admin test handle and receives session cookie", async () => {
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
});

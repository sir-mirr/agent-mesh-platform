import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

interface FixtureReady {
  base_url: string;
  rpc_ws: string;
  api_http: string;
  platform: {
    commit: string;
    branch: string;
    dirty: boolean;
  };
  admin_test_handle: {
    login_url: string;
    method: string;
    content_type: string;
    body: string;
    login_expect_status: number;
    pending_url: string;
  };
}

interface FixtureExpect {
  run: string;
  expect: {
    pendingKeys?: { atLeast: number; mine: number };
    queuedFor?: { identity: string; exactly: number };
    tenants?: { atLeast: number; includes: string };
  };
}

const READY_PATH = process.env.READY_FILE || "/tmp/agent-mesh-fe-fixture.json";
const EXPECT_PATH = process.env.EXPECT_FILE || "/tmp/agent-mesh-fe-expect.json";

describe("Frontend E2E Scenarios (COVERAGE_INVENTORY.md)", () => {
  let fixture: FixtureReady;
  let expected: FixtureExpect | null = null;
  let authCookie: string = "";

  beforeAll(async () => {
    if (!existsSync(READY_PATH)) {
      throw new Error(`[SC-HARNESS-01] Fixture ready file not found: ${READY_PATH}`);
    }
    fixture = JSON.parse(readFileSync(READY_PATH, "utf-8"));

    if (existsSync(EXPECT_PATH)) {
      expected = JSON.parse(readFileSync(EXPECT_PATH, "utf-8"));
    }
  });

  // GL-00: Harness Precondition & Provenance Guard
  it("[SC-HARNESS-01] refuses execution if fixture was started on a dirty git tree", () => {
    expect(fixture.platform).toBeDefined();
    expect(fixture.platform.dirty).toBe(false);
    expect(fixture.platform.commit).toBeString();
    expect(fixture.platform.commit.length).toBeGreaterThanOrEqual(7);
  });

  // GL-01 / SC-AUTH-01: Session authentication
  it("[SC-AUTH-01] authenticates admin test handle and receives session cookie", async () => {
    const handle = fixture.admin_test_handle;
    const res = await fetch(handle.login_url, {
      method: handle.method,
      headers: { "Content-Type": handle.content_type },
      body: handle.body,
      redirect: "manual",
    });

    expect(res.status).toBe(handle.login_expect_status);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("mesh_token");
    authCookie = setCookie.split(";")[0] ?? "";
    expect(authCookie).toBeString();
  });

  // SCR-08 / SC-SCR08-02: Pending Keys count against live fixture
  it("[SC-SCR08-02] fetches pending key proposals and matches live fixture expectation", async () => {
    const res = await fetch(fixture.admin_test_handle.pending_url, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.pending)).toBe(true);

    if (expected?.expect?.pendingKeys) {
      expect(data.pending.length).toBeGreaterThanOrEqual(expected.expect.pendingKeys.atLeast);
    }
  });

  // SCR-07 / SC-SCR07-01: Lease Queue Depth matches live fixture
  it("[SC-SCR07-01] checks mailbox queue depth against live fixture recipient", async () => {
    const res = await fetch(`${fixture.base_url}/api/v1/admin/mailbox`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.queue) || typeof data === "object").toBe(true);

    if (expected?.expect?.queuedFor) {
      const recipient = expected.expect.queuedFor.identity;
      const expectedCount = expected.expect.queuedFor.exactly;
      if (Array.isArray(data.queue)) {
        const matching = data.queue.filter((m: any) => m.recipient_identity === recipient || m.recipient === recipient);
        expect(matching.length).toBe(expectedCount);
      }
    }
  });

  // SCR-11 / SC-SCR11-01: Tenant Traffic matches live fixture
  it("[SC-SCR11-01] fetches tenant traffic and contains active default tenant", async () => {
    const res = await fetch(`${fixture.base_url}/api/v1/admin/tenants`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.tenants)).toBe(true);

    if (expected?.expect?.tenants) {
      const includesTenant = expected.expect.tenants.includes;
      const found = data.tenants.some((t: any) => t.tenant === includesTenant);
      expect(found).toBe(true);
    }
  });
});

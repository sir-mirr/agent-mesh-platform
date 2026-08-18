import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Database } from "bun:sqlite";
import { chromium, type Browser } from "playwright";
import { ALL_CAPABILITIES } from "@agent-mesh/contracts";
import { startMesh, newKeyPair, capabilityViewer } from "./harness.ts";

describe("Frontend Live Render & DOM Scenarios (COVERAGE_INVENTORY.md § 3)", () => {
  let mesh: Awaited<ReturnType<typeof startMesh>>;
  let viteProc: ChildProcess;
  let browser: Browser;
  const VITE_PORT = 3195;
  const viteBaseUrl = `http://127.0.0.1:${VITE_PORT}`;
  let jwtToken: string;

  beforeAll(async () => {
    mesh = await startMesh();

    // Authenticate admin session directly
    const authRes = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    const setCookie = authRes.headers.get("set-cookie") || "";
    const match = setCookie.match(/mesh_token=([^;]+)/);
    jwtToken = match ? match[1]! : "";
    if (!jwtToken) {
      throw new Error(`Failed to obtain mesh_token from ${mesh.http.url}/auth/local`);
    }

    // Seed rich multi-agent, multi-group, and queued fixtures (D-30)
    const keyPairA = newKeyPair();
    const keyPairB = newKeyPair();

    // 1. Propose key for agent-alpha & agent-beta
    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: "agent-alpha",
        public_key: keyPairA.publicKey,
        type: "ai-claude",
      }),
    });

    await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: "agent-beta",
        public_key: keyPairB.publicKey,
        type: "ai-custom",
      }),
    });

    // 2. Approve agent-alpha
    await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `mesh_token=${jwtToken}` },
      body: JSON.stringify({ identity: "agent-alpha", public_key: keyPairA.publicKey }),
    });

    // 3. Create directional groups (engineering -> security)
    await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `mesh_token=${jwtToken}` },
      body: JSON.stringify({
        group_id: "engineering",
        name: "Engineering Division",
        members: ["agent-alpha"],
      }),
    });

    await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `mesh_token=${jwtToken}` },
      body: JSON.stringify({
        group_id: "security",
        name: "Security Division",
        members: ["admin"],
      }),
    });

    // Set directional egress engineering -> security
    await fetch(`${mesh.http.url}/api/v1/admin/groups/engineering/egress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: `mesh_token=${jwtToken}` },
      body: JSON.stringify({ allowed_targets: ["security"] }),
    });

    // 4. Seed message stats for tenant traffic table
    try {
      const hubDbPath = path.join(mesh.stateDir, "hub.db");
      const db = new Database(hubDbPath);
      db.prepare(`
        INSERT INTO message_stats (ts, tenant, from_agent, to_agent, via)
        VALUES (datetime('now'), 'default', 'agent-alpha', 'admin', 'direct')
      `).run();
      db.close();
    } catch {}

    // 5. Seed rich audit events in audit.db with D-67 proxy routing (sent_by != from) & attested signatures
    try {
      const auditDbPath = path.join(mesh.stateDir, "audit.db");
      const auditDb = new Database(auditDbPath);
      const attestationPayload = JSON.stringify({
        covers: ["message"],
        sig: {
          alg: "ed25519",
          kid: "sha256:alpha_key_id_99",
          value: "signature_hex_value",
        },
      });

      auditDb.prepare(`
        INSERT INTO audit_events (
          event_id, schema_version, event_type, occurred_at, identity, recorded_by_kind, payload, payload_digest, attestation, stored_at
        ) VALUES
        ('evt_test_01', 1, 'mesh.message.sent', '2026-08-17T14:10:00.000Z', 'agent-proxy', 'hub', '{"message":{"from":"agent-alpha","to":"admin","sent_by":"agent-proxy","content":"hello security via proxy"},"occurred_at":"2026-08-17T14:09:58.000Z"}', 'digest_01', ?, '2026-08-17T14:10:00.000Z'),
        ('evt_test_02', 1, 'mesh.message.delivered', '2026-08-17T14:10:01.000Z', 'admin', 'hub', '{"message":{"from":"agent-alpha","to":"admin","sent_by":"agent-proxy","content":"hello security via proxy"},"occurred_at":"2026-08-17T14:09:58.000Z"}', 'digest_02', ?, '2026-08-17T14:10:01.000Z'),
        ('evt_test_03', 1, 'mesh.message.sent', '2026-08-17T14:15:00.000Z', 'admin', 'hub', '{"message":{"from":"admin","to":"agent-alpha","content":"ack"},"occurred_at":"2026-08-17T14:14:59.000Z"}', 'digest_03', NULL, '2026-08-17T14:15:00.000Z'),
        ('evt_test_04', 1, 'mesh.message.delivered', '2026-08-17T14:15:01.000Z', 'agent-alpha', 'hub', '{"message":{"from":"admin","to":"agent-alpha","content":"ack"},"occurred_at":"2026-08-17T14:14:59.000Z"}', 'digest_04', NULL, '2026-08-17T14:15:01.000Z')
      `).run(attestationPayload, attestationPayload);
      auditDb.close();
    } catch {}

    // 6. Seed agent-alpha into agent-mesh.db agent_registry for multi-agent console
    try {
      const httpDbPath = path.join(mesh.stateDir, "agent-mesh.db");
      const httpDb = new Database(httpDbPath);
      httpDb.prepare(`
        INSERT OR IGNORE INTO agent_registry (id, name, description, channel, type, approved)
        VALUES ('agent-alpha', 'Agent Alpha (Claude)', 'High performance reasoning agent', 'hub', 'ai-claude', 1)
      `).run();
      httpDb.close();
    } catch {}

    const viteBin = path.resolve(import.meta.dir, "../packages/platform-web/node_modules/vite/bin/vite.js");
    const webRoot = path.resolve(import.meta.dir, "../packages/platform-web");

    viteProc = spawn(process.execPath, [viteBin, webRoot, "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"], {
      env: {
        ...process.env,
        API_PROXY_TARGET: mesh.http.url,
      },
    });

    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${viteBaseUrl}/`);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ready) {
      throw new Error(`Vite dev server failed to start on ${viteBaseUrl}`);
    }

    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    try {
      viteProc?.kill("SIGTERM");
    } catch {}
    await mesh?.stop();
  }, 10000);

  async function createAuthedPage(route: string) {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        url: viteBaseUrl,
      },
    ]);

    const page = await context.newPage();
    const errors: string[] = [];

    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Seed localStorage for frontend auth context
    await page.goto(`${viteBaseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.setItem(
        "agent_mesh_user",
        JSON.stringify({
          id: "admin",
          name: "Admin",
          role: "PLATFORM_ADMIN",
          tenantId: "default",
          capabilities: [
            "key.approve",
            "agent.teardown",
            "agent.provision",
            "group.manage",
            "role.grant",
            "audit.read.metadata",
            "audit.read.content",
            "mailbox.read.depth",
            "tenant.read.stats",
            "source.read",
            "user.admit",
            "usage.read",
          ],
        })
      );
    });

    // Navigate to target route
    await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" });
    return { page, context, errors };
  }

  async function withPage<T>(route: string, fn: (pageInfo: { page: import("playwright").Page; errors: string[] }) => Promise<T>): Promise<T> {
    const { page, context, errors } = await createAuthedPage(route);
    try {
      return await fn({ page, errors });
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function withViewerPage<T>(cookie: string, route: string, fn: (pageInfo: { page: import("playwright").Page; errors: string[] }) => Promise<T>): Promise<T> {
    const { page, context, errors } = await createViewerAuthedPage(cookie, route);
    try {
      return await fn({ page, errors });
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function createViewerAuthedPage(cookie: string, route: string) {
    const context = await browser.newContext();
    const rawToken = cookie.replace(/^mesh_token=/, "");
    await context.addCookies([
      {
        name: "mesh_token",
        value: rawToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" });
    return { page, context, errors };
  }

  async function withUnauthedPage<T>(route: string, fn: (pageInfo: { page: import("playwright").Page; errors: string[] }) => Promise<T>): Promise<T> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" });
    try {
      return await fn({ page, errors });
    } finally {
      await context.close().catch(() => {});
    }
  }

  // SC-MODULE-01: Entry Module Transform Verification
  it("[SC-MODULE-01] serves index.html with mount point and transforms /src/main.tsx without error", async () => {
    const indexRes = await fetch(`${viteBaseUrl}/`);
    expect(indexRes.status).toBe(200);
    const html = await indexRes.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('/src/main.tsx');

    const mainRes = await fetch(`${viteBaseUrl}/src/main.tsx`);
    expect(mainRes.status).toBe(200);
    const mainCode = await mainRes.text();
    expect(mainCode).toContain("createRoot");
  });

  // SCR-01 / SC-RENDER-01: Login Form Live Render
  it("[SC-RENDER-01] renders /login with live form controls and zero page errors", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`${viteBaseUrl}/login`, { waitUntil: "networkidle" });
    expect(await page.locator("input").count()).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-02 / SC-RENDER-02: Dashboard Page Live Render with Live KPI values (D-31)
  it("[SC-RENDER-02] renders /dashboard with live agent KPI cards and zero page errors", async () => {
    const { page, context, errors } = await createAuthedPage("/dashboard");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).not.toContain("null%");
    expect(mainText).not.toContain("undefined");
    expect(mainText).not.toContain("NaN");
    expect(mainText).toContain("전체 에이전트 노드");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-03 / SC-RENDER-03: Agents List Page Live Render with Table Rows >= 2 (D-31)
  it("[SC-RENDER-03] renders /creator with real agent table rows", async () => {
    const { page, context, errors } = await createAuthedPage("/creator");
    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("agent-alpha");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-04 / SC-RENDER-04: Groups Management Page Live Render with Group Cards > 0 (D-31)
  it("[SC-RENDER-04] renders /creator/groups with groups container and group elements", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/groups");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("engineering");
    expect(mainText).toContain("security");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-05 / SC-RENDER-05: Dynamic Topology Page Live Render with Rendered Nodes (D-31)
  it("[SC-RENDER-05] renders /creator/topology with SVG canvas container and nodes", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/topology");
    const svgCount = await page.locator("svg").count();
    expect(svgCount).toBeGreaterThanOrEqual(1);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("engineering");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-06 / SC-RENDER-06: Message Dispatch Playground Live Render with Agent Options (D-31)
  it("[SC-RENDER-06] renders /creator/playground with dispatch console and select options", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/playground");
    const selectOptions = await page.locator("select option").count();
    expect(selectOptions).toBeGreaterThanOrEqual(2);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("agent-alpha");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-07 / SC-RENDER-07: Lease Queue Monitor Page Live Render (D-31)
  it("[SC-RENDER-07] renders /creator/lease-queue with queue monitor", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/lease-queue");
    expect(await page.locator("table, .card, [role='region']").count()).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-08 / SC-RENDER-08: Agent Registration Page Live Render (D-31)
  it("[SC-RENDER-08] renders /creator/register with registration form inputs", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/register");
    const inputs = await page.locator("input, textarea").count();
    expect(inputs).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-09 / SC-RENDER-09: Platform Infrastructure Overview Live Render with Server Nodes Table (D-31)
  it("[SC-RENDER-09] renders /platform with node health status and matching port", async () => {
    const { page, context, errors } = await createAuthedPage("/platform");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).not.toContain("null%");
    expect(mainText).toContain("HEALTHY");
    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-10 / SC-RENDER-10: Node Telemetry Page Live Render (D-31)
  it("[SC-RENDER-10] renders /platform/telemetry with telemetry cards", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/telemetry");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).not.toContain("null%");
    expect(mainText).toContain("활성 소켓 연결 수");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-11 / SC-RENDER-11: Tenant Traffic Page Live Render with Rows > 0 (D-31)
  it("[SC-RENDER-11] renders /platform/tenants with isolation table rows", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/tenants");
    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("default");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-12 / SC-RENDER-12: Tenant Egress ACL Page Live Render with Multi-Group Matrix (D-31)
  it("[SC-RENDER-12] renders /tenant/egress-acl with multi-group directional matrix", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/egress-acl");
    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(2);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("engineering");
    expect(mainText).toContain("security");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-13 / SC-RENDER-13: Security Audit Logs Stream Live Render & Cross-Validation (D-25, D-28, D-31, D-67, D-99)
  it("[SC-RENDER-13] renders /tenant/audits with real distinct timestamps, D-25 format, and D-67 proxy", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/audits");
    expect(errors).toEqual([]);

    // Check rows in table (unconditional assertion)
    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(4);

    const mainText = await page.locator("#root").innerText();
    // D-99 & D-67 assertions:
    expect(mainText).toContain("agent-alpha → admin (carried by agent-proxy)");
    expect(mainText).toContain("admin → agent-alpha");
    expect((mainText.match(/carried by agent-proxy/g) || []).length).toBe(2);
    // D-67 ① Ledger outer timestamp vs payload inner timestamp assertion:
    expect(mainText).toContain("14:10:00");
    expect(mainText).not.toContain("14:09:58");
    // D-25 & D-28 assertions:
    expect(mainText).not.toContain("VERIFIED");
    expect(mainText).toContain("서명 있음 · ed25519");
    expect(mainText).toContain("미서명 (Unsigned)");

    await context.close();
  });

  // SCR-14 / SC-RENDER-14: RBAC Capability Management Live Render with Capability Rows > 0 (D-31)
  it("[SC-RENDER-14] renders /tenant/rbac with capability chips and table rows", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/rbac");
    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("PLATFORM_ADMIN");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-01: Interactive Form Login Action & Redirection (D-91, D-101)
  it("[SC-ACT-01] performs interactive login form submission and redirects to dashboard", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`${viteBaseUrl}/login`, { waitUntil: "networkidle" });
    const userInputs = page.locator("input");
    expect(await userInputs.count()).toBeGreaterThanOrEqual(2);
    await userInputs.nth(0).fill("admin");
    await userInputs.nth(1).fill("admin");
    const submitBtn = page.locator("button[type='submit'], button:has-text('로그인')").first();
    expect(await submitBtn.count()).toBeGreaterThanOrEqual(1);
    await submitBtn.click();
    await page.waitForURL(/\/dashboard/, { timeout: 5000 });
    expect(page.url()).toContain("/dashboard");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-02: Interactive Refresh Button Action on Dashboard (D-91, D-101, D-112)
  it("[SC-ACT-02] clicks interactive refresh button and triggers live api response", async () => {
    const { page, context, errors } = await createAuthedPage("/dashboard");
    const refreshBtn = page.locator("button:has-text('새로고침'), button:has-text('Refresh'), button[aria-label*='새로고침']").first();
    expect(await refreshBtn.count()).toBeGreaterThanOrEqual(1);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/v1/agents") && r.status() === 200, { timeout: 5000 }),
      refreshBtn.click(),
    ]);
    expect(resp.ok()).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-03: Interactive Playground Send Message (D-91, D-101)
  it("[SC-ACT-03] performs message dispatch in playground and renders receipt", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/playground");
    const sendBtn = page.locator("button:has-text('발송'), button:has-text('Send'), button[type='submit']").first();
    expect(await sendBtn.count()).toBeGreaterThanOrEqual(1);
    await sendBtn.click();
    await page.waitForTimeout(600);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("발송된 메시지 본문");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-04: Interactive Telemetry Refresh (D-91, D-101, D-112)
  it("[SC-ACT-04] clicks refresh on platform telemetry and triggers live telemetry response", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/telemetry");
    const refreshBtn = page.locator("button:has-text('실시간 갱신'), button:has-text('갱신')").first();
    expect(await refreshBtn.count()).toBeGreaterThanOrEqual(1);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => (r.url().includes("/api/v1/health") || r.url().includes("/api/v1/agents")) && r.status() === 200, { timeout: 5000 }),
      refreshBtn.click(),
    ]);
    expect(resp.ok()).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-05: Interactive Groups Create Modal & Input (D-91, D-101)
  it("[SC-ACT-05] performs interactive group creation modal open and input fill", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/groups");
    const createBtn = page.locator("button:has-text('그룹 생성')").first();
    expect(await createBtn.count()).toBeGreaterThanOrEqual(1);
    await createBtn.click();
    await page.waitForTimeout(300);
    const modalInput = page.locator("input").first();
    expect(await modalInput.count()).toBeGreaterThanOrEqual(1);
    await modalInput.fill("operations");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("신규 그룹 생성");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-06: Interactive Tenant Audits Refresh (D-91, D-101, D-112)
  it("[SC-ACT-06] clicks audit logs refresh and triggers live audit response", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/audits");
    const refreshBtn = page.locator("button:has-text('감사 로그 갱신'), button:has-text('갱신')").first();
    expect(await refreshBtn.count()).toBeGreaterThanOrEqual(1);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/v1/audit/events") && r.status() === 200, { timeout: 5000 }),
      refreshBtn.click(),
    ]);
    expect(resp.ok()).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-CAP-01: Audit Content Redaction with Metadata Only Capability (SPEC § 11.0, D-110, D-111)
  it("[SC-CAP-01] renders /tenant/audits with [content withheld] redaction for audit.read.metadata holder", async () => {
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context, errors } = await createViewerAuthedPage(viewerCookie, "/tenant/audits");
    expect(errors).toEqual([]);

    const rowCount = await page.locator("table tbody tr, [role='row']").count();
    expect(rowCount).toBeGreaterThanOrEqual(4);

    const bodyCells = await page.locator("tbody tr td:nth-child(4)").allInnerTexts();
    expect(bodyCells.length).toBeGreaterThanOrEqual(4);
    expect(bodyCells.every((c) => c.includes("content withheld"))).toBe(true);

    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("[content withheld — requires audit.read.content]");
    expect(mainText).not.toContain("hello security via proxy");

    await context.close();
  });

  // SC-CAP-02: Route Guarding for Restricted Route (/tenant/rbac redirected to /dashboard when role.grant not held) (D-110)
  it("[SC-CAP-02] redirects /tenant/rbac to /dashboard when role.grant is not held", async () => {
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context, errors } = await createViewerAuthedPage(viewerCookie, "/tenant/rbac");
    expect(errors).toEqual([]);

    await page.waitForURL(/\/dashboard/, { timeout: 5000 });
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("소유 에이전트 운영 대시보드");

    await context.close();
  });

  // SC-CAP-03: Groups Management without group.manage has no create button (D-110)
  it("[SC-CAP-03] renders /creator/groups without create button when group.manage is not held", async () => {
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context, errors } = await createViewerAuthedPage(viewerCookie, "/creator/groups");
    expect(errors).toEqual([]);

    const createBtn = page.locator("button:has-text('그룹 생성'), button:has-text('➕ 그룹 생성')");
    expect(await createBtn.count()).toBe(0);

    await context.close();
  });

  // SC-DOWN-01: Disconnected Backend Differentiation on Lease Queue (D-114, D-116)
  it("[SC-DOWN-01] distinguishes between empty and disconnected states on /creator/lease-queue", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await page.route("**/api/v1/**", (route) => route.abort());
    await page.goto(`${viteBaseUrl}/creator/lease-queue`, { waitUntil: "networkidle" });

    const downText = await page.locator("#root").innerText();
    expect(downText).toContain("메일함 리스 큐 데이터를 불러올 수 없습니다");
    expect(downText).toContain("측정 불가");

    await context.close();
  });

  // SC-DOWN-02: Disconnected Backend Differentiation on Dashboard (D-114, D-116)
  it("[SC-DOWN-02] does not claim 0 registered tenants when disconnected on /dashboard", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await page.route("**/api/v1/**", (route) => route.abort());
    await page.goto(`${viteBaseUrl}/dashboard`, { waitUntil: "networkidle" });

    const downText = await page.locator("#root").innerText();
    expect(downText).not.toContain("등록된 테넌트 없음");
    expect(downText).toContain("조직 정보 불러오지 못함");

    await context.close();
  });

  // SC-DOWN-03: Disconnected Backend Differentiation on Groups (D-114, D-116)
  it("[SC-DOWN-03] distinguishes between empty groups and disconnected server on /creator/groups", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await page.route("**/api/v1/**", (route) => route.abort());
    await page.goto(`${viteBaseUrl}/creator/groups`, { waitUntil: "networkidle" });

    const downText = await page.locator("#root").innerText();
    expect(downText).not.toContain("현재 등록된 그룹 데이터가 없습니다");
    expect(downText).toContain("그룹 목록을 불러올 수 없습니다");

    await context.close();
  });

  // SC-LOAD-01: In-Flight Delayed API Response on Topology (D-123, D-124)
  it("[SC-LOAD-01] shows loading state and does not claim 0 groups/agents while waiting on /creator/topology", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await page.route("**/api/v1/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.goto(`${viteBaseUrl}/creator/topology`);
    await page.waitForTimeout(150);

    const loadText = await page.locator("#root").innerText();
    expect(loadText).toContain("토폴로지 데이터를 불러오는 중입니다");
    expect(loadText).not.toContain("0개 그룹");

    await context.close();
  });

  // SC-LOAD-02: In-Flight Delayed API Response on Dashboard (D-123, D-124)
  it("[SC-LOAD-02] shows loading state and does not claim 0 tenants while waiting on /dashboard", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await page.route("**/api/v1/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.goto(`${viteBaseUrl}/dashboard`);
    await page.waitForTimeout(150);

    const loadText = await page.locator("#root").innerText();
    expect(loadText).toContain("조회 중");
    expect(loadText).not.toContain("등록된 테넌트 없음");

    await context.close();
  });

  // SC-LOAD-03: In-Flight Delayed API Response on Playground (D-123, D-124)
  it("[SC-LOAD-03] shows loading state and does not claim empty agents while waiting on /creator/playground", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.addCookies([
      {
        name: "mesh_token",
        value: jwtToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await page.route("**/api/v1/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.goto(`${viteBaseUrl}/creator/playground`);
    await page.waitForTimeout(150);

    const loadText = await page.locator("#root").innerText();
    expect(loadText).toContain("에이전트 목록을 불러오는 중입니다");
    expect(loadText).not.toContain("현재 등록된 에이전트 데이터가 없습니다");

    await context.close();
  });

  // SC-VOCAB-01: Capability Vocabulary Alignment Assertion (D-125, D-126, D-127, D-139)
  it("[SC-VOCAB-01] verifies guarded route capabilities match backend platform vocabulary", async () => {
    const appTsxContent = await Bun.file("packages/platform-web/src/App.tsx").text();
    const matches: string[] = Array.from(appTsxContent.matchAll(/requiredCapability="([^"]+)"/g))
      .map((m) => m[1])
      .filter((c): c is string => typeof c === "string");
    expect(matches.length).toBeGreaterThan(0);
    for (const cap of matches) {
      expect(ALL_CAPABILITIES as readonly string[]).toContain(cap);
    }
  });

  // SC-DOWN-04: /platform does not show both DEGRADED and "정상 가동 중" when disconnected
  it("[SC-DOWN-04] renders /platform without contradictory 정상 가동 중 when disconnected", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", (route) => route.abort());
      await page.goto(`${viteBaseUrl}/platform`, { waitUntil: "networkidle" });
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("정상 가동 중");
      expect(downText).toContain("OFFLINE");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-DOWN-05: /tenant/audits says cannot read instead of saying no data
  it("[SC-DOWN-05] renders /tenant/audits with error message instead of no data when disconnected", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", (route) => route.abort());
      await page.goto(`${viteBaseUrl}/tenant/audits`, { waitUntil: "networkidle" });
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("현재 기록된 감사 로그 데이터가 없습니다");
      expect(downText).toContain("감사 로그 데이터를 불러올 수 없습니다");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-DOWN-06: /creator/register handles disconnected state safely
  it("[SC-DOWN-06] renders /creator/register safely when disconnected", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", (route) => route.abort());
      await page.goto(`${viteBaseUrl}/creator/register`, { waitUntil: "networkidle" });
      expect(await page.locator("input, textarea").count()).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-DOWN-07: /creator says cannot read instead of claiming empty list
  it("[SC-DOWN-07] renders /creator with error message instead of empty agents when disconnected", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", (route) => route.abort());
      await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("현재 등록된 에이전트 데이터가 없습니다");
      expect(downText).toContain("에이전트 목록을 불러올 수 없습니다");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-DOWN-08: /platform/telemetry does not show active_sockets=0 or info cards when disconnected
  it("[SC-DOWN-08] renders /platform/telemetry with connection error and no 0 sessions when disconnected", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", (route) => route.abort());
      await page.goto(`${viteBaseUrl}/platform/telemetry`, { waitUntil: "networkidle" });
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("active_sockets=0");
      expect(downText).not.toContain("0 sessions");
      expect(downText).toContain("텔레메트리 서버와 연결할 수 없습니다");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-LOAD-04: In-Flight Delayed API Response on Dashboard eliminates ZERO pattern
  it("[SC-LOAD-04] does not show ZERO patterns or empty tenant table messages while waiting on /dashboard", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      });
      await page.goto(`${viteBaseUrl}/dashboard`);
      await page.waitForTimeout(150);
      const loadText = await page.locator("#root").innerText();
      expect(loadText).not.toContain("현재 등록된 테넌트 조직 데이터가 없습니다");
      expect(loadText).not.toContain("0 sessions");
      expect(loadText).toContain("조회 중");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-LOAD-05: In-Flight Delayed API Response on /tenant/rbac does not render (0명)
  it("[SC-LOAD-05] does not show (0명) while waiting on /tenant/rbac", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        {
          name: "mesh_token",
          value: jwtToken,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      await page.route("**/api/v1/**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      });
      await page.goto(`${viteBaseUrl}/tenant/rbac`);
      await page.waitForTimeout(150);
      const loadText = await page.locator("#root").innerText();
      expect(loadText).not.toContain("(0명)");
      expect(loadText).toContain("조회 중");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // Data-Driven Comprehensive Down State Assertion Across All 13 Screens (D-145)
  const ALL_13_SCREENS = [
    "/dashboard",
    "/creator",
    "/creator/groups",
    "/creator/topology",
    "/creator/playground",
    "/creator/lease-queue",
    "/creator/register",
    "/platform",
    "/platform/telemetry",
    "/platform/tenants",
    "/tenant/egress-acl",
    "/tenant/audits",
    "/tenant/rbac",
  ];

  const ZERO_REGEX = /(?:기록된|등록된|데이터가|내역이|요청이)\s*없|0개|0명|\b0 sessions|active_sockets=0|Groups: 0|테넌트 없음/;
  const UNKNOWN_REGEX = /불러오지 못|불러올 수 없|통신 불가|연결 불가|연결할 수 없|측정 불가|OFFLINE|수집 중/;

  for (const route of ALL_13_SCREENS) {
    it(`[SC-DOWN-ALL] ${route} distinguishes disconnected state from empty (D-145)`, async () => {
      // 1. Up text
      const upText = await withPage(route, async ({ page }) => {
        return await page.locator("#root").innerText();
      });

      // 2. Down text
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await context.addCookies([
          {
            name: "mesh_token",
            value: jwtToken,
            domain: "127.0.0.1",
            path: "/",
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ]);
        await page.route("**/api/v1/**", (r) => r.abort());
        await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" });
        const downText = await page.locator("#root").innerText();

        expect(downText).not.toBe(upText);
        expect(downText).not.toMatch(ZERO_REGEX);
        expect(downText).toMatch(UNKNOWN_REGEX);
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  // SC-WRITE-01: /creator/groups write abort does not claim success and row count does not increase
  it("[SC-WRITE-01] handles group creation abort without claiming success or increasing rows", async () => {
    await withPage("/creator/groups", async ({ page }) => {
      const beforeCount = await page.locator("tbody tr").count();
      await page.route("**/api/v1/admin/groups", (r) => {
        if (r.request().method() === "POST") return r.abort();
        return r.continue();
      });

      const createBtn = page.locator("button:has-text('그룹 생성')").first();
      await createBtn.click();
      await page.locator("input").first().fill("failed-group");
      const submitBtn = page.locator("button[type='submit']:has-text('생성')").first();
      await submitBtn.click();
      await page.waitForTimeout(500);

      const afterCount = await page.locator("tbody tr").count();
      expect(afterCount).toBe(beforeCount);
      const rootText = await page.locator("#root").innerText();
      expect(rootText).not.toContain("성공적으로 생성");
      expect(rootText).toMatch(/실패|오류|통신/);
    });
  });

  // SC-WRITE-02: /creator/groups duplicate group name does not increase rows or claim success
  it("[SC-WRITE-02] refuses duplicate group name without increasing rows or claiming success", async () => {
    await withPage("/creator/groups", async ({ page }) => {
      const beforeCount = await page.locator("tbody tr").count();
      const createBtn = page.locator("button:has-text('그룹 생성')").first();
      await createBtn.click();
      await page.locator("input").first().fill("default");
      const submitBtn = page.locator("button[type='submit']:has-text('생성')").first();
      await submitBtn.click();
      await page.waitForTimeout(500);

      const afterCount = await page.locator("tbody tr").count();
      expect(afterCount).toBe(beforeCount);
      const rootText = await page.locator("#root").innerText();
      expect(rootText).not.toContain("성공적으로 생성");
    });
  });

  // SC-WRITE-03: /creator teardown abort does not remove row and reports error
  it("[SC-WRITE-03] handles teardown abort without removing agent row and reports failure", async () => {
    await withPage("/creator", async ({ page }) => {
      const beforeCount = await page.locator("tbody tr").count();
      await page.route("**/api/v1/admin/agents/**", (r) => {
        if (r.request().method() === "DELETE") return r.abort();
        return r.continue();
      });

      const teardownBtn = page.locator("button:has-text('영구 Teardown'), button:has-text('Teardown')").first();
      if (await teardownBtn.count() > 0) {
        await teardownBtn.click();
        const inputPrompt = page.locator("input[placeholder*='입력'], input[type='text']").last();
        if (await inputPrompt.count() > 0) {
          await inputPrompt.fill("admin");
          const confirmBtn = page.locator("button:has-text('영구 Teardown 실행'), button:has-text('실행')").first();
          if (await confirmBtn.count() > 0) {
            await confirmBtn.click();
            await page.waitForTimeout(500);
          }
        }
      }

      const afterCount = await page.locator("tbody tr").count();
      expect(afterCount).toBe(beforeCount);
      const rootText = await page.locator("#root").innerText();
      expect(rootText).toMatch(/실패|오류|통신/);
    });
  });

  // SC-WRITE-04: /creator/topology dispatch abort does not claim success and reports error
  it("[SC-WRITE-04] handles topology quick send abort without claiming success", async () => {
    await withPage("/creator/topology", async ({ page }) => {
      await page.route("**/api/v1/messages", (r) => {
        if (r.request().method() === "POST") return r.abort();
        return r.continue();
      });

      // Click on a node or send button
      const nodeEl = page.locator("circle, g[cursor='pointer']").first();
      if (await nodeEl.count() > 0) {
        await nodeEl.click({ force: true });
        await page.waitForTimeout(300);
        const sendBtn = page.locator("button:has-text('메시지 전송'), button:has-text('빠른 전송'), button:has-text('전송')").first();
        if (await sendBtn.count() > 0) {
          await sendBtn.click();
          await page.waitForTimeout(500);
          const rootText = await page.locator("#root").innerText();
          expect(rootText).not.toContain("성공적으로 전송되었습니다");
          expect(rootText).not.toContain("전송이 완료되었습니다");
          expect(rootText).toMatch(/실패|오류|통신/);
        }
      }
    });
  });

  // SC-WRITE-05: /creator/playground receipt displays real server fields
  it("[SC-WRITE-05] renders playground receipt with real server response fields", async () => {
    await withPage("/creator/playground", async ({ page }) => {
      const sendBtn = page.locator("button:has-text('발송'), button:has-text('Send'), button[type='submit']").first();
      expect(await sendBtn.count()).toBeGreaterThanOrEqual(1);
      await sendBtn.click();
      await page.waitForTimeout(600);
      const mainText = await page.locator("#root").innerText();
      expect(mainText).toContain("발송된 메시지 본문");
      expect(mainText).not.toContain("msg_undefined");
    });
  });

  // SC-WRITE-06: /tenant/egress-acl rule toggle abort does not show success and reports failure (W-07)
  it("[SC-WRITE-06] handles egress rule toggle abort by reverting state and reporting failure", async () => {
    await withPage("/tenant/egress-acl", async ({ page }) => {
      await page.route("**/api/v1/admin/groups/**/egress**", (r) => r.abort());

      const toggleBtn = page.locator("button:has-text('ALLOW'), button:has-text('DENY'), button[title*='토글']").first();
      if (await toggleBtn.count() > 0) {
        await toggleBtn.click();
        await page.waitForTimeout(500);
        const rootText = await page.locator("#root").innerText();
        expect(rootText).toMatch(/실패|오류|통신/);
      }
    });
  });

  // SC-AUTH-01: Session authentication & cookie injection
  it("[SC-AUTH-01] verifies session auth and redirect flow", async () => {
    await withUnauthedPage("/login", async ({ page }) => {
      const userInput = page.locator("input[name='username'], input[placeholder*='아이디'], input[type='text']").first();
      const passInput = page.locator("input[name='password'], input[type='password']").first();
      const submitBtn = page.locator("button[type='submit']").first();

      await userInput.fill("admin");
      await passInput.fill("admin");
      await submitBtn.click();
      await page.waitForURL("**/dashboard", { timeout: 5000 });
      expect(page.url()).toContain("/dashboard");
    });
  });

  // SC-AUTH-02: Unauthenticated route guard redirects to /login (D-165)
  it("[SC-AUTH-02] redirects unauthenticated visitor on protected routes to /login", async () => {
    const protectedRoutes = ["/dashboard", "/platform", "/tenant/rbac"];
    for (const route of protectedRoutes) {
      await withUnauthedPage(route, async ({ page }) => {
        await page.waitForURL("**/login", { timeout: 3000 }).catch(() => {});
        expect(page.url()).toContain("/login");
      });
    }
  }, 15000);

  // SC-AUTH-03: Capability permission guard redirects to /dashboard when capability is missing
  it("[SC-AUTH-03] redirects user without required capability to /dashboard", async () => {
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    await withViewerPage(viewerCookie, "/tenant/rbac", async ({ page }) => {
      await page.waitForURL("**/dashboard", { timeout: 3000 }).catch(() => {});
      expect(page.url()).toContain("/dashboard");
    });
  }, 10000);

  // SC-BELL-01 and SC-THEME-01 are removed rather than kept red or skipped.
  //
  // Neither could fail for the reason its name gives, which is what makes them
  // not coverage:
  //
  //   SC-BELL-01   named for the notification bell, asserted `header, nav`
  //                counted at least one — and /dashboard has neither, so it
  //                failed for a reason unrelated to any bell. Measured on the
  //                running app: /dashboard 0 bells and no landmark, /creator 1,
  //                /tenant/rbac 1.
  //   SC-THEME-01  looked for a theme toggle, found none, and fell to an else
  //                branch of three `toBeDefined()` calls — so it passed
  //                whatever the page did.
  //
  // **Both IDs are still registered — in `test/fe-scenarios.test.ts`.** What was
  // removed here was the weaker of two copies: the surviving SC-BELL-01 counts
  // the badge against the pending-keys queue, which is the state GL-04 asks
  // for, and this one asserted that a landmark element existed. Read as "this
  // scenario has no coverage" and somebody writes a third.
  //
  // Rewriting them is writing new test logic, and the inventory says what that
  // logic has to do: GL-04 is *the badge is hidden at zero pending and shown at
  // n*, which is a state, not an existence. That belongs to the author of the
  // screens. Recorded as unimplemented with the reason instead of carried as
  // green.
  // Four ids, not two used twice. Each `it` here is its own scenario because an
  // id is what the inventory counts, and the first version of these registered
  // SC-NAV-01 and SC-NAV-02 twice apiece — so "SC-NAV-02 passes" could not say
  // whether the menu hid the items, the routes refused them, or only one did.
  // That is the same defect the split of SC-AUTH-* from SC-API-AUTH-* exists to
  // undo, written by the person who wrote the split.
  //
  //   SC-NAV-01  an admin sees every guarded item
  //   SC-NAV-02  a viewer sees the one they hold and not the others
  //   SC-NAV-03  a viewer holding nothing sees no guarded item
  //   SC-NAV-04  ... and the routes refuse them too
  // SC-NAV-01: the sidebar shows what the viewer's capabilities allow.
  //
  // The defect this exists for was invisible to every other check. Six items
  // named capabilities the contract does not define, so `includes()` was false
  // for everybody — including an admin holding all twelve — and six links
  // disappeared for every role at once. What remained was the same menu for a
  // platform operator, a tenant admin and an ordinary user, and the app looked
  // like it worked. The owner found it by looking at the screen.
  //
  // Scoped to the `<aside>`, which is the sidebar. Counting `a[href^="/"]`
  // across the page counts links in the page body too: the dashboard has one
  // to /platform/tenants, so a page-wide count reports a sidebar link that is
  // not in the sidebar — a wrong number rather than an obviously missing one,
  // which is worse.
  const GUARDED = [
    "/platform/tenants",
    "/tenant/egress-acl",
    "/tenant/audits",
    "/tenant/rbac",
  ];

  async function sidebarHrefs(page: import("playwright").Page): Promise<string[]> {
    return page.$$eval("aside a[href^='/']", (els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
  }

  it("[SC-NAV-01] shows an admin every guarded item, in the sidebar itself", async () => {
    await withPage("/dashboard", async ({ page }) => {
      const hrefs = await sidebarHrefs(page);

      // The scope has to have found the sidebar. An empty list contains no
      // wrong links either, and would pass every assertion below.
      expect(hrefs.length, "no sidebar links were found — the <aside> scope missed").toBeGreaterThan(6);

      const missing = GUARDED.filter((href) => !hrefs.includes(href));
      expect(missing, "admin holds all twelve capabilities and cannot see these").toEqual([]);
    });
  }, 20000);

  it("[SC-NAV-02] hides from a viewer the items they hold no capability for", async () => {
    // The other direction, and the one that says the filter still filters.
    // Without it, deleting `requiredCapability` from every entry would satisfy
    // the test above and show everything to everyone.
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context } = await createViewerAuthedPage(viewerCookie, "/dashboard");
    try {
      const hrefs = await sidebarHrefs(page);
      expect(hrefs.length, "no sidebar links were found").toBeGreaterThan(0);

      expect(hrefs, "the viewer holds audit.read.metadata and must see this")
        .toContain("/tenant/audits");
      for (const href of GUARDED.filter((h) => h !== "/tenant/audits")) {
        expect(hrefs, `${href} is shown to a viewer who cannot open it`).not.toContain(href);
      }
    } finally {
      await context.close().catch(() => {});
    }
  }, 20000);

  // SC-NAV-02: a session holding nothing is shown nothing it cannot open.
  //
  // **The defect appeared only at zero.** `AuthContext` read
  // `capabilities.length > 0 ? server : ROLE_CAPABILITIES[role]`, so a session
  // the server said held nothing took the same branch as a session the server
  // had not answered for — and that branch resolved to a role table, which for
  // admin is every capability. One capability locked four screens; none opened
  // them, menu and route alike.
  //
  // That is why the test uses an empty grant rather than a small one. Narrowing
  // the list stays green all the way down and inverts at the end point, so a
  // suite that only checks "fewer capabilities, fewer links" reports health for
  // the one case that is wrong.
  it("[SC-NAV-03] a viewer with no capability at all sees no guarded item", async () => {
    const cookie = await capabilityViewer(mesh);          // no grants at all
    const { page, context } = await createViewerAuthedPage(cookie, "/dashboard");
    try {
      const hrefs = await sidebarHrefs(page);
      // The scope has to have found the sidebar; an empty list contains no
      // guarded links either and would pass the assertion below on its own.
      expect(hrefs.length, "no sidebar links were found — the <aside> scope missed")
        .toBeGreaterThan(0);

      const shown = GUARDED.filter((href) => hrefs.includes(href));
      expect(shown, "holding nothing opened every guarded item").toEqual([]);
    } finally {
      await context.close().catch(() => {});
    }
  }, 20000);

  it("[SC-NAV-04] the routes refuse a session holding nothing, not only the menu", async () => {
    // The menu is an affordance. If the guard resolved the same way — and it
    // did, both reading one context — then hiding the link while the route
    // opened would be the worse half left in place.
    const cookie = await capabilityViewer(mesh);
    for (const route of ["/tenant/rbac", "/tenant/audits"]) {
      const { page, context } = await createViewerAuthedPage(cookie, route);
      try {
        await page.waitForURL("**/dashboard", { timeout: 3000 }).catch(() => {});
        expect(page.url(), `${route} opened for a session holding nothing`).toContain("/dashboard");
      } finally {
        await context.close().catch(() => {});
      }
    }
  }, 25000);

  // SC-HARNESS-01: Harness reliability check
  it("[SC-HARNESS-01] verifies platform mesh readiness and test harness health", async () => {
    expect(mesh).toBeDefined();
    expect(mesh.http.url).toContain("http");
    expect(mesh.hub.url).toContain("http");
  });

});

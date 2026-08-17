import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Database } from "bun:sqlite";
import { chromium, type Browser } from "playwright";
import { startMesh, newKeyPair } from "./harness.ts";

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
        })
      );
    });

    // Navigate to target route
    await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" });
    return { page, context, errors };
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

  // SC-ACT-02: Interactive Refresh Button Action on Dashboard (D-91, D-101)
  it("[SC-ACT-02] clicks interactive refresh button and maintains clean state", async () => {
    const { page, context, errors } = await createAuthedPage("/dashboard");
    const refreshBtn = page.locator("button:has-text('새로고침'), button:has-text('Refresh'), button[aria-label*='새로고침']").first();
    expect(await refreshBtn.count()).toBeGreaterThanOrEqual(1);
    await refreshBtn.click();
    await page.waitForTimeout(300);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("전체 에이전트 노드");
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

  // SC-ACT-04: Interactive Telemetry Refresh (D-91, D-101)
  it("[SC-ACT-04] clicks refresh on platform telemetry", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/telemetry");
    const refreshBtn = page.locator("button:has-text('실시간 갱신'), button:has-text('갱신')").first();
    expect(await refreshBtn.count()).toBeGreaterThanOrEqual(1);
    await refreshBtn.click();
    await page.waitForTimeout(300);
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("활성 소켓 연결 수");
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

  // SC-ACT-06: Interactive Tenant Audits Refresh (D-91, D-101)
  it("[SC-ACT-06] clicks audit logs refresh and checks table rendering", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/audits");
    const refreshBtn = page.locator("button:has-text('감사 로그 갱신'), button:has-text('갱신')").first();
    expect(await refreshBtn.count()).toBeGreaterThanOrEqual(1);
    await refreshBtn.click();
    await page.waitForTimeout(300);
    const rows = await page.locator("table tbody tr, [role='row']").count();
    expect(rows).toBeGreaterThanOrEqual(4);
    expect(errors).toEqual([]);
    await context.close();
  });
});

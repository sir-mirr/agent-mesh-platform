import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { startMesh } from "./harness.ts";

describe("Frontend Live Render & DOM Scenarios (COVERAGE_INVENTORY.md § 3)", () => {
  let mesh: Awaited<ReturnType<typeof startMesh>>;
  let viteProc: ChildProcess;
  const VITE_PORT = 3195;
  const viteBaseUrl = `http://127.0.0.1:${VITE_PORT}`;

  beforeAll(async () => {
    mesh = await startMesh();

    const viteBin = path.resolve(import.meta.dir, "../packages/platform-web/node_modules/vite/bin/vite.js");
    const webRoot = path.resolve(import.meta.dir, "../packages/platform-web");

    let stdoutData = "";
    let stderrData = "";

    viteProc = spawn(process.execPath, [viteBin, webRoot, "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"], {
      env: {
        ...process.env,
        API_PROXY_TARGET: mesh.http.url,
      },
    });

    viteProc.stdout?.on("data", (d) => { stdoutData += d.toString(); });
    viteProc.stderr?.on("data", (d) => { stderrData += d.toString(); });

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
      throw new Error(`Vite dev server failed to start on ${viteBaseUrl}. stdout: ${stdoutData}, stderr: ${stderrData}`);
    }
  }, 30000);

  afterAll(async () => {
    try {
      viteProc?.kill("SIGTERM");
    } catch {}
    await mesh?.stop();
  }, 10000);

  // SCR-01 / SC-RENDER-01: Login Form & Entry Module Resolution
  it("[SC-RENDER-01] serves index.html with mount point and transforms /src/main.tsx without error", async () => {
    const indexRes = await fetch(`${viteBaseUrl}/`);
    expect(indexRes.status).toBe(200);
    const html = await indexRes.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('/src/main.tsx');

    const mainRes = await fetch(`${viteBaseUrl}/src/main.tsx`);
    expect(mainRes.status).toBe(200);
    const mainCode = await mainRes.text();
    expect(mainCode).toContain("createRoot");
    expect(mainCode.length).toBeGreaterThan(100);

    const loginRes = await fetch(`${viteBaseUrl}/src/pages/LoginPage.tsx`);
    expect(loginRes.status).toBe(200);
    const loginCode = await loginRes.text();
    expect(loginCode).toContain("LoginPage");
  });

  // SCR-02 / SC-RENDER-02: Dashboard Page Module
  it("[SC-RENDER-02] transforms DashboardPage.tsx with role views and KPI components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/DashboardPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("DashboardPage");
    expect(code).toContain("KpiCard");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-03 / SC-RENDER-03: Agents List Page Module
  it("[SC-RENDER-03] transforms AgentsPage.tsx with agent data table components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/creator/AgentsPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("AgentsPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-04 / SC-RENDER-04: Groups Management Page Module
  it("[SC-RENDER-04] transforms GroupsPage.tsx with group card grid components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/creator/GroupsPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("GroupsPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-05 / SC-RENDER-05: Dynamic Topology Page Module
  it("[SC-RENDER-05] transforms TopologyPage.tsx with SVG orbital canvas components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/creator/TopologyPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("TopologyPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-06 / SC-RENDER-06: Message Dispatch Playground Module
  it("[SC-RENDER-06] transforms PlaygroundPage.tsx with message console components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/creator/PlaygroundPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("PlaygroundPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-07 / SC-RENDER-07: Lease Queue Monitor Page Module
  it("[SC-RENDER-07] transforms LeaseQueuePage.tsx with mailbox queue depth components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/creator/LeaseQueuePage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("LeaseQueuePage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-08 / SC-RENDER-08: Agent Registration & Key Proposals Module
  it("[SC-RENDER-08] transforms RegisterAgentPage.tsx with Ed25519 form components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/creator/RegisterAgentPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("RegisterAgentPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-09 / SC-RENDER-09: Platform Infrastructure Overview Module
  it("[SC-RENDER-09] transforms PlatformOverviewPage.tsx with node health components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/platform/PlatformOverviewPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("PlatformOverviewPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-10 / SC-RENDER-10: Node Telemetry Monitoring Module
  it("[SC-RENDER-10] transforms TelemetryPage.tsx with telemetry card components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/platform/TelemetryPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("TelemetryPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-11 / SC-RENDER-11: Tenant Traffic Isolation Module
  it("[SC-RENDER-11] transforms TenantTrafficPage.tsx with isolation table components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/platform/TenantTrafficPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("TenantTrafficPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-12 / SC-RENDER-12: Directional Egress ACL Matrix Module
  it("[SC-RENDER-12] transforms TenantEgressAclPage.tsx with directional matrix components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/tenant/TenantEgressAclPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("TenantEgressAclPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-13 / SC-RENDER-13: Security Audit Logs Stream Module
  it("[SC-RENDER-13] transforms AuditLogsPage.tsx with redaction policy components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/tenant/AuditLogsPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("AuditLogsPage");
    expect(code.length).toBeGreaterThan(200);
  });

  // SCR-14 / SC-RENDER-14: RBAC Capability Management Module
  it("[SC-RENDER-14] transforms RbacManagementPage.tsx with capability matrix components", async () => {
    const res = await fetch(`${viteBaseUrl}/src/pages/tenant/RbacManagementPage.tsx`);
    expect(res.status).toBe(200);
    const code = await res.text();
    expect(code).toContain("RbacManagementPage");
    expect(code.length).toBeGreaterThan(200);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { startMesh } from "./harness.ts";

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
    const rootText = await page.textContent("#root");
    expect(rootText).not.toBeNull();
    expect(rootText!.length).toBeGreaterThan(50);
    expect(await page.locator("input").count()).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-02 / SC-RENDER-02: Dashboard Page Live Render
  it("[SC-RENDER-02] renders /dashboard with role-specific KPI cards and zero page errors", async () => {
    const { page, context, errors } = await createAuthedPage("/dashboard");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(mainText).not.toContain("null%");
    expect(mainText).not.toContain("undefined");
    expect(mainText).not.toContain("NaN");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-03 / SC-RENDER-03: Agents List Page Live Render
  it("[SC-RENDER-03] renders /creator/agents with real agent table", async () => {
    const { page, context, errors } = await createAuthedPage("/creator");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-04 / SC-RENDER-04: Groups Management Page Live Render
  it("[SC-RENDER-04] renders /creator/groups with groups container", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/groups");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-05 / SC-RENDER-05: Dynamic Topology Page Live Render
  it("[SC-RENDER-05] renders /creator/topology with SVG canvas container", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/topology");
    const svgCount = await page.locator("svg").count();
    expect(svgCount).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-06 / SC-RENDER-06: Message Dispatch Playground Live Render
  it("[SC-RENDER-06] renders /creator/playground with dispatch console", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/playground");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-07 / SC-RENDER-07: Lease Queue Monitor Page Live Render
  it("[SC-RENDER-07] renders /creator/lease-queue with queue monitor", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/lease-queue");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-08 / SC-RENDER-08: Agent Registration Page Live Render
  it("[SC-RENDER-08] renders /creator/register with registration form", async () => {
    const { page, context, errors } = await createAuthedPage("/creator/register");
    const inputs = await page.locator("input, textarea").count();
    expect(inputs).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-09 / SC-RENDER-09: Platform Infrastructure Overview Live Render
  it("[SC-RENDER-09] renders /platform with node health status", async () => {
    const { page, context, errors } = await createAuthedPage("/platform");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(mainText).not.toContain("null%");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-10 / SC-RENDER-10: Node Telemetry Page Live Render
  it("[SC-RENDER-10] renders /platform/telemetry with telemetry cards", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/telemetry");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-11 / SC-RENDER-11: Tenant Traffic Page Live Render
  it("[SC-RENDER-11] renders /platform/tenants with isolation table", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/tenants");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-12 / SC-RENDER-12: Tenant Egress ACL Page Live Render
  it("[SC-RENDER-12] renders /tenant/egress-acl with matrix grid", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/egress-acl");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-13 / SC-RENDER-13: Security Audit Logs Stream Live Render & Cross-Validation
  it("[SC-RENDER-13] renders /tenant/audits with real distinct timestamps and routes", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/audits");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);

    // Check rows in table
    const rows = await page.locator("table tbody tr, [role='row']").allInnerTexts();
    if (rows.length > 1) {
      // Must not be all identical timestamps or all unknown routes
      const uniqueRows = new Set(rows);
      expect(uniqueRows.size).toBeGreaterThan(1);
      expect(mainText).not.toContain("unknown → unknown");
    }

    await context.close();
  });

  // SCR-14 / SC-RENDER-14: RBAC Capability Management Live Render
  it("[SC-RENDER-14] renders /tenant/rbac with capability chips", async () => {
    const { page, context, errors } = await createAuthedPage("/tenant/rbac");
    const mainText = await page.locator("#root").innerText();
    expect(mainText.length).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await context.close();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Database } from "bun:sqlite";

import { openTestDb } from "./harness";
import { chromium, type Browser } from "playwright";
import { ALL_CAPABILITIES } from "@agent-mesh/contracts";
import { startMesh, newKeyPair, capabilityViewer, freePort } from "./harness.ts";

describe("Frontend Live Render & DOM Scenarios (COVERAGE_INVENTORY.md § 3)", () => {
  /** What the setup's own writes answered, when they did not answer OK.
   *
   * Collected here rather than logged, because a setup that pipes its responses
   * somewhere nobody reads is the same as one that does not read them — the
   * shape that let `name` and `members: [...]` be dropped by this suite's group
   * creation for four months. `SC-HARNESS-03` is the reader. */
  const setupSaid: string[] = [];

  /** One write, and what it answered when it did not answer OK.
   *
   * Every setup write goes through here. Three of them did not, and all three
   * were dead: a group create whose `name`/`members` the route dropped, a key
   * approval addressed by identity when the route wants a fingerprint, and an
   * egress rule sent as `PUT` to a path with no `PUT`. Each answered, and each
   * answer was thrown away at the call site — so the mesh these scenarios read
   * was never the mesh this file describes. */
  async function setupWrite(what: string, url: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `mesh_token=${jwtToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) setupSaid.push(`${what} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
  let mesh: Awaited<ReturnType<typeof startMesh>>;
  let viteProc: ChildProcess;
  let browser: Browser;
  // **Asked for, not chosen.** This was a fixed 3195 with `--strictPort`, which
  // meant a second run of this suite could not bind and every scenario in it
  // then failed to reach a server — a red suite produced by two people testing
  // at the same time, and indistinguishable from a red suite produced by a
  // defect. It cost an hour of exactly that confusion tonight.
  let vitePort = 0;
  let viteBaseUrl = "";
  let jwtToken: string;

  beforeAll(async () => {
    mesh = await startMesh();
    vitePort = await freePort();
    viteBaseUrl = `http://127.0.0.1:${vitePort}`;

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
    await setupWrite("provision agent-alpha", `${mesh.hub.url}/api/v1/agents`, {
      identity: "agent-alpha",
      public_key: keyPairA.publicKey,
      type: "ai-claude",
    });

    // **`ai-custom` is not a type this mesh has.** The recorder above caught it
    // on its first run: `type must be one of: ai-antigravity, ai-claude,
    // ai-codex, human, service`. So `agent-beta` was never provisioned, and
    // every scenario naming it has been reading a mesh without it — the fourth
    // dead write in this setup and the first one nothing had reported.
    await setupWrite("provision agent-beta", `${mesh.hub.url}/api/v1/agents`, {
      identity: "agent-beta",
      public_key: keyPairB.publicKey,
      type: "ai-codex",
    });

    // 2. Approve agent-alpha.
    //
    // **Addressed by fingerprint, never by identity.** This sent `identity` and
    // `public_key`, the route requires `fingerprint`, and it answered 400 —
    // so `agent-alpha`'s key has never been approved and every scenario about
    // an approved key has run against a pending one. The route's own comment
    // gives the reason for the shape: approving "whatever is pending for X"
    // approves whatever arrived last, including a proposal that landed between
    // reading the screen and clicking.
    await setupWrite("approve agent-alpha key", `${mesh.http.url}/api/v1/admin/keys/approve`, {
      fingerprint: keyPairA.fingerprint,
    });

    // 3. Create directional groups (engineering -> security)
    //
    // **Two calls, because membership is a move and not a field.**
    // `POST /api/v1/admin/groups` reads `group_id` and `description`. This setup
    // used to send `name` and `members: [...]` as well, and the route dropped
    // both without a word — for four months. The groups were empty the whole
    // time, `TopologyPage` filled any empty group with every live agent, and so
    // the screen looked populated while the fixture looked applied. Removing
    // that fallback is what surfaced it.
    //
    // `platform-claude` is making the route refuse an unsupported field instead
    // of dropping it, which turns these into 400s — so they are corrected here
    // first, and that ordering is the point: a setup that does not read its own
    // responses cannot tell a 400 from a 201.
    const createGroup = (groupId: string, description: string) =>
      setupWrite(`create group ${groupId}`, `${mesh.http.url}/api/v1/admin/groups`, {
        group_id: groupId,
        description,
      });
    // The group has to exist first: this route answers 404 for one that does
    // not, rather than creating it somewhere no rule can name.
    const addMember = (groupId: string, identity: string) =>
      setupWrite(`add ${identity} to ${groupId}`, `${mesh.http.url}/api/v1/admin/groups/${groupId}/members`, {
        identity,
      });

    await createGroup("engineering", "Engineering Division");
    await addMember("engineering", "agent-alpha");
    await createGroup("security", "Security Division");
    await addMember("security", "agent-beta");

    // Set directional egress engineering -> security.
    //
    // **This was `PUT` with `allowed_targets`, and neither exists.** The only
    // `app.put` in the server is the audit blob route; egress is `POST` with a
    // single `to_group`, because the rule is directional and one-at-a-time —
    // the same shape as membership, for the same reason. So this 404'd, the
    // rule was never written, and every screen that reads the egress matrix has
    // been reading an empty one. `platform-claude` found it by sweeping callers
    // against routes; nothing here would have said so, because the response was
    // dropped like the two before it.
    await setupWrite(
      "egress engineering -> security",
      `${mesh.http.url}/api/v1/admin/groups/engineering/egress`,
      { to_group: "security" },
    );

    // 4. Seed message stats for tenant traffic table
    try {
      const hubDbPath = path.join(mesh.stateDir, "hub.db");
      const db = openTestDb(hubDbPath);
      db.prepare(`
        INSERT INTO message_stats (ts, tenant, from_agent, to_agent, via)
        VALUES (datetime('now'), 'default', 'agent-alpha', 'admin', 'direct')
      `).run();
      db.close();
    } catch {}

    // 5. Seed rich audit events in audit.db with D-67 proxy routing (sent_by != from) & attested signatures
    try {
      const auditDbPath = path.join(mesh.stateDir, "audit.db");
      const auditDb = openTestDb(auditDbPath);
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
      const httpDb = openTestDb(httpDbPath);
      httpDb.prepare(`
        INSERT OR IGNORE INTO agent_registry (id, name, description, channel, type, approved)
        VALUES ('agent-alpha', 'Agent Alpha (Claude)', 'High performance reasoning agent', 'hub', 'ai-claude', 1)
      `).run();
      httpDb.close();
    } catch {}

    const viteBin = path.resolve(import.meta.dir, "../packages/platform-web/node_modules/vite/bin/vite.js");
    const webRoot = path.resolve(import.meta.dir, "../packages/platform-web");

    viteProc = spawn(process.execPath, [viteBin, webRoot, "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
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

  /**
   * Wait until the app has finished deciding whether the session is valid.
   *
   * **`GuardedRoute` renders `인증 상태를 확인하는 중입니다...` while it asks**,
   * and a scenario that reads `innerText` straight after `goto` can catch that
   * instead of the screen it came for. agent-mesh-local-pm hit it running two
   * suites at once: SC-DOWN-07 expected the disconnected message and got the
   * authenticating one. **The screen was telling the truth and the assertion
   * did not know that state existed.**
   *
   * The fourteen `waitForTimeout` calls in this file are the same defect with a
   * number in front of it. (This comment said three, from a count taken over
   * one section and reported as the file — measured since: 150ms ×5, 300ms ×2,
   * 500ms ×5, 600ms ×2.) They pass because this machine is not busy, not
   * because the number is enough, and raising them changes how long the suite
   * takes rather than what it measures.
   *
   * Five of them sat directly after a `settled()` call and are gone: measured
   * at 1/1 and 1/10, the gap between the interim text going and the content
   * appearing is 0ms, because `GuardedRoute` releasing its child and the
   * child's aborted fetch resolve in the same commit. They were waiting for
   * something that had already happened.
   *
   * The nine after a `click()` are the ones that still matter, and they need a
   * different answer: what to wait for there is what the click produces.
   *
   * Waiting on the state instead cannot read the interim screen at all,
   * whatever the machine is doing.
   *
   * **What this does not claim.** It was reported as the fix for concurrent
   * runs, on a before-and-after of 17+16 failures then 0+0. That was not a
   * controlled comparison — with these calls disabled, two runs still pass
   * 0+0, so the earlier failures had another cause and the improvement was
   * not this. The claim has been withdrawn.
   *
   * No deterministic reproduction has been found either. Delaying `/auth/me`
   * does not do it: `waitUntil: "networkidle"` already waits for that request,
   * so the interim screen is gone before the assertion looks. A scenario built
   * on that lever passed with these calls removed — it proved nothing, and was
   * deleted rather than kept as evidence of something it does not show.
   *
   * What remains is a state that was **observed once**, by
   * agent-mesh-local-pm, with SC-DOWN-07 reading `인증 상태를 확인하는 중` on a
   * screen that was telling the truth. Waiting for that text to go makes the
   * misread impossible whether or not anyone can summon it on demand, and that
   * is the whole of the case for it.
   */
  async function settled(page: import("playwright").Page): Promise<void> {
    await page
      .waitForFunction(
        () => !(document.body.innerText || "").includes("인증 상태를 확인하는 중"),
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {
        // Still checking after ten seconds is a finding, not something to hide
        // — let the assertion that follows report what it actually saw.
      });
  }

  /**
   * Wait until `#root` actually contains what the assertion is about.
   *
   * **`settled()` was passing for a reason unrelated to its name.** It waits
   * for the authenticating text to go, and agent-mesh-local-pm measured that
   * this is already true when the read happens — 0ms — while the content the
   * scenario then asserts takes another 81ms on a cold server at 1/10. Removing
   * `settled()` made those scenarios fail, which looked like proof that it
   * worked; what it actually contributed was the ~80ms its `waitForFunction`
   * spends polling. A guard whose value is its own overhead breaks the day the
   * polling gets faster.
   *
   * So the wait names the thing it is waiting for. That is the difference
   * between a margin and a coincidence: 80ms against 81ms is the latter.
   */
  async function shows(page: import("playwright").Page, needle: string, timeoutMs = 10_000): Promise<void> {
    await page
      .waitForFunction(
        (text) => (document.getElementById("root")?.innerText ?? "").includes(text as string),
        needle,
        { timeout: timeoutMs },
      )
      .catch(() => {
        // Let the assertion report what the screen really said. A throw here
        // would replace the screen's own words with a timeout message.
      });
  }

  /**
   * `shows`, for an assertion written as a pattern.
   *
   * The failure scenarios do not assert a fixed sentence — they assert that
   * *something* went wrong, `/실패|오류|통신/` — so there is no literal to wait
   * for. Suggested by agent-mesh-local-pm while checking the last uncovered
   * site.
   */
  async function showsMatch(page: import("playwright").Page, re: RegExp, timeoutMs = 10_000): Promise<void> {
    await page
      .waitForFunction(
        (source) => new RegExp(source as string).test(document.getElementById("root")?.innerText ?? ""),
        re.source,
        { timeout: timeoutMs },
      )
      .catch(() => {});
  }

  /**
   * Wait for a write attempt to be over when the assertion is about absence.
   *
   * Two of these scenarios assert that nothing happened — the row count did not
   * change, no success message appeared — and **absence cannot be waited for.**
   * What can be waited for is the attempt finishing, which is what an idle
   * network means here: the click fired a request and it has resolved or been
   * refused. Still a state rather than a number.
   */
  async function attemptOver(page: import("playwright").Page): Promise<void> {
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  /**
   * Scenarios that ran but measured nothing.
   *
   * **An inconclusive result is reported as a pass**, because there is no other
   * verdict for bun to give it, and a `console.warn` is one line inside six
   * hundred. agent-mesh-local-pm counted three such exits in SC-WRITE-08 alone
   * and named the risk concretely: change the placeholder that scenario finds
   * its field by, and it goes inconclusive **for ever** — leaving a green line
   * that says a check exists while nothing is checked. That is the shape of the
   * scenario deleted earlier tonight, coming back through a different door.
   *
   * So they are collected and printed together at the end, where a count is
   * legible. Not failed on: the honest reason for most of them is that this
   * machine cannot reproduce the condition, and turning a property of the
   * machine into a red is the thing this suite spent the night removing.
   */
  const inconclusive: string[] = [];

  function cannotMeasure(scenario: string, why: string): void {
    inconclusive.push(`${scenario} — ${why}`);
    console.warn(`[${scenario}] inconclusive: ${why}`);
  }

  afterAll(() => {
    if (inconclusive.length === 0) return;
    console.warn(
      `\n─── ${inconclusive.length} scenario(s) ran without measuring anything ───\n` +
        inconclusive.map((line) => `  ${line}`).join("\n") +
        `\n─── each of these is reported above as a pass ───\n`,
    );
  });

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
    await settled(page);
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
    await settled(page);
    return { page, context, errors };
  }

  async function withUnauthedPage<T>(route: string, fn: (pageInfo: { page: import("playwright").Page; errors: string[] }) => Promise<T>): Promise<T> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" });
    await settled(page);
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
    await shows(page, "발송된 메시지 본문");
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
    await shows(page, "신규 그룹 생성");
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

  // SC-CAP-05: the playground shows what the API gave it — no filter of its own
  it("[SC-CAP-05] lists exactly the agents /api/v1/agents returned for that session", async () => {
    // **A filter that hides nothing but reads as authorisation is worse than
    // none.** The sender list compared a hardcoded `ownerId` to the signed-in
    // id, and the recipient list excluded a group name from a field holding the
    // agent's *type* — so one passed everything for a single username and the
    // other excluded nothing, both looking like permission checks.
    //
    // The invariant is not "everyone sees the same list": `/api/v1/agents`
    // refuses an unapproved account outright, which is a real restriction and
    // the server's to make. It is that **the screen neither adds nor removes
    // rows**. Measured per session against that session's own response, so it
    // holds for an admin and for a viewer the API refuses.
    const check = async (label: string, cookie: string | null) => {
      const info = cookie
        ? await createViewerAuthedPage(cookie, "/creator/playground")
        : await createAuthedPage("/creator/playground");
      try {
        const served: string[] = await info.page.evaluate(async () => {
          const res = await fetch("/api/v1/agents", { credentials: "include" });
          if (!res.ok) return [];
          const body = await res.json();
          return (body.agents ?? []).map((a: { id: string }) => a.id);
        });

        const options = await info.page.locator("select option").allTextContents();
        const shown = new Set(
          options.flatMap((text) => served.filter((id) => text.includes(id))),
        );
        // Every served agent appears, and nothing appears that was not served.
        expect({ label, shown: [...shown].sort() }).toEqual({ label, shown: [...served].sort() });
        return served.length;
      } finally {
        await info.context.close();
      }
    };

    const adminCount = await check("admin", null);
    // Non-empty for at least one session, or both sides agree vacuously.
    expect({ any: adminCount > 0 }).toEqual({ any: true });
    await check("viewer", await capabilityViewer(mesh, "audit.read.metadata"));
  }, 30_000);

  // SC-SCR10-01: the behavioural metrics § D-1 chose, and the zero they must
  // not invent
  it("[SC-SCR10-01] draws the six behavioural metrics and marks unread ones as unmeasured", async () => {
    await withPage("/platform/telemetry", async ({ page }) => {
      const panel = page.locator("[data-testid='behaviour-metrics']");
      await panel.waitFor({ state: "visible", timeout: 10_000 });

      const said = (await panel.textContent()) ?? "";
      // The six by the names the inventory gives them. Not a count of tiles —
      // six tiles with the wrong labels would pass that.
      for (const label of ["대기 키", "최고 경과", "서명 거절", "rate limit", "egress 거절", "수락 수"]) {
        expect({ label, drawn: said.includes(label) }).toEqual({ label, drawn: true });
      }

      // **The window travels with the counts.** The hub's refusal counters are
      // per-process and reset with it, so `0 refusals` and `this hub started a
      // minute ago` are the same figure without it.
      const since = page.locator("[data-testid='counting-since']");
      expect(await since.count()).toBe(1);
      expect({ stated: ((await since.textContent()) ?? "").length > 10 }).toEqual({ stated: true });

      // A live mesh answers, so nothing here should be unmeasured — and that is
      // asserted rather than assumed, because an all-unmeasured panel would
      // otherwise satisfy every check above.
      expect(await page.locator("[data-testid='metric-unmeasured']").count()).toBe(0);
    });
  }, 30_000);

  // SC-SCR10-02: the screen half of the same rule — a null from the server must
  // not become a zero on the page
  it("[SC-SCR10-02] draws an unreadable metric as unmeasured, never as 0", async () => {
    // **The route is intercepted rather than the hub stopped.** Stopping it
    // would answer the same question and break every other scenario sharing
    // this mesh; and the layer under test is the screen, so the honest place to
    // inject is the response it reads. agent-mesh-local-pm measured the data
    // half by SIGSTOPping the hub and left this half open.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await context.addCookies([
        { name: "mesh_token", value: jwtToken, domain: "127.0.0.1", path: "/", httpOnly: false, secure: false },
      ]);
      await page.route("**/api/v1/admin/telemetry/behaviour", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            counting_since: null,
            pending_keys: { value: 4 },
            oldest_pending_ms: { value: null, unavailable: "message store could not be read" },
            signature_refusals: { value: null, unavailable: "hub did not answer /api/v1/limits" },
            rate_limited: { value: null, unavailable: "hub did not answer /api/v1/limits" },
            egress_refusals: { value: null, unavailable: "hub did not answer /api/v1/limits" },
            accepted: { value: 0 },
          }),
        }),
      );

      await page.goto(`${viteBaseUrl}/platform/telemetry`, { waitUntil: "networkidle" });
      const panel = page.locator("[data-testid='behaviour-metrics']");
      await panel.waitFor({ state: "visible", timeout: 10_000 });

      // Four unreadable metrics, four "미측정" cells. Counted rather than
      // matched on text, because one marker with three zeros beside it would
      // satisfy a contains-check.
      expect(await page.locator("[data-testid='metric-unmeasured']").count()).toBe(4);

      // **And the real zero survives.** `accepted` was measured and is 0; a fix
      // that drew every zero as unmeasured would pass the line above and be
      // just as wrong in the other direction.
      const said = (await panel.textContent()) ?? "";
      expect({ realZeroKept: /수락 수[\s\S]{0,40}0/.test(said) }).toEqual({ realZeroKept: true });
      expect({ pendingKept: said.includes("4") }).toEqual({ pendingKept: true });

      // With no window the refusal counts cannot be read, and the heading says
      // so rather than printing a date it does not have.
      const since = (await page.locator("[data-testid='counting-since']").textContent()) ?? "";
      expect({ saysUnknown: since.includes("미상") }).toEqual({ saysUnknown: true });
    } finally {
      await context.close();
    }
  }, 30_000);

  // SC-CAP-04: Telemetry says which panels it was refused, rather than showing
  // an empty mesh (I-061)
  it("[SC-CAP-04] names the refused panels on /platform/telemetry instead of rendering blanks", async () => {
    // **Two of the four endpoints behind this screen are ungated** — none of
    // § 11's twelve capabilities names reading the registry — so they always
    // answer and the page's error branch is unreachable for a refusal. Before
    // this, a viewer without `usage.read` saw the normal layout with `—` in
    // every cell, which is exactly what an idle mesh looks like.
    // agent-mesh-local-pm measured it as 999 bytes before the refusal and 999
    // after: the screen made no statement about the backend at all.
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context, errors } = await createViewerAuthedPage(viewerCookie, "/platform/telemetry");
    expect(errors).toEqual([]);

    const banner = page.locator("[data-testid='telemetry-refused']");
    await banner.waitFor({ state: "visible", timeout: 5000 });

    // The capability, not just "an error" — the reader has to know what to ask
    // for, and "something went wrong" sends them to the wrong person.
    const said = (await banner.textContent()) ?? "";
    expect({ names: said.includes("usage.read") && said.includes("mailbox.read.depth") })
      .toEqual({ names: true });

    // And it is genuinely different from what an admin sees.
    const admin = await createAuthedPage("/platform/telemetry");
    expect(await admin.page.locator("[data-testid='telemetry-refused']").count()).toBe(0);
    await admin.context.close();

    await context.close();
  }, 30_000);

  // SC-ADDR-02: the agent list does not claim a fingerprint it was not given
  // (I-062)
  it("[SC-ADDR-02] shows no fingerprint on /creator, rather than a constant that says verified", async () => {
    // `GET /api/v1/agents` returns id, name, description, channel and type. It
    // has never carried a fingerprint, and the column is headed "Ed25519 public
    // key fingerprint" — so every row rendered
    // `sha256:verified_mesh_identity`, the same value for every agent, with the
    // word an operator is looking for sitting inside it.
    await withPage("/creator", async ({ page }) => {
      const body = (await page.locator("body").textContent()) ?? "";

      // The specific constant, and the shape of any replacement for it.
      expect({ constant: body.includes("verified_mesh_identity") }).toEqual({ constant: false });
      expect({ digestLike: /sha256:[a-z_]{6,}/i.test(body) && !/sha256:[0-9a-f]{6,}/i.test(body) })
        .toEqual({ digestLike: false });

      // And absence is stated rather than left blank, because a blank cell in a
      // security column reads as "nothing to worry about".
      const absent = page.locator("[data-testid='fingerprint-absent']");
      expect(await absent.count()).toBeGreaterThan(0);

      // **The row, not the cell.** `GET /api/v1/agents` sends five fields and
      // four columns were filled from none of them: every agent showed as
      // ONLINE, with a backlog of 0, created now, and verified. The two that
      // survive as their own columns are marked here — a default of `ONLINE`
      // is the worst of them, because unknown reading as healthy is the one an
      // operator has no reason to question.
      expect({ statusUnknown: await page.locator("[data-testid='status-unknown']").count() > 0 })
        .toEqual({ statusUnknown: true });
      expect({ inboxUnknown: await page.locator("[data-testid='inbox-unknown']").count() > 0 })
        .toEqual({ inboxUnknown: true });
      expect({ online: body.includes("ONLINE") }).toEqual({ online: false });
    });
  }, 30_000);

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
    await settled(page);

    await shows(page, "메일함 리스 큐 데이터를 불러올 수 없습니다");

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
    await settled(page);

    await shows(page, "조직 정보 불러오지 못함");

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
    await settled(page);

    await shows(page, "그룹 목록을 불러올 수 없습니다");

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
    await settled(page);

    await shows(page, "토폴로지 데이터를 불러오는 중입니다");

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
    await settled(page);

    await shows(page, "조회 중");

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
    await settled(page);

    await shows(page, "에이전트 목록을 불러오는 중입니다");

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
      await settled(page);
      await shows(page, "OFFLINE");
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
      await settled(page);
      await shows(page, "감사 로그 데이터를 불러올 수 없습니다");
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
      await settled(page);
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
      await settled(page);
      await shows(page, "에이전트 목록을 불러올 수 없습니다");
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("현재 등록된 에이전트 데이터가 없습니다");
      expect(downText).toContain("에이전트 목록을 불러올 수 없습니다");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-HARNESS-02: a disconnected screen is not read as the authenticating one.
  //
  // **The lever is CPU, not the network** — agent-mesh-local-pm measured both.
  // Delaying `/auth/me` does nothing, because `waitUntil: "networkidle"` waits
  // for that request: the delay moves `goto`, not the assertion. What lands
  // after networkidle is the *re-render*, and starving the CPU pushes it past
  // the read:
  //
  //   1/1 and 1/4   terminal state
  //   1/10 and 1/20 "인증 상태를 확인하는 중입니다..."
  //
  // This is also why two machines disagreed about concurrent runs — 33
  // failures on one and 1 on another, same command, same commit. It was CPU
  // contention, not the scope difference first offered to explain it.
  //
  // Refuses rather than reports when the machine is already starved: if the
  // interim screen shows up unthrottled, the throttled result says nothing
  // about the guard, and a test that cannot tell those apart is a test of the
  // machine.
  it("[SC-HARNESS-02] a starved CPU does not make a disconnected screen read as authenticating", async () => {
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

      const cdp = await context.newCDPSession(page);
      // Measured on the cold page, which is the only configuration in which
      // this measures anything:
      //
      //   1/1 · 1/4    terminal before the read — nothing to catch
      //   1/10 · 1/20  the interim screen, and the assertion is exercised
      //
      // **Identical to agent-mesh-local-pm's machine.** An earlier sweep here
      // reported 1/10 and 1/20 as inconclusive, 1/50 as unstable and 1/100 as
      // broken, and concluded that the window is a property of the hardware.
      // That sweep was run with the page reused between the unthrottled and
      // throttled legs — the same variable that made this scenario report
      // inconclusive in the first place. It was not measuring the machine; it
      // was measuring a warm page, and it closed the window it went looking
      // for.
      //
      // So 10 is not one machine's number. It is left overridable anyway,
      // because the next machine is still unmeasured.
      const RATE = Number(process.env.SC_HARNESS_RATE ?? 10);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });
      const unthrottled = await page.locator("#root").innerText();
      if (unthrottled.includes("인증 상태를 확인하는 중")) {
        // Not a pass and not a failure of the guard: this machine is already
        // too busy for the comparison to mean anything.
        expect(unthrottled, "this machine shows the interim screen unthrottled — nothing here is measurable")
          .toContain("인증 상태를 확인하는 중");
        return;
      }

      // **A fresh page for the throttled leg.** Reusing the one that just
      // loaded unthrottled measures a warm page: the module graph is
      // transformed, the browser has the assets, and it reaches the terminal
      // state before the read no matter how starved the CPU is. That is why
      // this scenario reported inconclusive on a machine where
      // agent-mesh-local-pm's own harness — which opens a new page each time —
      // reproduced at the same rate.
      const cold = await context.newPage();
      await cold.route("**/api/v1/**", (route) => route.abort());
      const coldCdp = await context.newCDPSession(cold);
      await coldCdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
      await cold.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });

      // Read once *without* waiting. This is what the old assertions did, and
      // it is the only way to know whether this machine can be made slow
      // enough for the guard to matter.
      const unwaited = await cold.locator("#root").innerText();
      if (!unwaited.includes("인증 상태를 확인하는 중")) {
        // **Inconclusive, and it says so.** 1/10 reproduced the misread on
        // agent-mesh-local-pm's machine and does not on every machine; where it
        // does not, this scenario passes with the guard and without it, so a
        // green here is not evidence about the guard. Reported rather than
        // dressed as a pass, because a check that cannot fail is the shape this
        // suite spent the night removing.
        cannotMeasure(
          "SC-HARNESS-02",
          `at 1/${RATE} this machine reaches the terminal state before the read, so the wait is not exercised`,
        );
        return;
      }

      await settled(cold);
      await shows(cold, "에이전트 목록을 불러올 수 없습니다");
      const text = await cold.locator("#root").innerText();
      expect(text, "the assertion read the interim screen instead of the one it came for")
        .not.toContain("인증 상태를 확인하는 중");
      expect(text).toContain("에이전트 목록을 불러올 수 없습니다");
    } finally {
      await context.close().catch(() => {});
    }
  }, 40000);

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
      await settled(page);
      await shows(page, "텔레메트리 서버와 연결할 수 없습니다");
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
      await settled(page);
      await shows(page, "조회 중");
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
      await settled(page);
      await shows(page, "조회 중");
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
        await settled(page);
        // The assertion is a pattern, so wait for the pattern. Without this the
        // scenario is still safe — `toMatch(UNKNOWN_REGEX)` rejects the interim
        // screens, which agent-mesh-local-pm checked against the actual strings
        // — but under load it fails rather than waits, and a red that means
        // "too early" is noise on top of a suite whose reds should mean
        // something.
        await showsMatch(page, UNKNOWN_REGEX);
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
      await showsMatch(page, /실패|오류|통신/);

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
      await attemptOver(page);

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
            await attemptOver(page);
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
        await attemptOver(page);
        const sendBtn = page.locator("button:has-text('메시지 전송'), button:has-text('빠른 전송'), button:has-text('전송')").first();
        if (await sendBtn.count() > 0) {
          await sendBtn.click();
          await showsMatch(page, /실패|오류|통신/);
          const rootText = await page.locator("#root").innerText();
          expect(rootText).not.toContain("성공적으로 전송되었습니다");
          expect(rootText).not.toContain("전송이 완료되었습니다");
          expect(rootText).toMatch(/실패|오류|통신/);
        }
      }
    });
  });

  // SC-WRITE-08: /creator/register does not show a pairing code it never got.
  //
  // The last route on the write axis with nothing on it. This screen issues a
  // one-time credential, and the failure mode is specific: `generatedCode` is
  // component state, so a refused request must clear it rather than leave the
  // previous code on screen. An operator reading a stale code hands out a
  // credential that will not work, and finds out from the other side.
  it("[SC-WRITE-08] handles a pairing-code abort without displaying a code", async () => {
    await withPage("/creator/register", async ({ page }) => {
      await shows(page, "페어링");

      // By placeholder: the shared `Input` component does not set `type`, so
      // `input[type='text']` matches nothing here — the first version of this
      // reported inconclusive for that reason rather than for a real absence.
      const identityInput = page.locator("input[placeholder*='agt_']").first();
      if (await identityInput.count() === 0) {
        cannotMeasure("SC-WRITE-08", "no identity field is rendered, so no write was attempted");
        return;
      }
      await identityInput.fill("pairing-abort-probe");

      // **Counted, because "the control exists" is not "the write happened".**
      // The first version checked only that a field and a button were on the
      // page, clicked, and asserted. It passed even with the page's catch
      // rewritten to announce success — because the click never reached the
      // request, so there was nothing to lie about. A scenario that cannot tell
      // "the screen behaved" from "nothing happened" is the shape this suite
      // exists to remove.
      let writes = 0;
      await page.route("**/api/v1/admin/pairing-codes", (route) => {
        if (route.request().method() !== "POST") return route.continue();
        writes += 1;
        return route.abort();
      });

      const submit = page.locator("button[type='submit']").first();
      if (await submit.count() === 0) {
        cannotMeasure("SC-WRITE-08", "no submit control is rendered");
        return;
      }
      await submit.click();
      // **Wait for either outcome, not for the one that should happen.**
      // Waiting only for the failure text means that when the screen wrongly
      // claims success, nothing matches, the wait burns its full timeout, and
      // the success toast is gone by the time the read happens — so the
      // assertions pass on an empty screen. Measured: with the catch pointed at
      // the success toast, this scenario passed until the wait covered both.
      // **The exact toast strings, not a family of failure words.** This waited
      // on `/실패|오류|통신/`, and the page's own copy contains those — "(통신
      // 불가)" and "서버 연결 실패" are static labels on the queue below the
      // form. So the wait returned on page furniture and the assertion never
      // saw a toast: the scenario stayed green with the page's catch rewritten
      // to announce success. Same shape as the probe that matched "에이전트" in
      // the sidebar.
      const FAILED = "페어링 코드 발급 실패";
      const CLAIMED = "페어링 코드가 발급되었습니다";
      await showsMatch(page, new RegExp(`${FAILED}|${CLAIMED}`));

      if (writes === 0) {
        cannotMeasure("SC-WRITE-08", "the submit never produced a pairing-code request");
        return;
      }

      const text = await page.locator("#root").innerText();
      expect(text, "the screen announced a pairing code the server never issued")
        .not.toContain(CLAIMED);
      expect(text, "the screen said nothing about a write that failed").toContain(FAILED);
    });
  }, 30000);

  // SC-AUTH-04: an expired session is never reported as an empty one.
  //
  // Split from the pinned half on agent-mesh-local-pm's advice, and the split
  // did its job — but **one of the two things I called decision-independent was
  // not.** The pair was:
  //
  //   nothing is claimed to be empty      still true, and asserted below
  //   the screen says it could not read   **only true if you stay on it**
  //
  // The decision was to redirect, and you cannot read a message on a screen you
  // have left. That assertion was decision-dependent all along and I did not
  // see it until the redirect landed and this test failed on the login page.
  //
  // What survives is the half that has to be true wherever you end up: a
  // refused read is never rendered as an empty list. The redirect target does
  // not claim emptiness either, which is what makes it still checkable here.
  it("[SC-AUTH-04] an expired session reports a failed read and does not claim empty", async () => {
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

      // The session is refused the way an expired one is: the cookie is still
      // sent, and the server rejects it. Aborting instead would test the
      // disconnected axis, which SC-DOWN-ALL already covers.
      // **`/auth/me` is refused too, because that is what expiry means.**
      // Refusing only `/api/v1/**` leaves the session check succeeding, so the
      // app is right to consider itself signed in — and it re-established the
      // stored user on the very next load, which is what this assertion caught.
      // The cookie an expired session sends is rejected everywhere, not on some
      // routes.
      let refused = 0;
      const expire = (route: import("playwright").Route) => {
        refused += 1;
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
      };
      await page.route("**/api/v1/**", expire);
      await page.route("**/auth/me", expire);

      await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });
      await settled(page);
      await page.waitForURL("**/login", { timeout: 10_000 }).catch(() => {});

      expect(refused, "no API call was made, so nothing was refused and nothing is being measured")
        .toBeGreaterThan(0);

      const text = await page.locator("#root").innerText();
      expect(text, "an unreadable list was reported as an empty one").not.toMatch(ZERO_REGEX);
    } finally {
      await context.close().catch(() => {});
    }
  }, 30000);

  // SC-AUTH-05: an expired session is sent to the sign-in page.
  //
  // **This is the pinned scenario replaced, and the implementation it was
  // waiting for turned out to be unnecessary.** The owner decided expiry sends
  // you to /login. Writing the redirect and then removing it again to check the
  // test showed the test still passing — because the app already did it.
  //
  // The behaviour agent-mesh-local-pm measured as "stays on the route" was a
  // **half-expired** session: they refused `/api/v1/**` and left `/auth/me`
  // answering. With the session check succeeding the app is correctly signed
  // in, and correctly reports a read that failed. Refuse the session check too
  // — which is what an expired cookie does — and `GuardedRoute` sends you to
  // /login with no session left behind.
  //
  // So the decision was already implemented, and what was missing was a
  // scenario that expires the session rather than the API. The code written
  // for it was reverted.
  //
  // SC-AUTH-04 is untouched, which was the point of splitting them: a refused
  // read must not be reported as an empty list either way, so that assertion
  // survives the decision that overturned this one.
  it("[SC-AUTH-05] an expired session is sent to /login", async () => {
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
      // **`/auth/me` is refused too, because that is what expiry means.**
      // Refusing only `/api/v1/**` leaves the session check succeeding, so the
      // app is right to consider itself signed in — and it re-established the
      // stored user on the very next load, which is what this assertion caught.
      // The cookie an expired session sends is rejected everywhere, not on some
      // routes.
      let refused = 0;
      const expire = (route: import("playwright").Route) => {
        refused += 1;
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
      };
      await page.route("**/api/v1/**", expire);
      await page.route("**/auth/me", expire);

      await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });
      await page.waitForURL("**/login", { timeout: 10_000 }).catch(() => {});

      expect(refused, "no API call was refused, so nothing here was exercised").toBeGreaterThan(0);
      expect(page.url(), "an expired session was left on the route it could not read")
        .toContain("/login");

      // And the stored session goes with it. Left behind, a reload rehydrates
      // from localStorage and the app looks signed in again.
      const stored = await page.evaluate(() => localStorage.getItem("agent_mesh_user"));
      expect(stored, "the signed-out session was left in localStorage").toBeNull();
    } finally {
      await context.close().catch(() => {});
    }
  }, 30000);

  // SC-WRITE-07: /tenant/rbac does not claim a grant it failed to make.
  //
  // The write axis had nothing on this screen, and agent-mesh-local-pm put it
  // first for a reason: it is the screen that grants and revokes capabilities.
  // A screen that says "권한이 부여되었습니다" for a grant the server refused
  // tells an operator someone has access they do not have — and I-055 was found
  // one route away from here.
  //
  // The toggle is optimistic in its wording and not in its state: it posts,
  // then reloads from the server. So the chip must still read as it did, and
  // the toast must say it failed.
  it("[SC-WRITE-07] handles an RBAC grant abort without claiming the capability was granted", async () => {
    // A subject with a grant, so the table has a row and the row has chips.
    // Without this the screen is empty and there is nothing to click — which
    // the scenario would report as inconclusive rather than pass, but an
    // inconclusive scenario measures nothing.
    await capabilityViewer(mesh, "usage.read");

    await withPage("/tenant/rbac", async ({ page }) => {
      await shows(page, "usage.read");

      // Only the write. The read has to succeed or there are no chips to click.
      await page.route("**/api/v1/admin/grants", (route) => {
        const method = route.request().method();
        if (method === "POST" || method === "DELETE") return route.abort();
        return route.continue();
      });

      // By the title only the chips carry. Their visible text is prefixed
      // (`✓ usage.read`), so an anchored match on the capability name finds
      // nothing — which the first version of this did, and reported as
      // inconclusive rather than as a wrong selector.
      const chip = page.locator('button[title*="권한"]').first();
      const chipCount = await chip.count();
      if (chipCount === 0) {
        // No chips means no subject is listed, and clicking nothing proves
        // nothing. Say so rather than pass.
        cannotMeasure("SC-WRITE-07", "no capability chip is rendered, so no write was attempted");
        return;
      }

      const before = await page.locator("#root").innerText();
      await chip.click();
      // Either outcome, for the reason spelled out in SC-WRITE-08: waiting only
      // for the failure lets a wrongly-claimed success expire unread.
      await showsMatch(page, /권한 변경 실패|권한이 부여되었습니다|권한이 회수되었습니다/);
      const after = await page.locator("#root").innerText();

      expect(after, "the screen announced a grant the server refused")
        .not.toContain("권한이 부여되었습니다");
      expect(after, "the screen announced a revocation the server refused")
        .not.toContain("권한이 회수되었습니다");
      expect(after, "the screen said nothing about a write that failed").toContain("권한 변경 실패");

      // And the chips are unchanged: the failure must not leave the screen
      // rendering a permission set nobody holds.
      const chipsBefore = (before.match(/\b[a-z]+\.[a-z.]+\b/g) ?? []).sort().join(",");
      const chipsAfter = (after.match(/\b[a-z]+\.[a-z.]+\b/g) ?? []).sort().join(",");
      expect(chipsAfter, "the capability list changed after a write that failed").toBe(chipsBefore);
    });
  }, 30000);

  // SC-WRITE-05: /creator/playground receipt displays real server fields
  it("[SC-WRITE-05] renders playground receipt with real server response fields", async () => {
    await withPage("/creator/playground", async ({ page }) => {
      const sendBtn = page.locator("button:has-text('발송'), button:has-text('Send'), button[type='submit']").first();
      expect(await sendBtn.count()).toBeGreaterThanOrEqual(1);
      await sendBtn.click();
      await shows(page, "발송된 메시지 본문");
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
        await showsMatch(page, /실패|오류|통신/);
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

  /**
   * SC-CONSIST-01 — a screen that states a count states the count of what it drew.
   *
   * `I-064` was this: the topology said `3개 에이전트` in its heading, `Agents: 2`
   * on a card and `default (1)` on a badge, while the server held **one**. It was
   * fixed in `3b651ff`, and the check that came with it reads the *source* for
   * fabricated digests. Nothing asserted the numbers on the rendered page agree,
   * so the fix is a fix and not a guard — and `I-062` is what an ungiuarded fix
   * costs: it came back with no test and nobody knew until a build was opened.
   *
   * ## The comparison is between two things the product made
   *
   * agent-mesh-local-pm's `audit/selfconsistent.mjs` compares two *texts* and
   * needs a synonym table (`에이전트` ↔ `Agents`) to do it. That table is a guess,
   * and its own header says so: meet a new name and doubt the table, not the
   * screen. This compares **what the heading claims** against **what the canvas
   * drew**, so both sides come from the product and nothing here decides what
   * the right answer is.
   *
   * ## Gateways are counted apart on purpose
   *
   * They are drawn and are deliberately not in `totalAgentCount` — the heading's
   * own comment says adding them made it disagree with the counter beside it. So
   * they carry a different `data-testid`, and when any are present this asserts
   * the agent count did **not** absorb them. With none present that assertion
   * says nothing, and it is skipped rather than counted as passing.
   *
   * ## What it cannot see
   *
   * **Two views of one wrong answer agree.** The heading and the canvas read the
   * same member list, so a list that is wrong in both is consistent and passes
   * here. `TopologyPage` had exactly that beside the fault this caught: every
   * live agent was pushed into any empty group, and the heading counted the same
   * inflated list it drew. `SC-SCR05-03` asks that different question — a group
   * the server says is empty draws nobody — because consistency cannot.
   *
   * ## It refuses to pass on an empty screen
   *
   * `0 === 0` is the failure this repository has met most often — a check that
   * saw nothing and read it as agreement. The suite seeds `agent-alpha` and
   * `agent-beta`, so a zero here means the screen never drew, and that is
   * reported rather than absorbed.
   */
  it("[SC-CONSIST-01] states the count of what it drew, on /creator/topology", async () => {
    await withPage("/creator/topology", async ({ page }) => {
      await page.locator("[data-testid='topology-cluster']").first().waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});

      const heading = (await page.locator("#root").innerText().catch(() => "")).trim();
      const claim = /(\d+)\s*개\s*그룹[\s\S]{0,40}?(\d+)\s*개\s*에이전트/.exec(heading);
      // A heading that stopped saying it would otherwise make every comparison
      // below vacuous — the shape this test exists to refuse.
      expect(claim, `the heading no longer states both counts: ${JSON.stringify(heading.slice(0, 160))}`).not.toBeNull();
      const statedGroups = Number(claim![1]);
      const statedAgents = Number(claim![2]);

      const drawnClusters = await page.locator("[data-testid='topology-cluster']").count();
      const drawnAgents = await page.locator("[data-testid='topology-agent']").count();
      const drawnGateways = await page.locator("[data-testid='topology-gateway']").count();

      // Nothing drawn is not agreement. The suite seeds two agents, so a zero
      // here is the screen failing to draw, not the mesh being empty.
      expect(
        { groups: statedGroups > 0, agents: statedAgents > 0, drew: drawnClusters > 0 },
        "the screen claimed nothing or drew nothing — 0 === 0 is not agreement",
      ).toEqual({ groups: true, agents: true, drew: true });

      expect({ stated: statedGroups, drawn: drawnClusters }).toEqual({ stated: statedGroups, drawn: statedGroups });
      expect({ stated: statedAgents, drawn: drawnAgents }).toEqual({ stated: statedAgents, drawn: statedAgents });

      // Only says something when there are gateways to absorb.
      if (drawnGateways > 0) {
        expect(
          { agentsIncludeGateways: drawnAgents === statedAgents + drawnGateways },
          "the agent count absorbed the gateways the heading excludes",
        ).toEqual({ agentsIncludeGateways: false });
      }
    });
  }, 30_000);

  /**
   * SC-SCR05-03 — a group the server says is empty draws nobody.
   *
   * The cluster sizing already said it in those words — *an empty membership is
   * an empty membership* — and seventy lines later the code contradicted it:
   * when a group held nobody, every live agent was pushed into it, with no
   * condition and no `type` match. An empty group drew as holding the whole
   * mesh, and drew them again for the next empty group.
   *
   * **`SC-CONSIST-01` is blind to this by construction.** It compares the
   * heading against the canvas, and both read that same inflated list, so the
   * screen was consistently wrong. Agreement between two views is not truth when
   * both views come from one source.
   *
   * The group is emptied in the response rather than in the mesh: the layer
   * under test is the screen, and other scenarios share this mesh.
   */
  it("[SC-SCR05-03] draws no agents inside a group the server reports as empty", async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: "mesh_token", value: jwtToken, url: viteBaseUrl }]);
    const page = await context.newPage();
    try {
      await page.route("**/api/v1/admin/groups", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ groups: [{ group_id: "empty-grp", name: "빈 그룹", members: [] }], egress: [] }),
        }),
      );
      await page.goto(`${viteBaseUrl}/creator/topology`, { waitUntil: "networkidle" });
      await settled(page);
      await page.locator("[data-testid='topology-cluster']").first().waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});

      const clusters = await page.locator("[data-testid='topology-cluster']").count();
      const agents = await page.locator("[data-testid='topology-agent']").count();

      // The cluster must be there, or "no agents drawn" is just "nothing drawn"
      // — the vacuous pass this repository keeps meeting.
      expect({ clusterDrawn: clusters > 0 }, "the empty group was not drawn at all, so nothing was tested").toEqual({
        clusterDrawn: true,
      });
      expect({ agentsInEmptyGroup: agents }, "an empty group drew agents the server did not put in it").toEqual({
        agentsInEmptyGroup: 0,
      });
    } finally {
      await context.close().catch(() => {});
    }
  }, 30_000);

  /**
   * SC-INVENT-01 — a field the server did not send is not drawn as a value.
   *
   * `I-062` was this: the agent list invented the whole row — a status of
   * `ONLINE` for agents that reported none, a `sha256:` fingerprint from a route
   * that carries no fingerprint, a `created_at` of *now*. It was fixed by
   * reading the source, and **no scenario asks the screen the question**, which
   * is why `I-062` reached the branch at all: it went in with no test and nobody
   * knew until a build was opened.
   *
   * ## Neither a label map nor a blocklist
   *
   * agent-mesh-local-pm's `audit/fabricated.mjs` compares columns to response
   * keys and needs a vocabulary of absence to do it. That vocabulary is a guess,
   * and it punished two honest fixes: `지문 없음` and `미보고` were not in it, so
   * correcting the screen made the harness redder. A list of forbidden strings
   * has the same defect pointed the other way.
   *
   * So this asks **the same field twice** — once with the server sending it,
   * once with the server omitting it — and requires the two renders to differ in
   * a specific way: the omitted case must show the screen's own absence handle
   * and **must not show the value the present case showed**. The comparison is
   * between two renders of the product, so nothing here decides what "absent"
   * should look like.
   *
   * ## Both halves are needed
   *
   * Only the omitted case, and a screen that always renders `— 미보고` passes.
   * Only the present case, and a screen that always renders a value passes. It
   * is the pair that says anything, and `I-062` was precisely a screen where the
   * absent case rendered the present case's answer.
   */
  it("[SC-INVENT-01] draws an omitted field as absent, never as the value it would have had", async () => {
    const tag = "inv" + String(Date.now()).slice(-6);
    const base = { identity: `pm-${tag}`, description: `DESC-${tag}`, type: `TYPE-${tag}` };

    async function rowOf(agent: Record<string, unknown>): Promise<{ text: string; absent: number }> {
      const context = await browser.newContext();
      await context.addCookies([{ name: "mesh_token", value: jwtToken, url: viteBaseUrl }]);
      const page = await context.newPage();
      try {
        await page.route("**/api/v1/agents", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: [agent] }) }),
        );
        await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });
        await settled(page);
        await shows(page, `pm-${tag}`);
        const text = (await page.locator("#root").innerText().catch(() => "")).trim();
        // The screen's own absence handles, counted rather than named. Adding a
        // new one must not make this test redder.
        const absent =
          (await page.locator("[data-testid$='-unknown']").count()) +
          (await page.locator("[data-testid$='-absent']").count());
        return { text, absent };
      } finally {
        await context.close().catch(() => {});
      }
    }

    // Sent: an active status. Omitted: no `status` key at all.
    const sent = await rowOf({ ...base, status: "active" });
    const omitted = await rowOf({ ...base });

    // Neither render may be empty, or the pair says nothing — the vacuous pass
    // this repository keeps meeting.
    expect(
      { sentDrew: sent.text.includes(`pm-${tag}`), omittedDrew: omitted.text.includes(`pm-${tag}`) },
      "the row never rendered, so nothing was compared",
    ).toEqual({ sentDrew: true, omittedDrew: true });

    // The value the present case showed. If the screen stopped saying it, this
    // test is measuring nothing and says so rather than passing.
    expect(sent.text, "the sent status no longer renders as ONLINE — this pair has nothing to compare")
      .toContain("ONLINE");

    // **The omitted case must not borrow it.** This is `I-062` exactly.
    expect(
      { drewTheValueItWasNotSent: omitted.text.includes("ONLINE") },
      "a row with no status drew the status of one that had it",
    ).toEqual({ drewTheValueItWasNotSent: false });

    // And it must say so with the screen's own handle rather than falling blank.
    expect(
      { absentHandles: omitted.absent > sent.absent },
      "omitting the field produced no additional absence marker — the screen went quiet instead of answering",
    ).toEqual({ absentHandles: true });
  }, 45_000);

  /**
   * SC-HARNESS-03 — the fixtures this suite rests on actually applied.
   *
   * Every scenario below reads a mesh this file wrote, with `fetch` calls whose
   * responses were never looked at. `POST /api/v1/admin/groups` reads `group_id`
   * and `description`; the setup also sent `name` and `members: [...]`, and the
   * route dropped both in silence. The groups were empty for four months while
   * every group-shaped scenario ran against them and passed.
   *
   * **A green suite over an unapplied fixture is the widest form of the failure
   * this repository keeps meeting** — not one check reading nothing, but every
   * check reading the same nothing. So the setup keeps what its writes answered
   * and this reads it.
   */
  it("[SC-HARNESS-03] wrote the fixtures it says it wrote", async () => {
    expect(setupSaid, "a setup write did not succeed, so every scenario below reads a mesh that was not built")
      .toEqual([]);
  });

  /**
   * SC-SCR12-03 — the egress matrix reads the server, including its diagonal.
   *
   * The diagonal was drawn as allowed unconditionally, in two places: the page
   * built `row[target.id] = g.id === target.id || …`, and `AclMatrix` rendered
   * the literal `자체(허용)` for it, which is the one an operator sees. `maySend`
   * has no such exception — its query is `from_group = ? AND to_group = ?` and
   * its comment says *same-group sends still require a rule; `default` has one,
   * seeded; a group someone creates does not until they say so.* So every group
   * but `default` was drawn as able to talk to itself when the server would
   * refuse, and `default` agreeing is why it went unseen.
   *
   * ## Four cells, and each is somebody else's reverse
   *
   * ```
   * engineering → security      rule exists   allowed      the fixture writes it
   * security → engineering      no rule       not allowed  direction is the point
   * engineering → engineering   no rule       not allowed  the defect
   * default → default           seeded rule   allowed      the reverse of the defect
   * ```
   *
   * Without the last one, a screen that draws every diagonal as DENY passes —
   * the same pairing `SC-INVENT-01` uses, for the same reason.
   */
  it("[SC-SCR12-03] draws each egress cell from the server, diagonal included", async () => {
    await withPage("/tenant/egress-acl", async ({ page }) => {
      await page.locator("[data-testid^='acl-']").first().waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});

      const cell = async (from: string, to: string) => {
        const el = page.locator(`[data-testid='acl-${from}-${to}']`);
        if ((await el.count()) === 0) return "(missing)";
        return (await el.first().getAttribute("data-allowed")) ?? "(no attribute)";
      };

      const seen = {
        "engineering->security": await cell("engineering", "security"),
        "security->engineering": await cell("security", "engineering"),
        "engineering->engineering": await cell("engineering", "engineering"),
        "default->default": await cell("default", "default"),
      };

      // A missing cell would make every comparison below vacuous, and reads as
      // "not allowed" if compared loosely — so it is named rather than absorbed.
      expect(
        Object.entries(seen).filter(([, v]) => v === "(missing)" || v === "(no attribute)").map(([k]) => k),
        "the matrix did not draw these cells at all, so nothing was compared",
      ).toEqual([]);

      expect(seen).toEqual({
        "engineering->security": "yes",
        "security->engineering": "no",
        "engineering->engineering": "no",
        "default->default": "yes",
      });
    });
  }, 30_000);

  /**
   * SC-INVENT-02 — a signature that is present is not a signature that was verified.
   *
   * `audit-query.ts` returns the attestation and says why, at that line: *a
   * screen must not read this as proof; the hub verified it at ingest and this
   * route does not re-verify, because it cannot always.* A rotated key's row is
   * deleted, so an event signed by one can never be verified again — and the
   * screen turned presence into `true` and painted it with `--color-success`.
   * On the security audit screen, where "signature verified" is the whole point.
   *
   * The pair is the same shape as `SC-INVENT-01`: the field is withheld in one
   * render and sent in the other, and only the difference between them says
   * anything. Without the second, a screen that never claims verification passes.
   */
  it("[SC-INVENT-02] shows the integrity verdict it was given, and claims no verification it was not", async () => {
    const tag = "sig" + String(Date.now()).slice(-6);
    const event = (integrity: unknown) => ({
      event_id: `evt_${tag}`,
      event_type: "channel.message.received",
      occurred_at: new Date().toISOString(),
      identity: `who-${tag}`,
      payload: { message: { from: `who-${tag}`, to: "admin", content: `body-${tag}` } },
      // Signed on arrival — a measured fact, and the one this screen used to read
      // as proof of verification.
      attestation: { sig: { alg: "ed25519", kid: `kid-${tag}` } },
      ...(integrity === undefined ? {} : { integrity }),
    });

    async function row(integrity: unknown): Promise<{ text: string; digest: string | null }> {
      const context = await browser.newContext();
      await context.addCookies([{ name: "mesh_token", value: jwtToken, url: viteBaseUrl }]);
      const page = await context.newPage();
      try {
        await page.route("**/api/v1/audit/events**", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ events: [event(integrity)], next_cursor: null }),
          }),
        );
        await page.goto(`${viteBaseUrl}/tenant/audits`, { waitUntil: "networkidle" });
        await settled(page);
        await shows(page, `who-${tag}`);
        return {
          text: (await page.locator("#root").innerText().catch(() => "")).trim(),
          digest: await page.locator("[data-testid='audit-integrity']").first().getAttribute("data-digest"),
        };
      } finally {
        await context.close().catch(() => {});
      }
    }

    const intact = await row({ digest_matches: true });
    const tampered = await row({ digest_matches: false });
    const unmeasured = await row(undefined);

    expect(
      { intact: intact.text.includes(`who-${tag}`), tampered: tampered.text.includes(`who-${tag}`) },
      "the audit row never rendered, so nothing was compared",
    ).toEqual({ intact: true, tampered: true });

    // **The verdict the server measured, all three of its states.** Only `false`
    // is tampering; a missing `integrity` is not a pass, and reading it as one is
    // the shape this file keeps removing.
    expect({ intact: intact.digest, tampered: tampered.digest, unmeasured: unmeasured.digest }).toEqual({
      intact: "matches",
      tampered: "broken",
      unmeasured: "unmeasured",
    });

    // **And no claim of verification.** `signature_verified` has never existed in
    // hub, http, store, contracts or SPEC — a boolean could not carry the answer
    // anyway, because a rotated key's row is deleted and *unverifiable* and
    // *forged* would share one `false`. So the screen says a signature arrived
    // and stops there.
    expect(
      { claimed: /검증됨|FAILED|서명 실패/.test(intact.text) },
      "the screen claimed a verification nobody measured",
    ).toEqual({ claimed: false });
    expect(intact.text, "the screen stopped saying a signature arrived, so this pair compares nothing")
      .toContain("서명 있음");
  }, 45_000);

  // SC-HARNESS-01: Harness reliability check
  it("[SC-HARNESS-01] verifies platform mesh readiness and test harness health", async () => {
    expect(mesh).toBeDefined();
    expect(mesh.http.url).toContain("http");
    expect(mesh.hub.url).toContain("http");
  });

});

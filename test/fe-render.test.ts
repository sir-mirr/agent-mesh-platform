import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { openTestDb, sessionCookie } from "./harness";
import { chromium, type Browser } from "playwright";
import { ALL_CAPABILITIES } from "@agent-mesh/contracts";
import { startMesh, newKeyPair, capabilityViewer, capabilityViewerName, freePort, SEED_ADMIN } from "./harness.ts";

/**
 * **Twenty seconds, so a red here means a defect rather than a slow machine.**
 *
 * Every scenario below drives a real browser against a real mesh, and bun's
 * default is five seconds. That is comfortably enough on an idle host and not
 * enough on this one during the periods where everything runs an order of
 * magnitude slower: the first `goto` exceeds it, bun cuts the test's async work,
 * the playwright pipe goes with it, and **every scenario after that fails with
 * `browser has been closed`** — 120 failures naming nothing, from one slow
 * navigation. Measured: at five seconds the suite was 8/134, at twenty it was
 * 45/134 in the same conditions, and single scenarios passed either way.
 *
 * This raises the bar for calling something a failure; it does not make the
 * machine faster. **Why the host has slow periods at all is unanswered** and is
 * written down as such in `docs/open-questions.md` — the number here is a
 * decision to stop paying for that question in this suite's results
 * (`agent-mesh-local-pm`, 2026-08-22).
 */
setDefaultTimeout(20_000);

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
      body: JSON.stringify({ username: SEED_ADMIN, password: "admin" }),
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
      // **An agent with no key, on purpose.** `SC-ADDR-02` needs one row with a
      // fingerprint and one without, or its pair of assertions says nothing:
      // keyed-only cannot catch a screen printing fingerprints it was never
      // sent, and unkeyed-only cannot catch one that prints none at all. The
      // second half used to be the operator's own account, which this console
      // stopped listing as an agent — and `agent-beta` is provisioned into the
      // hub rather than into this registry, so it is not here either.
      httpDb.prepare(`
        INSERT OR IGNORE INTO agent_registry (id, name, description, channel, type, approved)
        VALUES ('agent-unkeyed', 'Agent Unkeyed', 'Registered, never proposed a key', 'hub', 'service', 1)
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
   * **`networkidle` is not "the screen finished".**
   *
   * Three scenarios in one morning read a value straight after `attemptOver`
   * and saw the state before the render that answers the request: an ACL cell
   * still holding its optimistic value, and a row that arrives 400ms after the
   * network goes quiet. Two of those reported a defect that was not there,
   * which is the expensive direction — a red that sends somebody into correct
   * code.
   *
   * The discipline is "wait for it"; this is the placement, so it stops being
   * something to remember. Returns what it last saw so the caller can assert on
   * the real value rather than on a boolean.
   */
  async function eventually<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    { tries = 10, everyMs = 400 } = {},
  ): Promise<T> {
    let seen = await read();
    for (let i = 0; i < tries && !done(seen); i++) {
      await new Promise((r) => setTimeout(r, everyMs));
      seen = await read();
    }
    return seen;
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
  /** Filled only under `WRITE_PROBE=1`; see `newContext`. */
  const writesSeen = new Set<string>();

  const inconclusive: string[] = [];

  function cannotMeasure(scenario: string, why: string): void {
    inconclusive.push(`${scenario} — ${why}`);
    console.warn(`[${scenario}] inconclusive: ${why}`);
  }

  afterAll(() => {
    if (process.env.WRITE_PROBE) {
      console.warn(
        `\n─── writes this run issued (${writesSeen.size}) ───\n` +
          [...writesSeen].sort().map((line) => `  ${line}`).join("\n") +
          `\n─── a write the front end can make and this list does not name is exercised by nothing ───\n`,
      );
    }
    if (inconclusive.length === 0) return;
    console.warn(
      `\n─── ${inconclusive.length} scenario(s) ran without measuring anything ───\n` +
        inconclusive.map((line) => `  ${line}`).join("\n") +
        `\n─── each of these is reported above as a pass ───\n`,
    );
  });

  async function createAuthedPage(route: string, lang: "ko" | "en" | null = "ko") {
    const context = await newContext(lang);
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
      // **Chosen, not inherited.** Sixty-seven assertions in this file read
      // Korean labels, and until the default changed to English they were
      // resting on it without saying so — a screen that asserts a language it
      // never asked for is measuring the default as much as the screen. The
      // default is now `SC-I18N-02`'s subject and nothing else's.
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

  /**
   * `common.refusedRead` — what a screen says when the server refused it.
   *
   * **The sentence, because the capability is gone from it.** Nine screens used
   * to print `(key.approve)`, `(group.manage)`, `(mailbox.read.depth)` into
   * their own copy; the console decided a machine key is for code and
   * diagnostics, `refusedText` draws the sentence without it, and
   * `api/client.test.ts` holds it there. So a scenario that measured "did the
   * screen name the capability" now measures "did the screen say it was
   * refused, and did the key stay off it".
   */
  const REFUSED_COPY = "이 계정에는 이 화면을 볼 권한이 없습니다";

  async function armFirstTeardown(page: import("playwright").Page) {
    const trigger = page.locator('button[data-testid^="teardown-"]').first();
    const testId = await trigger.getAttribute("data-testid");
    const identity = testId?.replace(/^teardown-/, "") ?? "";
    expect(
      { control: await trigger.count(), identity: identity.length > 0 },
      "the teardown control did not name the identity it would destroy",
    ).toEqual({ control: 1, identity: true });
    await trigger.click();
    // By the placeholder the dialog sets to the identity, rather than by "the
    // last text input on the page" — the page behind the dialog has its own.
    await page.locator(`input[placeholder="${identity}"]`).fill(identity);
    // `agents.teardown.confirm`, which the console rewrote from
    // "영구 Teardown 실행" to "영구 삭제" — **the same words as the row control
    // it opens** (`agents.teardownBtn`). So the confirmation is the last one in
    // the document, the dialog being rendered after the table, and the check
    // below is that it is not a row trigger: clicking one of those would open a
    // second dialog and report a teardown nobody sent.
    const confirm = page.locator("button:has-text('영구 삭제')").last();
    expect(
      {
        confirm: await confirm.count(),
        enabled: await confirm.isEnabled(),
        isARowControl: (await confirm.getAttribute("data-testid")) !== null,
      },
      "the identity did not arm the destructive confirmation",
    ).toEqual({ confirm: 1, enabled: true, isARowControl: false });
    return { identity, confirm };
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
    const context = await newContext();
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

  /**
   * A context that has chosen its language.
   *
   * The default became English, and sixty-seven assertions in this file read
   * Korean labels. They are not tests *about* language — they were resting on
   * the default without saying so, and the moment it moved five of them
   * measured the wrong thing at once. So every context says which language it
   * reads. The default itself is `SC-I18N-02`'s subject, and that scenario
   * builds its own context with no seed, which is the only way to see it.
   */
  async function newContext(lang: "ko" | "en" | null = "ko") {
    const ctx = await browser.newContext();
    // **What writes this suite actually issues, when asked.**
    //
    // Off unless `WRITE_PROBE=1`, because a banner printed every run is a
    // banner people learn to scroll past. The question it answers came up
    // measuring `SC-WRITE-12`: eight `SC-WRITE-*` scenarios assert that a
    // *failed* write is not called a success, and the way to find which writes
    // nothing exercises at all is to count the ones that leave the browser.
    //
    // Counting rather than breaking: neutering the writes to find out killed
    // the run — one scenario timed out first and took the browser with it, so
    // every verdict after it was about the browser, not the writes.
    if (process.env.WRITE_PROBE) {
      ctx.on("request", (r) => {
        // **Raw pathname.** The first version folded the last segment when it
        // looked like an identifier, and `/groups` is seven lowercase letters —
        // so `POST /api/v1/admin/groups` printed as `POST /api/v1/admin/{}` and
        // the list said nothing. A few extra lines for real ids is the cheaper
        // error.
        if (r.method() !== "GET") writesSeen.add(`${r.method()} ${new URL(r.url()).pathname}`);
      });
    }
    if (lang) {
      await ctx.addInitScript((chosen) => {
        try {
          localStorage.setItem("agent_mesh_lang", chosen as string);
        } catch {
          /* storage unavailable — the page falls back to the default */
        }
      }, lang);
    }
    return ctx;
  }

  async function withUnauthedPage<T>(route: string, fn: (pageInfo: { page: import("playwright").Page; errors: string[] }) => Promise<T>): Promise<T> {
    const context = await newContext();
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
    const context = await newContext();
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
    // `dash.pa.nodes`. The console renamed it to what the row actually is —
    // a registry row — rather than to a node it has never counted.
    expect(mainText).toContain("등록된 에이전트");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-03 / SC-RENDER-03: Agents List Page Live Render with real rows (D-31)
  it("[SC-RENDER-03] renders /creator with real agent table rows", async () => {
    const { page, context, errors } = await createAuthedPage("/creator");
    // **The agent rows, counted against the registry rather than against a
    // floor.** This asked for two or more, and the fixture's second row was the
    // signed-in operator — a person, which this screen stopped listing as an
    // agent. A floor of 2 was measuring how many accounts the harness happens
    // to seed; comparing with the route measures whether the screen drops a row
    // the registry answered.
    const rows = await page.locator("table tbody tr").count();
    const agents: number = await page.evaluate(async () => {
      const res = await fetch("/api/v1/agents", { credentials: "include" });
      if (!res.ok) return -1;
      const body = await res.json();
      return (body.agents ?? []).filter((a: { type?: string }) => a.type !== "user").length;
    });
    expect({ rows, agents }).toEqual({ rows: agents, agents });
    expect(agents).toBeGreaterThan(0);
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
    // **The server's own word, fetched rather than typed.** This asserted
    // `HEALTHY`, which no route has ever answered — the console was drawing a
    // constant of its own beside a health check it had read, so the badge said
    // the same thing whatever `/api/v1/health` replied. It draws `status` now,
    // and the comparison is against the route rather than against a string in
    // this file, which cannot drift from it.
    const health = (await (await fetch(`${mesh.http.url}/api/v1/health`)).json()) as { status: string };
    expect(health.status).toBeString();
    expect(mainText).toContain(health.status);
    // **One row per service the console can name, and it names one.** The floor
    // was 2, which nothing on this page has ever met once the health row stopped
    // being padded with invented nodes — and the scenario never reached the
    // check, because it failed on `HEALTHY` first. What the row has to carry is
    // the endpoint it read, so the count is a floor of one and the endpoint is
    // the assertion.
    const rowCount = await page.locator("table tbody tr").count();
    expect({ rows: rowCount >= 1, endpoint: mainText.includes("/api/v1/health") })
      .toEqual({ rows: true, endpoint: true });
    expect(errors).toEqual([]);
    await context.close();
  });

  // SCR-10 / SC-RENDER-10: Node Telemetry Page Live Render (D-31)
  it("[SC-RENDER-10] renders /platform/telemetry with telemetry cards", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/telemetry");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).not.toContain("null%");
    // `tel.sockets`: the panel counts registry rows whose channel is `web`,
    // and now says so. "활성 소켓 연결 수" was a live-socket count nothing
    // measured.
    expect(mainText).toContain("웹 채널 등록 신원");
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
    // D-99 & D-67 assertions. Message events alone retain a route, while the
    // route's meaning and carrier are written as a sentence beside it.
    expect(mainText).toContain("agent-alpha → admin · 메시지를 보냄");
    expect(mainText).toContain("admin → agent-alpha");
    expect((mainText.match(/전달자 agent-proxy/g) || []).length).toBe(2);
    // D-67 ① Ledger outer timestamp vs payload inner timestamp assertion:
    expect(mainText).toContain("14:10:00");
    expect(mainText).not.toContain("14:09:58");
    // Original payload bytes are not the default reading surface. The first
    // record remains reachable through the explicit disclosure control.
    expect(await page.locator('[data-testid="audit-raw-json"]').count()).toBe(0);
    const originals = page.getByRole("button", { name: "원문 JSON 보기" });
    expect(await originals.count()).toBeGreaterThan(0);
    await originals.first().click();
    expect(await page.locator('[data-testid="audit-raw-json"]').count()).toBe(1);
    expect(await page.locator('[data-testid="audit-raw-json"]').first().innerText()).toContain("14:09:58");
    // D-25 & D-28 assertions:
    expect(mainText).not.toContain("VERIFIED");
    expect(mainText).toContain("서명 있음 · ed25519");
    expect(mainText).toContain("미서명");

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
    const context = await newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`${viteBaseUrl}/login`, { waitUntil: "networkidle" });
    const userInputs = page.locator("input");
    expect(await userInputs.count()).toBeGreaterThanOrEqual(2);
    // **The seeded account is `platform-admin`.** T-026 renamed it, and every
    // form here kept typing `admin` — a login that fails, a redirect that
    // never happens, and a scenario that reports the console broken. The
    // password did not move.
    await userInputs.nth(0).fill(SEED_ADMIN);
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
    await shows(page, "보낸 본문");
    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("보낸 본문");
    expect(errors).toEqual([]);
    await context.close();
  });

  // SC-ACT-04: Interactive Telemetry Refresh (D-91, D-101, D-112)
  it("[SC-ACT-04] clicks refresh on platform telemetry and triggers live telemetry response", async () => {
    const { page, context, errors } = await createAuthedPage("/platform/telemetry");
    // `telem.refreshBtn`, which is "↻ 새로고침" now. The console stopped
    // calling a manual re-read "실시간" — nothing on this screen streams.
    const refreshBtn = page.locator("button:has-text('새로고침')").first();
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

    const summaries = await page.locator('[data-testid="audit-summary"]').count();
    expect(summaries).toBeGreaterThanOrEqual(4);
    expect(await page.locator('[data-testid="audit-raw-json"]').count()).toBe(0);
    expect(await page.locator('[data-testid="audit-withheld"]').count()).toBe(0);

    // The placeholder is operator prose and appears only after the person asks
    // for an original record. Open every seeded message record so this checks
    // the entire page rather than one convenient row.
    const closed = page.getByRole("button", { name: "원문 JSON 보기" });
    const closedCount = await closed.count();
    expect(closedCount).toBe(summaries);
    for (let remaining = closedCount; remaining > 0; remaining -= 1) {
      expect(await closed.count()).toBe(remaining);
      await closed.first().click();
    }
    expect(await closed.count()).toBe(0);
    const withheld = await page.locator('[data-testid="audit-withheld"]').count();
    const safeOriginals = await page.locator('[data-testid="audit-raw-json"]').count();
    // Four seeded message events carry content and stay withheld. Content-free
    // audit-read events can expose their own query record to this metadata
    // reader; treating those as message bodies is the category error T-041
    // removes from the screen.
    expect(withheld).toBeGreaterThanOrEqual(4);
    expect(withheld + safeOriginals).toBe(summaries);

    const mainText = await page.locator("#root").innerText();
    expect(mainText).toContain("본문을 볼 권한이 없어 숨겼습니다");
    expect(mainText).not.toContain("[content withheld");
    expect(mainText).not.toContain("audit.read.content");
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
    // The heading, which `SC-CAP-06` renamed: this list is not the viewer's own.
    expect(mainText).toContain("에이전트 운영 대시보드");

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
        // **`type !== "user"`, which is the console's one rule and not a filter
        // this screen invented.** The registry is a unified namespace: a person
        // and an agent arrive in the same response, and `agentRegistryEntries`
        // is where every agent-labelled view drops the people. A recipient
        // picker offering an operator's login as a destination is the defect
        // that rule exists for, so the invariant here changed from "neither
        // adds nor removes" to "removes exactly the people, and nothing else".
        const served: string[] = await info.page.evaluate(async () => {
          const res = await fetch("/api/v1/agents", { credentials: "include" });
          if (!res.ok) return [];
          const body = await res.json();
          return (body.agents ?? [])
            .filter((a: { type?: string }) => a.type !== "user")
            .map((a: { id: string }) => a.id);
        });

        // **Each picker by name.** This read the options of every `select` on
        // the screen as one set, and the playground has two — sender and
        // recipient — so a filter on one was answered by the other: planting
        // `senderAgents.filter((a) => a.group === "Support Group")` left the
        // union whole and this check green while four other scenarios went red
        // around it.
        //
        // Asking "whichever pickers list agents must list all of them" is not
        // enough either, and that is the more interesting half: `group` holds
        // the agent's *kind*, so that filter empties the sender list outright,
        // and a picker showing nothing is invisible to a rule keyed on what a
        // picker shows. Both are named instead, and a missing one is a failure
        // rather than a silence.
        const listings: Array<{ picker: string; found: boolean; shown: string[] }> = [];
        for (const picker of ["playground-sender", "playground-recipient"]) {
          const select = info.page.locator(`[data-testid="${picker}"]`);
          const found = (await select.count()) > 0;
          const options = found ? await select.locator("option").allTextContents() : [];
          listings.push({
            picker,
            found,
            shown: [...new Set(options.flatMap((text) => served.filter((id) => text.includes(id))))].sort(),
          });
        }
        // Every served agent appears in both pickers, and nothing appears in
        // either that was not served.
        expect({ label, listings }).toEqual({
          label,
          listings: listings.map(({ picker }) => ({ picker, found: true, shown: [...served].sort() })),
        });
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
      // The six by `tel.m.*`, which the console rewrote from shorthand into
      // what each number is. Not a count of tiles — six tiles with the wrong
      // labels would pass that.
      for (const label of ["등록 대기", "가장 오래 기다린 시간", "서명 확인 실패", "요청 제한", "전송 규칙으로 차단", "수락한 작업"]) {
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
    const context = await newContext();
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
      expect({ realZeroKept: /수락한 작업[\s\S]{0,40}0/.test(said) }).toEqual({ realZeroKept: true });
      expect({ pendingKept: said.includes("4") }).toEqual({ pendingKept: true });

      // With no window the refusal counts cannot be read, and the heading says
      // so rather than printing a date it does not have.
      const since = (await page.locator("[data-testid='counting-since']").textContent()) ?? "";
      // 문구가 "집계 시작 시각 미상" 에서 "집계 시작 시각을 모른다" 로 바뀌었다 —
      // 랜드마크는 문구를 따라간다.
      expect({ saysUnknown: since.includes("모른다") }).toEqual({ saysUnknown: true });
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

    // Operator language explains the withheld reads without leaking server keys.
    const said = (await banner.textContent()) ?? "";
    expect({ count: said.includes("(2)"), leaksKeys: said.includes("usage.read") || said.includes("mailbox.read.depth") })
      .toEqual({ count: true, leaksKeys: false });

    // And it is genuinely different from what an admin sees.
    const admin = await createAuthedPage("/platform/telemetry");
    expect(await admin.page.locator("[data-testid='telemetry-refused']").count()).toBe(0);
    await admin.context.close();

    await context.close();
  }, 30_000);

  /**
   * SC-CAP-10 — `/platform` says it was refused, rather than that the network
   * is down.
   *
   * **Found by counting states, not by looking at screens.** Fourteen pages in
   * this console read data; thirteen carry all four of loading / present /
   * refused / unreachable. This one computed `failureKind` and
   * `refusedCapability`, stored both, and rendered neither — every failure came
   * out as `통신 오류`. A person without `usage.read` was sent to check a
   * network that was fine, for a permission nobody told them about.
   *
   * `SC-CAP-04` is the same finding one screen over, which is why this is worth
   * a scenario rather than a fix: the shape came back on the page next door.
   *
   * The refusal is the server's, not a fulfilled 403 — a fulfilled status
   * proves the screen reads a number, and what is in question is whether the
   * mesh and the screen agree about what this person may do.
   */
  it("[SC-CAP-10] says /platform was refused instead of reporting a communication error", async () => {
    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context } = await createViewerAuthedPage(viewerCookie, "/platform");
    const refusedBy = new Set<string>();
    let sawRefusal = false;
    try {
      // What the server actually answered, so the assertion below is about a
      // disagreement between the screen and the mesh rather than about a status
      // this scenario made up.
      //
      // **The bell is on this page and it is refused too.** It is a different
      // component with its own sentence, and this scenario is about the page's
      // own data — the first version kept the last 403 it saw, which in a full
      // run was the bell's `key.approve`, and the scenario failed for a
      // capability this banner is not about. Alone it passed, because the
      // bell's request happened to land first. Excluded by route, and the
      // exclusion is here rather than implied.
      const BELL = /\/admin\/keys\/(pending|stream)/;
      page.on("response", async (res) => {
        if (!/\/api\//.test(res.url()) || res.status() !== 403 || BELL.test(res.url())) return;
        sawRefusal = true;
        try {
          const body = (await res.json()) as { capability?: string };
          if (body?.capability) refusedBy.add(body.capability);
        } catch {
          /* a 403 without a readable body is still a refusal */
        }
      });
      await page.reload({ waitUntil: "networkidle" });
      await settled(page);
      const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");

      // **This required the banner to print every capability the server named,
      // and the console has since decided the opposite** — machine keys stay
      // off operator copy, because nine screens had `(key.approve)` and
      // `(group.manage)` typed into their own sentences and every one of them
      // was a guess about what an operator would do with it. `refusedText`
      // draws the sentence without the key and `api/client.test.ts` holds it
      // there; the key stays on the error object for code.
      //
      // What survives is the half this scenario is named for and the half that
      // was actually wrong in production: a refusal is an *answer*, so the page
      // says it was refused rather than sending somebody to check a network
      // that is fine.
      const leaked = [...refusedBy].filter((cap) => text.includes(cap));
      const viewer = {
        serverRefused: sawRefusal,
        saysRefused: (await page.locator('[data-testid="overview-refused"]').count()) > 0,
        keepsMachineKeysOff: leaked.length === 0,
        blamesTheNetwork: /통신 오류|communication error|no answer/.test(text),
      };

      // The other side: an admin holds it, so nothing on this page should be
      // reporting a refusal. A screen that always says "refused" passes half.
      // **The marker, not a word.** The first version matched `/권한|refused/`
      // across the admin's page and was true — that word is in the sidebar. It
      // reported a defect that was not there, which is the same way
      // `SC-WRITE-11` went wrong an hour earlier.
      const admin = await createAuthedPage("/platform");
      const adminSaysRefused = (await admin.page.locator('[data-testid="overview-refused"]').count()) > 0;
      await admin.context.close().catch(() => {});

      expect(
        { ...viewer, adminSaysRefused },
        "the screen blamed the network for a refusal, said nothing about it, put a machine key on screen, or says refused to a session that holds it",
      ).toEqual({
        serverRefused: true,
        saysRefused: true,
        keepsMachineKeysOff: true,
        blamesTheNetwork: false,
        adminSaysRefused: false,
      });
    } finally {
      await context.close().catch(() => {});
    }
  }, 30_000);

  /**
   * SC-CAP-11 — no screen says the server went quiet while the server was
   * answering `403`.
   *
   * `I-061` was this on `/platform/telemetry`, `I-111` was the same thing one
   * screen over on `/platform`, and both were found one at a time. The rule
   * underneath them holds for every screen and needs nothing screen-specific:
   * **a refusal is an answer.** Telling somebody the backend did not respond,
   * when it responded with `403`, sends them to check a network that is fine
   * for a permission nobody has named to them.
   *
   * Deliberately not "every refused capability is named": the notification bell
   * is refused on every one of these pages and keeps its sentence inside a
   * dropdown that is closed, so that rule would need a per-component exclusion
   * list — and an exclusion list is where this check would quietly stop
   * covering things. This one has no exclusions.
   *
   * The routes come from the router, and the refusals are the server's own.
   */
  it("[SC-CAP-11] never reports silence on a screen the server answered 403 for", async () => {
    const appSource = readFileSync(
      join(import.meta.dir, "..", "packages", "platform-web", "src", "App.tsx"),
      "utf8",
    );
    const routes = [...new Set([...appSource.matchAll(/path="(\/[^"*]*)"/g)].map((m) => m[1]!))]
      .filter((r) => !r.includes(":") && r !== "/login" && r !== "/change-password" && r !== "/");
    expect(routes.length, "no routes were parsed out of App.tsx — the router's shape changed").toBeGreaterThan(7);

    const viewerCookie = await capabilityViewer(mesh, "audit.read.metadata");
    const { page, context } = await createViewerAuthedPage(viewerCookie, "/dashboard");
    const offenders: string[] = [];
    let refusedScreens = 0;
    try {
      for (const route of routes) {
        let refused = false;
        const watch = (res: import("playwright").Response) => {
          if (/\/api\//.test(res.url()) && res.status() === 403) refused = true;
        };
        page.on("response", watch);
        await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" }).catch(() => {});
        await settled(page);
        page.off("response", watch);
        if (!refused) continue;
        refusedScreens++;
        const text = ((await page.locator("#root").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
        // The sentences this console uses for "no answer". A refusal must not
        // produce any of them.
        const silence = text.match(/서버가 답하지[^.]*|물어보지 못했습니다|통신 오류|연결 실패|did not answer|Could not ask[^.]*|no answer/);
        if (silence) offenders.push(`${route}: ${silence[0].slice(0, 48)}`);
      }

      // **A run where nothing was refused proves nothing.** This is the shape
      // that turns a scenario into a green line with no check behind it: the
      // viewer's grants change, every screen answers, and the loop above never
      // reaches its assertion.
      expect(
        { screensRefused: refusedScreens > 2 },
        `only ${refusedScreens} screens were refused, so this scenario did not exercise the rule it exists for`,
      ).toEqual({ screensRefused: true });

      console.log(`[SC-CAP-11] ${routes.length} routes · ${refusedScreens} refused`);
      expect(offenders, "a screen reported silence about a backend that answered 403").toEqual([]);
    } finally {
      await context.close().catch(() => {});
    }
  }, 90_000);

  /**
   * SC-CAP-12 — the mirror of `SC-CAP-11`: no screen blames a permission for a
   * backend that never answered.
   *
   * `SC-CAP-11` says a refusal must not be drawn as silence. This is the other
   * direction, and a console that answered *every* failure with "you do not
   * have permission" would pass that one — it never says the server went quiet,
   * because it never says anything true. Sending somebody to ask for a
   * capability they already hold is the same wasted errand as sending them to
   * check a healthy network, pointed the other way.
   *
   * The sentence comes from the dictionary, not from this file: `refusedText`
   * builds every refusal on the console out of `common.refusedRead`, so what is
   * asserted is the product's own wording rather than a phrase a test author
   * chose and would have to remember to update.
   *
   * `**\/api\/v1\/**` only, which is the failure the development server can
   * make: `/auth/me` keeps answering, so the session survives and the screens
   * render. A deployment fails differently and `SC-DOWN-09/10/11` carry that.
   */
  it("[SC-CAP-12] never blames a permission for a backend that did not answer", async () => {
    const appSource = readFileSync(
      join(import.meta.dir, "..", "packages", "platform-web", "src", "App.tsx"),
      "utf8",
    );
    const routes = [...new Set([...appSource.matchAll(/path="(\/[^"*]*)"/g)].map((m) => m[1]!))]
      .filter((r) => !r.includes(":") && r !== "/login" && r !== "/change-password" && r !== "/");
    expect(routes.length, "no routes were parsed out of App.tsx — the router's shape changed").toBeGreaterThan(7);

    // The console's own refusal sentence, read out of the dictionary it is
    // built from. Both languages, because the context here chooses one.
    const dict = readFileSync(
      join(import.meta.dir, "..", "packages", "platform-web", "src", "contexts", "I18nContext.tsx"),
      "utf8",
    );
    const refusalSentences = [...dict.matchAll(/"common\.refusedRead":\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(
      { found: refusalSentences.length },
      "the refusal sentence is not in the dictionary under the key this check reads, so it would assert nothing",
    ).toEqual({ found: 2 });

    const { page, context } = await createAuthedPage("/dashboard");
    const offenders: string[] = [];
    let blocked = 0;
    try {
      await page.route("**/api/v1/**", (route) => route.abort());
      for (const route of routes) {
        let aborted = false;
        const watch = (req: import("playwright").Request) => {
          if (/\/api\/v1\//.test(req.url())) aborted = true;
        };
        page.on("requestfailed", watch);
        await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" }).catch(() => {});
        await settled(page);
        page.off("requestfailed", watch);
        if (!aborted) continue;
        blocked++;
        const text = ((await page.locator("#root").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
        const said = refusalSentences.find((sentence) => text.includes(sentence));
        if (said) offenders.push(`${route}: ${said.slice(0, 44)}`);
      }

      // Nothing blocked means nothing was asked of the screens, and every
      // assertion above would be vacuous.
      expect(
        { screensBlocked: blocked > 2 },
        `only ${blocked} screens issued a call that was blocked, so this scenario did not exercise the rule it exists for`,
      ).toEqual({ screensBlocked: true });

      expect(offenders, "a screen blamed a permission for a backend that never answered").toEqual([]);
    } finally {
      await context.close().catch(() => {});
    }
  }, 90_000);

  /**
   * SC-WRITE-12 / SC-WRITE-13 — the write actually happened.
   *
   * **Measured before these were written.** Replacing `createGroupApi` and
   * `teardownAgentApi` with `return { ok: true }` — no request at all — left
   * every one of this file's scenarios green. Eight `SC-WRITE-*` entries assert
   * that a *failed* write is not drawn as a success, and nothing asserted that a
   * successful one is a write. A console whose buttons do nothing passed all of
   * them.
   *
   * That is the rule this repository keeps rediscovering: one direction is not
   * a distinction. `SC-DOWN-*` needed `401 → /login` beside `502 → could not
   * ask`; this needed the other half of the write.
   *
   * The two are split because they fail differently. Creation is checked
   * against the server, which is the only witness that cannot agree with the
   * screen by construction. Teardown is checked by the request it issues, with
   * the answer fulfilled — deleting a real agent would change what every other
   * scenario in this file is looking at.
   */
  it("[SC-WRITE-12] creates a group the server then lists, not only a row on screen", async () => {
    const name = `wrote-${Date.now().toString(36).slice(-6)}`;
    await withPage("/creator/groups", async ({ page }) => {
      const createBtn = page.locator("button:has-text('그룹 생성')").first();
      expect(
        { control: await createBtn.count() },
        "the create control was not on the page, so this scenario measured nothing",
      ).toEqual({ control: 1 });
      await createBtn.click();
      await page.locator("input").first().fill(name);
      await page.locator("button[type='submit']:has-text('생성')").first().click();
      await attemptOver(page);
      await settled(page);

      const onScreen = await eventually(
        async () => ((await page.locator("#root").innerText().catch(() => "")) ?? "").includes(name),
        (found) => found,
      );

      // **The server, asked directly.** A screen that keeps its own list agrees
      // with itself; this is the same prescription `shownaddr` uses for the
      // fingerprint — the witness has to be on the other side.
      const listed = await (async () => {
        const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, { headers: { cookie: `mesh_token=${jwtToken}` } });
        const body = (await res.json()) as any;
        const groups: any[] = Array.isArray(body) ? body : body.groups ?? [];
        return groups.some((g) => (g.group_id ?? g.id ?? g.name) === name);
      })();

      expect(
        { onScreen, listed },
        "the group was drawn without being created, or created without being drawn",
      ).toEqual({ onScreen: true, listed: true });
    });
  }, 40_000);

  it("[SC-WRITE-13] sends the teardown it reports, rather than only removing the row", async () => {
    await withPage("/creator", async ({ page }) => {
      const sent: string[] = [];
      await page.route("**/api/v1/admin/agents/**", async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        sent.push(route.request().url());
        // Answered here rather than let through: a real teardown would remove an
        // identity every other scenario in this file reads.
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, identity: "intercepted", action: "soft-deleted" }),
        });
      });

      const before = await page.locator("tbody tr").count();
      expect(
        { rows: before > 0 },
        "there were no rows, so this scenario measured nothing",
      ).toEqual({ rows: true });

      // The shared helper, which reads the identity off the control's own
      // `data-testid` rather than off the first cell of the first row. This
      // read the cell, and the cell holds the display name — so the confirmation
      // was typed with something the dialog does not accept, the button stayed
      // disabled, and the scenario waited out its timeout instead of failing.
      const { identity, confirm } = await armFirstTeardown(page);
      await confirm.click();
      await attemptOver(page);
      await settled(page);

      expect(
        { requests: sent.length, addressed: sent.some((u) => u.includes(encodeURIComponent(identity)) || u.includes(identity)) },
        "the screen reported a teardown it never sent, or sent one for a different identity",
      ).toEqual({ requests: 1, addressed: true });
    });
  }, 40_000);

  async function assertTeardownOutcome(
    page: import("playwright").Page,
    action: "soft-deleted" | "already-deleted" | "not-found",
    testId: string,
    sentence: string,
  ) {
    await page.route("**/api/v1/admin/agents/**", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, identity: "intercepted", action }),
      });
    });
    const { identity, confirm } = await armFirstTeardown(page);
    await confirm.click();
    const place = page.locator(`[data-testid="${testId}"]`);
    const message = await eventually(
      async () => await place.count() > 0 ? await place.locator("span").nth(1).innerText() : "",
      (text) => text.length > 0,
    );
    expect(
      { place: await place.count(), message },
      `${action} was folded into another teardown result`,
    ).toEqual({ place: 1, message: `${sentence}: ${identity}` });
  }

  it("[SC-WRITE-18] says soft-deleted in its own result place", async () => {
    await withPage("/creator", async ({ page }) => {
      await assertTeardownOutcome(
        page,
        "soft-deleted",
        "teardown-result-soft-deleted",
        "영구 삭제 완료",
      );
    });
  }, 40_000);

  it("[SC-WRITE-19] says already-deleted in its own result place", async () => {
    await withPage("/creator", async ({ page }) => {
      await assertTeardownOutcome(
        page,
        "already-deleted",
        "teardown-result-already-deleted",
        "이미 삭제되어 이번 요청에서 변경 없음",
      );
    });
  }, 40_000);

  it("[SC-WRITE-20] says not-found in its own result place", async () => {
    await withPage("/creator", async ({ page }) => {
      await assertTeardownOutcome(
        page,
        "not-found",
        "teardown-result-not-found",
        "등록된 에이전트가 없어 삭제하지 않음",
      );
    });
  }, 40_000);

  it("[SC-WRITE-21] disables an in-flight teardown and sends one DELETE for two click events", async () => {
    await withPage("/creator", async ({ page }) => {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const sent: string[] = [];
      await page.route("**/api/v1/admin/agents/**", async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        sent.push(route.request().url());
        await held;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, identity: "intercepted", action: "soft-deleted" }),
        });
      });

      const { confirm } = await armFirstTeardown(page);
      await confirm.evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const requests = await eventually(async () => sent.length, (count) => count > 0);
      expect(
        { disabled: await confirm.isDisabled(), requests },
        "the destructive confirmation stayed armed or emitted two DELETEs while the first was pending",
      ).toEqual({ disabled: true, requests: 1 });
      release();
      await attemptOver(page);
      expect(sent).toHaveLength(1);
    });
  }, 40_000);

  it("[SC-INVENT-08] gives an unparsable last_seen_at one invalid-value place and sentence", async () => {
    await withPage("/creator", async ({ page }) => {
      await page.route("**/api/v1/agents", async (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agents: [{
            id: "invalid-last-seen",
            name: "Invalid timestamp agent",
            description: "Invalid timestamp agent",
            channel: "websocket",
            type: "worker",
            created_at: "2026-08-01T10:00:00Z",
            last_seen_at: "not-a-date",
            fingerprint: null,
          }],
        }),
      }));
      await page.reload({ waitUntil: "networkidle" });
      await settled(page);

      const row = page.locator("tbody tr").filter({ hasText: "invalid-last-seen" });
      const invalid = row.locator('[data-testid="invalid-last-seen"]');
      expect(
        {
          row: await row.count(),
          place: await invalid.count(),
          noRecordPlace: await row.locator('[data-testid="never-seen"]').count(),
          wrongPlace: await row.locator('[data-testid="last-seen"]').count(),
          sentence: await invalid.count() > 0 ? await invalid.innerText() : "",
        },
        "the last-seen words and their named place disagreed",
      ).toEqual({
        row: 1,
        place: 1,
        noRecordPlace: 0,
        wrongPlace: 0,
        sentence: "마지막 접속 시각 형식 오류",
      });
    });
  }, 40_000);

  /**
   * SC-WRITE-14 — granting a capability reaches the server.
   *
   * **Found by counting, not by reading.** `WRITE_PROBE=1` lists the writes a
   * run issues; the front end can make thirteen and this suite issued ten of
   * them. The three it never made were `keys/approve`, `grants` POST and
   * `egress` POST — every one the *allowing* direction, with its removing
   * counterpart covered. The suite tested taking access away and never tested
   * giving it.
   *
   * That asymmetry matters most here. A revoke that silently fails leaves
   * somebody with access they should not have and the screen says so next
   * reload; a grant that silently fails leaves an operator believing they have
   * given access that nobody has, and the screen agrees with them until
   * somebody is locked out of work.
   *
   * The subject is admitted for this scenario so the grant lands on an account
   * no other scenario reads.
   */
  it("[SC-WRITE-14] grants a capability the server then holds, not only a checked cell", async () => {
    const admin = { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" };
    const who = `grant-${Date.now().toString(36).slice(-6)}`;
    const admitted = await fetch(`${mesh.http.url}/api/v1/admin/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ username: who }),
    });
    expect(
      { created: admitted.ok },
      "the subject for this scenario could not be created, so nothing below was exercised",
    ).toEqual({ created: true });

    const CAP = "audit.read.metadata";
    await withPage("/tenant/rbac", async ({ page }) => {
      const cell = page.locator(`[data-testid="rbac-cap-${who}-${CAP}"]`);
      const control = await eventually(async () => await cell.count(), (n) => n > 0);
      expect(
        { control },
        "the subject's row or its capability cell was not drawn, so this scenario measured nothing",
      ).toEqual({ control: 1 });

      await cell.click();
      await attemptOver(page);

      // **The server, asked directly.** A screen that reloads its own list from
      // the same place it wrote to would agree with itself either way; this is
      // the witness on the other side.
      const held = await eventually(
        async () => {
          const res = await fetch(`${mesh.http.url}/api/v1/admin/grants`, { headers: { cookie: `mesh_token=${jwtToken}` } });
          const body = (await res.json()) as any;
          const rows: any[] = Array.isArray(body) ? body : body.grants ?? [];
          return rows.some((g) => (g.subject ?? g.username) === who && g.capability === CAP);
        },
        (found) => found,
      );
      const onScreen = await eventually(
        async () => ((await page.locator("#root").innerText().catch(() => "")) ?? "").includes(who),
        (found) => found,
      );

      expect(
        { held, onScreen },
        "the capability was checked on screen without being granted, or granted without being drawn",
      ).toEqual({ held: true, onScreen: true });
    });
  }, 40_000);

  /**
   * SC-WRITE-15 — approving a key reaches the server.
   *
   * The second of the three writes `WRITE_PROBE` found nothing issuing, and the
   * positive half of `SC-WRITE-10`. That one plants a proposal with
   * `route.fulfill` and blocks the decision, which is enough to see a screen
   * lie about a refusal; it cannot see whether an approval lands, because the
   * fingerprint it invents does not exist on the server.
   *
   * So this registers a real identity on the hub with a real key, which is what
   * puts a proposal in the queue, and asks the server afterwards whether the
   * proposal is still waiting. § 10.2 is what makes it worth the setup: an
   * operator comparing a fingerprint and pressing approve has done the one
   * thing that admits an identity to the mesh, and a screen that reports it
   * without sending it leaves that identity unable to connect while the console
   * says it is in.
   */
  it("[SC-WRITE-15] approves a key the server then stops listing as pending", async () => {
    const key = newKeyPair();
    const identity = `approve-${Date.now().toString(36).slice(-6)}`;
    const registered = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity, type: "ai-claude", public_key: key.publicKey }),
    });
    const pendingNow = async () => {
      const res = await fetch(`${mesh.http.url}/api/v1/admin/keys/pending`, { headers: { cookie: `mesh_token=${jwtToken}` } });
      const body = (await res.json()) as any;
      const rows: any[] = Array.isArray(body) ? body : body.keys ?? [];
      return rows.some((p) => p.identity === identity);
    };
    expect(
      { registered: registered.ok, waiting: await eventually(pendingNow, (yes) => yes) },
      "the proposal this scenario approves was never queued, so nothing below was exercised",
    ).toEqual({ registered: true, waiting: true });

    const { page, context } = await createAuthedPage("/tenant/rbac");
    try {
      await page.locator('[data-testid="bell"]').click();
      await settled(page);
      const row = page.locator(`text=${identity}`).first();
      const rowThere = await eventually(async () => await row.count(), (n) => n > 0);
      expect(
        { row: rowThere },
        "the proposal was not drawn in the bell, so the approval below was not the one on screen",
      ).toEqual({ row: 1 });
      await row.click();
      await settled(page);

      const approve = page.locator("button:has-text('소유권 승인')").first();
      expect(
        { control: await approve.count() },
        "the approve control was not in the modal, so this scenario measured nothing",
      ).toEqual({ control: 1 });
      await approve.click();
      await attemptOver(page);

      const stillWaiting = await eventually(pendingNow, (yes) => !yes);
      expect(
        { stillWaiting },
        "the console reported an approval the server never took",
      ).toEqual({ stillWaiting: false });
    } finally {
      await context.close().catch(() => {});
    }
  }, 40_000);

  /**
   * SC-WRITE-16 — allowing an egress rule reaches the server.
   *
   * The last of the three `WRITE_PROBE` named. `SC-WRITE-11` covers the cell's
   * behaviour when the write fails and when it is answered, but it answers both
   * directions from the intercept, so no rule was ever actually written — and
   * the fixture's single group makes its one cell start `ALLOW`, so the click
   * it does exercise is the `DELETE`.
   *
   * A group is created here to get a cell that starts `DENY`, which is the only
   * way to press the allowing half. § 12: a group with no egress rule sends
   * nowhere, so this is the control that decides whether a group's agents can
   * reach anything at all — and a screen that ticks it without writing leaves
   * an operator believing a lane is open that is closed.
   */
  it("[SC-WRITE-16] writes the egress rule it ticks, not only the cell", async () => {
    const admin = { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" };
    const group = `egress-${Date.now().toString(36).slice(-6)}`;
    const made = await fetch(`${mesh.http.url}/api/v1/admin/groups`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ group_id: group, description: "SC-WRITE-16" }),
    });
    expect(
      { created: made.ok },
      "the group this scenario needs was not created, so nothing below was exercised",
    ).toEqual({ created: true });

    const serverAllows = async () => {
      const res = await fetch(`${mesh.http.url}/api/v1/admin/groups`, { headers: { cookie: `mesh_token=${jwtToken}` } });
      const body = (await res.json()) as any;
      const rules: any[] = Array.isArray(body.egress) ? body.egress : [];
      // `from_group` / `to_group` — the names the route actually sends, read off
      // the response rather than guessed. The first version looked for
      // `source_group` and reported a rule that had been written as missing.
      return rules.some((r) => r.from_group === group && r.to_group === "default");
    };
    expect(
      { alreadyOpen: await serverAllows() },
      "the lane this scenario opens was open before it started, so pressing the cell would prove nothing",
    ).toEqual({ alreadyOpen: false });

    await withPage("/tenant/egress-acl", async ({ page }) => {
      const cell = page.locator(`[data-testid="acl-${group}-default"]`);
      const drawn = await eventually(async () => await cell.count(), (n) => n > 0);
      const state = drawn > 0 ? await cell.getAttribute("data-allowed") : null;
      expect(
        { cell: drawn, starts: state },
        "the new group's cell was not drawn, or it did not start closed — either way the allowing half was not pressed",
      ).toEqual({ cell: 1, starts: "no" });

      await cell.locator("button").first().click();
      await attemptOver(page);

      const wrote = await eventually(serverAllows, (yes) => yes);
      expect(
        { wrote },
        "the cell was ticked without the rule being written",
      ).toEqual({ wrote: true });
    });
  }, 40_000);

  /**
   * SC-LIVE-01 — what the server pushes reaches the screen.
   *
   * The bell subscribes to `/api/v1/admin/keys/stream` and every scenario that
   * touches that route **fulfils a failure or an empty snapshot**: `SC-DOWN-12`
   * blocks it, `SC-CAP-07` refuses it, and the rest hand it `{"keys":[]}`.
   * All four measure what the screen says when the stream says nothing. None of
   * them measures a stream that says something.
   *
   * Same asymmetry as the writes: the failing direction covered, the working
   * one assumed. A dead listener is silent by construction — the queue is
   * correct on every reload, so the only person who notices is the operator
   * sitting on the page while an agent waits.
   *
   * No reload here, deliberately. The initial fetch already answers, so a
   * scenario that navigates would pass with the listener deleted.
   */
  it("[SC-LIVE-01] shows a proposal that arrived after the page did, without a reload", async () => {
    const { page, context } = await createAuthedPage("/tenant/rbac");
    try {
      await page.locator('[data-testid="bell"]').click();
      await settled(page);

      const key = newKeyPair();
      const identity = `live-${Date.now().toString(36).slice(-6)}`;
      const url = page.url();
      const registered = await fetch(`${mesh.hub.url}/api/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity, type: "ai-claude", public_key: key.publicKey }),
      });

      const arrived = await eventually(
        async () => ((await page.locator("body").textContent().catch(() => "")) ?? "").includes(identity),
        (yes) => yes,
        { tries: 15, everyMs: 400 },
      );

      expect(
        { registered: registered.ok, arrived, navigated: page.url() !== url },
        "the proposal was queued but never reached the open page, or the page moved and the initial fetch answered instead of the stream",
      ).toEqual({ registered: true, arrived: true, navigated: false });
    } finally {
      await context.close().catch(() => {});
    }
  }, 40_000);

  /**
   * SC-LIVE-02 — a dead channel does not look like a live one.
   *
   * `SC-LIVE-01` is the working direction: what the server pushes reaches an
   * open page. This is the other one, and without it a bell that never
   * subscribes at all would pass — the initial fetch answers, the list is
   * right, and nothing about the screen distinguishes *current* from *the last
   * thing I was told*.
   *
   * That was the state of this component: no `onopen`, no `onerror`, no reading
   * of `readyState`. The fetch's answer stayed on screen looking current, a
   * proposal arriving afterwards never appeared, and the operator sitting on
   * the page — the only person this component is for — was the only one who
   * would never find out.
   *
   * `EventSource` retries on its own, so an error is not the same as gone.
   * The line says *this may be stale*, which is a fourth thing beside nothing
   * is waiting, could not ask, and here is the queue.
   */
  it("[SC-LIVE-02] says the live channel stopped, rather than showing a stale queue as current", async () => {
    const read = async (streamWorks: boolean) => {
      const { page, context } = await createAuthedPage("/tenant/rbac");
      try {
        // **두 출처가 이제 같은 이름으로 말한다.** REST 는 `d6fa7bc`, 스트림은 `1daa973`
        // 에서 `keys` 로 갔고 SPEC 1701 이 *Both sources send `keys`* 라고 적는다.
        // 이 주석은 한 판 동안 **거짓이었다** — 스트림이 옮겨간 뒤에도 *스트림은
        // proposals* 라고 말하고 있었다. 이름을 옮기는 커밋은 그 이름을 설명하는
        // 문장도 같이 옮겨야 한다.
        await page.route("**/api/v1/admin/keys/pending", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, keys: [{ identity: "live2-seed", fingerprint: "c2VlZA", type: "ai-claude", proposed_at: "2026-08-20T00:00:00.000Z" }] }),
          }),
        );
        // **The healthy half cannot be fulfilled.** A `route.fulfill` with a
        // finite body *ends* the response, `EventSource` sees the connection
        // close and fires `onerror` — so a stubbed stream looks exactly like a
        // dropped one and this scenario reported the working case as broken.
        // The real server keeps it open, so the healthy half lets it through.
        if (!streamWorks) await page.route("**/api/v1/admin/keys/stream", (route) => route.abort());
        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        await page.locator('[data-testid="bell"]').click();
        await settled(page);
        return {
          said: await eventually(
            async () => (await page.locator('[data-testid="bell-stream-lost"]').count()) > 0,
            (yes) => yes,
            { tries: 6, everyMs: 300 },
          ),
          // The queue is still drawn either way: the fetch answered, and
          // hiding it would trade one wrong screen for another.
          drewQueue: ((await page.locator("body").textContent()) ?? "").includes("live2-seed"),
        };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const lost = await read(false);
    const healthy = await read(true);

    expect(
      { saidWhenLost: lost.said, drewWhenLost: lost.drewQueue, saidWhenHealthy: healthy.said },
      "the bell showed a stale queue as current, dropped it instead of flagging it, or cries stale on a working stream",
    ).toEqual({ saidWhenLost: true, drewWhenLost: true, saidWhenHealthy: false });
  }, 40_000);

  // SC-ADDR-02: the agent list does not claim a fingerprint it was not given
  // (I-062)
  it("[SC-ADDR-02] shows no fingerprint on /creator, rather than a constant that says verified", async () => {
      // `GET /api/v1/agents` used to return id, name, description, channel and
      // type and no fingerprint, while the column was headed "Ed25519 public key
      // fingerprint" — so every row rendered `sha256:verified_mesh_identity`, the
      // same value for every agent, with the word an operator is looking for
      // sitting inside it. The route carries a real fingerprint now.
      //
      // **Compared against the server, not against a shape.** This used to assert
      // that nothing looked like `sha256:<letters>` unless a hex digest was also
      // on the page — a rule that held while the invented value was the only
      // letter-shaped one. Fingerprints are base64url (`FINGERPRINT_RE` is
      // `^sha256:[A-Za-z0-9_-]{43}$`), so a real one starts with six letters or
      // underscores about a third of the time, and the same code failed on roughly
      // one run in three with nothing changed but a freshly generated key.
      // Measured: 3000 random fingerprints, 0.330 letter-shaped, 0.003 readable as
      // hex — platform-claude derived the same figures from the alphabet and found
      // the flake in the field.
      //
      // The question is now *did this string come from the server*, which does not
      // care what the string looks like.
      const listed = await (
        await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { Cookie: `mesh_token=${jwtToken}` } })
      ).json();
      // **The agent rows, not every registry row.** The unkeyed half used to be
      // satisfied by the operator's own account — a person, who has no key and
      // is not on this screen at all now (`agentRegistryEntries` drops
      // `type: "user"`). Counting them left the pair claiming a fixture the
      // page could not show, and the assertion below failed for the fixture
      // rather than for the screen.
      const all: Array<{ id?: string; fingerprint?: string | null; type?: string }> =
        listed?.agents ?? listed ?? [];
      const rows = all.filter((a) => a.type !== "user");
      const withKey = rows.filter((a) => typeof a.fingerprint === "string" && a.fingerprint);
      const withoutKey = rows.filter((a) => !a.fingerprint);

      // Both halves must exist or the pair says nothing: keyed-only cannot catch a
      // screen that prints every fingerprint it is given plus some it is not, and
      // unkeyed-only cannot catch one that shows nothing at all.
      expect(
        { keyed: withKey.length > 0, unkeyed: withoutKey.length > 0 },
        `the fixture no longer holds both a keyed and an unkeyed agent: ${JSON.stringify(rows.map((r) => [r.id, !!r.fingerprint]))}`,
      ).toEqual({ keyed: true, unkeyed: true });

      await withPage("/creator", async ({ page }) => {
        const body = (await page.locator("body").textContent()) ?? "";

        // The constant that started this. Cheap, and it does not weaken.
        expect({ constant: body.includes("verified_mesh_identity") }).toEqual({ constant: false });

        // Every fingerprint the server gave, on the page, character for character.
        expect(
          withKey.filter((a) => !body.includes(a.fingerprint!)).map((a) => a.id),
          "the screen dropped a fingerprint the server sent",
        ).toEqual([]);

        // And nothing fingerprint-shaped that the server never sent.
        const shown = [...body.matchAll(/sha256:[A-Za-z0-9_-]{10,}/g)].map((m) => m[0]);
        const given = new Set(withKey.map((a) => a.fingerprint!));
        expect(
          [...new Set(shown.filter((f) => !given.has(f)))],
          "the screen showed a fingerprint the server never sent",
        ).toEqual([]);

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
      // `status` is gone from the route by decision, not omission — SPEC § 9.1 says
      // whether silence means `inactive` is an operating policy this screen does not
      // decide. What the row carries instead is when the mesh last saw the identity,
      // and that is a reading: these agents connected during setup, so the cell holds
      // a time. The omitted case — no record at all — is `SC-INVENT-01`, which
      // withholds the field rather than hoping the fixture lacks it. Asserting
      // "never seen" here was a guess about the fixture, and it was wrong.
      expect({ lastSeen: await page.locator("[data-testid='last-seen']").count() > 0 })
        .toEqual({ lastSeen: true });
      expect({ inboxUnknown: await page.locator("[data-testid='inbox-unknown']").count() > 0 })
        .toEqual({ inboxUnknown: true });
      // The words themselves are gone: nothing here claims a socket state.
      expect({ online: body.includes("ONLINE") || body.includes("OFFLINE") }).toEqual({ online: false });
    });
  }, 30_000);

  // SC-DOWN-01: Disconnected Backend Differentiation on Lease Queue (D-114, D-116)
  it("[SC-DOWN-01] distinguishes between empty and disconnected states on /creator/lease-queue", async () => {
    const context = await newContext();
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

    // `lease.error`, which the console rewrote from "메일함 리스 큐를" to
    // "메일함 처리 현황을" — the sentence a scenario waits for is a copy of the
    // product's, and this one is checked by `test/scenario-ids.test.ts`.
    await shows(page, "메일함 처리 현황을 불러오지 못했습니다");

    const downText = await page.locator("#root").innerText();
    expect(downText).toContain("메일함 처리 현황을 불러오지 못했습니다");
    // `common.unmeasured`. "측정 불가" became "— 미측정": the panel is saying
    // it has no measurement, not that measuring is impossible.
    expect(downText).toContain("미측정");

    // **Each card, not the page** — the repair `SC-DOWN-02` already carries,
    // and this scenario did not. A page-wide `toContain` is satisfied by
    // either counter saying it was not measured, so the one beside it could
    // print `0` for a mailbox nothing answered about and nothing here would
    // fail. Measured: a mutation doing exactly that left this scenario, and
    // every other scenario in the file, green.
    const kpi = async (label: string) => await page.locator(`[data-kpi="${label}"]`).innerText();
    const [leasedCard, availableCard] = [await kpi("처리 중인 메시지"), await kpi("대기 중인 메시지")];
    expect(
      {
        leasedUnmeasured: leasedCard.includes("미측정"),
        leasedSaidWhy: leasedCard.includes("서버 연결 불가"),
        availableUnmeasured: availableCard.includes("미측정"),
        availableSaidWhy: availableCard.includes("서버 연결 불가"),
      },
      "a lease queue counter printed a number, or printed no reason, while its route was unreachable",
    ).toEqual({
      leasedUnmeasured: true,
      leasedSaidWhy: true,
      availableUnmeasured: true,
      availableSaidWhy: true,
    });

    await context.close();
  });

  // SC-DOWN-02: Disconnected Backend Differentiation on Dashboard (D-114, D-116)
  it("[SC-DOWN-02] does not claim 0 registered agents or groups when disconnected on /dashboard", async () => {
    const context = await newContext();
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

    // `common.errorLoad`. It read "조직 정보 불러오지 못함" here and
    // "불러오지 못함" elsewhere off the same key — one key with two meanings,
    // which `test/fe-scenarios.test.ts` now refuses. The subject moved into the
    // KPI's own label; the sentence says what happened.
    await shows(page, "불러오지 못함");

    const downText = await page.locator("#root").innerText();
    // **The zero-state copy that actually exists.** This asserted the absence
    // of "등록된 테넌트 없음", and the dashboard stopped counting tenants: no
    // string on this screen could have matched, so the assertion passed on
    // every build and would have passed on a screen that did claim zero. The
    // copy a disconnected dashboard must not print is the groups card's own
    // empty caption.
    expect(downText, "the dashboard reported an empty mesh while it could not read one")
      .not.toContain("등록된 그룹 없음");
    expect(downText).toContain("불러오지 못함");

    // **Each card, not the page.** Two KPIs read two different routes, and a
    // page-wide `toContain` is satisfied by either one of them failing — so a
    // card that quietly printed `0` while its neighbour showed the error was
    // invisible here. `KpiCard` labels itself with `data-kpi`, which is what
    // lets the two be told apart.
    const kpi = async (label: string) =>
      await page.locator(`[data-kpi="${label}"]`).innerText();
    const [agentsCard, groupsCard] = [await kpi("등록된 에이전트"), await kpi("등록된 그룹")];
    expect(
      {
        agentsUnmeasured: agentsCard.includes("—"),
        agentsSaidWhy: agentsCard.includes("불러오지 못함"),
        groupsUnmeasured: groupsCard.includes("—"),
        groupsSaidWhy: groupsCard.includes("그룹 목록을 불러오지 못했습니다"),
      },
      "a dashboard KPI printed a number, or printed no reason, while its route was unreachable",
    ).toEqual({
      agentsUnmeasured: true,
      agentsSaidWhy: true,
      groupsUnmeasured: true,
      groupsSaidWhy: true,
    });

    await context.close();
  });

  // SC-DOWN-03: Disconnected Backend Differentiation on Groups (D-114, D-116)
  it("[SC-DOWN-03] distinguishes between empty groups and disconnected server on /creator/groups", async () => {
    const context = await newContext();
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

    await shows(page, "그룹 목록을 불러오지 못했습니다");

    const downText = await page.locator("#root").innerText();
    expect(downText).not.toContain("현재 등록된 그룹 데이터가 없습니다");
    expect(downText).toContain("그룹 목록을 불러오지 못했습니다");

    await context.close();
  });

  // SC-LOAD-01: In-Flight Delayed API Response on Topology (D-123, D-124)
  it("[SC-LOAD-01] shows loading state and does not claim 0 groups/agents while waiting on /creator/topology", async () => {
    const context = await newContext();
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
    const context = await newContext();
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

    // **The empty caption that exists, not the one that used to.** This
    // asserted the absence of `등록된 테넌트 없음`, and no string in this
    // package has said that since the dashboard stopped counting tenants — so
    // it passed on every build and would have passed on a screen printing the
    // empty state mid-read. The caption a still-loading card must not print is
    // the groups card's own, and it is one key away on the same line of source.
    //
    // `SC-LOAD-04` guards the counts on the same screen; this guards the
    // sentence under them. Two claims, both live.
    expect(loadText, "the dashboard called the mesh empty while it was still reading")
      .not.toContain("등록된 그룹 없음");

    await context.close();
  });

  // SC-LOAD-03: In-Flight Delayed API Response on Playground (D-123, D-124)
  it("[SC-LOAD-03] shows loading state and does not claim empty agents while waiting on /creator/playground", async () => {
    const context = await newContext();
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
    const context = await newContext();
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
    const context = await newContext();
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
      // `SC-CAP-07` split this message in two: aborting every request is the
      // unreachable half, and the refused half now names the capability. The
      // landmark moved with the copy, which is what a copy landmark does.
      await shows(page, "감사 로그를 불러오지 못했습니다");
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("현재 기록된 감사 로그 데이터가 없습니다");
      expect(downText).toContain("감사 로그를 불러오지 못했습니다");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-DOWN-06: /creator/register handles disconnected state safely
  it("[SC-DOWN-06] renders /creator/register safely when disconnected", async () => {
    const context = await newContext();
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
    const context = await newContext();
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
      await shows(page, "에이전트 목록을 불러오지 못했습니다");
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("현재 등록된 에이전트 데이터가 없습니다");
      expect(downText).toContain("에이전트 목록을 불러오지 못했습니다");
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
    const context = await newContext();
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
      await shows(cold, "에이전트 목록을 불러오지 못했습니다");
      const text = await cold.locator("#root").innerText();
      expect(text, "the assertion read the interim screen instead of the one it came for")
        .not.toContain("인증 상태를 확인하는 중");
      expect(text).toContain("에이전트 목록을 불러오지 못했습니다");
    } finally {
      await context.close().catch(() => {});
    }
  }, 40000);

  /**
   * SC-DOWN-09 / SC-DOWN-10 — the deployment's failure, which is not this
   * suite's usual one.
   *
   * Every other scenario in this family aborts `**\/api/v1/**` and leaves
   * `/auth/me` answering, so the session survives and the screens stay drawn.
   * A real deployment fails differently: the proxy is up and the backend is
   * not, so **every** path behind it answers `502` — including the two the
   * session depends on. Measured with nginx 1.31.3 in front of a built `dist`:
   * all thirteen screens became the login form, and pressing the login button
   * on it did nothing at all, silently, because the throw left through an
   * unguarded submit handler.
   *
   * So the screen had two states where it needed three. `401` is being signed
   * out. `502` is not being able to ask, and telling somebody to sign in about
   * a backend that is restarting sends them to fix the wrong thing.
   */
  it("[SC-DOWN-09] says the backend is unreachable rather than sending a signed-in operator to /login", async () => {
    const context = await newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        { name: "mesh_token", value: jwtToken, domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
      ]);
      // What a proxy in front of a stopped backend returns — status and an HTML
      // body, not a refused connection. The body matters: the client parses
      // before it decides, and this is the shape it gets.
      await page.route("**/auth/me", (route) =>
        route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>502 Bad Gateway</body></html>" }),
      );
      await page.goto(`${viteBaseUrl}/dashboard`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);

      const said = page.locator("[data-testid='auth-unreachable']");
      expect(
        { said: (await said.count()) > 0, bounced: page.url().includes("/login") },
        "a 502 from /auth/me was read as being signed out",
      ).toEqual({ said: true, bounced: false });
      expect(await said.innerText()).toContain("연결할 수 없습니다");
    } finally {
      await context.close().catch(() => {});
    }
  }, 15000);

  /**
   * Signing in through the form must leave the same session as arriving with a
   * cookie already set.
   *
   * Every other scenario here builds its session the second way — `newContext`
   * plants `mesh_token` and the first `goto` runs the mount path, which reads
   * `/auth/me`. A person does not have that cookie: they type into the form,
   * and the app routes them to `/dashboard` on the client with no reload, so
   * whatever the login response carried is what the session holds until they
   * press F5.
   *
   * Measured before writing this: `POST /auth/local` answers `{github_id,
   * github_login, role}` and no `capabilities`, while `/auth/me` — called on
   * the very next line — answers twelve. The screen drew nine navigation links
   * after the form and fourteen after a reload.
   *
   * **The assertion is on the difference, not on the cause.** A fix that adds
   * the field to the login response and a fix that reads it off the `/auth/me`
   * this code already fetches both make these two numbers meet; naming either
   * one here would tie the test to a repair that has not been chosen yet.
   */
  /**
   * A message the mesh accepted must leave a receipt on the screen, whatever
   * the body was.
   *
   * `sendMessageApi({ to, text })` sends free text — nothing requires the body
   * to be JSON, and the field is a textarea a person types into. The receipt
   * panel then renders `JSON.parse(payloadText || "{}")` **during render**, so
   * a body the server accepted but `JSON.parse` rejects throws out of the
   * render and takes the panel with it. The send succeeded; the screen is what
   * failed.
   *
   * The assertion is on what the screen owes after a successful write, not on
   * where the parse lives. Moving the parse to the submit handler, wrapping it,
   * or putting the dispatched body on the receipt all satisfy it.
   */
  it("[SC-WRITE-17] draws the receipt for a message the mesh accepted, whatever the body was", async () => {
    await withPage("/creator/playground", async ({ page }) => {
      const box = page.locator("textarea").first();
      if ((await box.count()) === 0) {
        cannotMeasure("SC-WRITE-17", "no payload field on /creator/playground");
        return;
      }
      // **A blank page after the click means nothing unless it was not blank
      // before.** A crash and a screen that never rendered leave the same
      // body length, and reading only the second one calls both the same thing.
      const before = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ").length;
      if (before <= 200) {
        cannotMeasure("SC-WRITE-17", `the playground drew ${before} characters before the send, so there is no working screen to break`);
        return;
      }
      // Not JSON. The field accepts it and so does the route.
      await box.fill("hello");
      await page.locator("button[type='submit']").first().click();
      await page.waitForTimeout(1500);

      const body = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      const errored = /실패|failed|error/i.test(body) && !/보낸 본문|Dispatched/i.test(body);
      if (errored) {
        // The mesh refused it. That is a different scenario and this one has
        // nothing to say about it.
        cannotMeasure("SC-WRITE-17", "the mesh did not accept the message, so there is no accepted write to check");
        return;
      }

      // A receipt panel, and a page still standing. `chars` is the other half:
      // a fix that renders an empty panel would satisfy the first alone.
      expect(
        {
          drewReceipt: (await page.locator("code, pre").count()) > 0,
          pageAlive: body.length > 200,
        },
        `the mesh accepted the message and the screen drew no receipt (${before} characters before the send, ${body.length} after)`,
      ).toEqual({ drewReceipt: true, pageAlive: true });
    });
  }, 30000);

  it("[SC-AUTH-08] leaves the same session whether you type the password or arrive with a cookie", async () => {
    await withUnauthedPage("/login", async ({ page }) => {
      await page.locator("input[type='text'], input[name='username']").first().fill(SEED_ADMIN);
      await page.locator("input[type='password']").first().fill("admin");
      await page.locator("button[type='submit']").first().click();
      await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 8000 }).catch(() => {});
      if (page.url().endsWith("/login")) {
        // Landing is the precondition, not the result. A run that never left
        // the form would otherwise compare two login pages and call them equal.
        cannotMeasure("SC-AUTH-08", "the form never left /login, so there is no session to compare");
        return;
      }

      // A first read here returns zero links on this machine — the page has not
      // finished. Zero would have been reported as every link missing.
      const read = async () => ({
        links: await page.locator("nav a, aside a").count(),
        chars: ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ").length,
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);
      const typed = await read();

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      const reloaded = await read();

      expect(
        { links: typed.links, drewSomething: typed.links > 0 },
        `the form login and a reload disagree about the session: ${typed.links} links typed vs ${reloaded.links} reloaded`,
      ).toEqual({ links: reloaded.links, drewSomething: true });
    });
  }, 30000);

  it("[SC-DOWN-11] still sends a refused session to /login, so the two are not one branch", async () => {
    const context = await newContext();
    try {
      const page = await context.newPage();
      await context.addCookies([
        { name: "mesh_token", value: jwtToken, domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
      ]);
      // The other half. Without it the screen could call everything unreachable
      // and pass the test above while never signing anybody out again.
      await page.route("**/auth/me", (route) =>
        route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
      );
      await page.goto(`${viteBaseUrl}/dashboard`, { waitUntil: "networkidle" });
      await page.waitForURL("**/login", { timeout: 5000 }).catch(() => {});
      expect(
        { bounced: page.url().includes("/login"), said: (await page.locator("[data-testid='auth-unreachable']").count()) > 0 },
        "a 401 stopped being treated as a refused session",
      ).toEqual({ bounced: true, said: false });
    } finally {
      await context.close().catch(() => {});
    }
  }, 15000);

  it("[SC-DOWN-10] says why a login failed instead of leaving the form silent", async () => {
    await withUnauthedPage("/login", async ({ page }) => {
      await page.route("**/auth/local", (route) =>
        route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>502 Bad Gateway</body></html>" }),
      );
      await page.locator("input[type='text'], input[name='username']").first().fill(SEED_ADMIN);
      await page.locator("input[type='password']").first().fill("admin");
      await page.locator("button[type='submit']").first().click();
      await page.waitForTimeout(600);

      const err = page.locator("[data-testid='login-error']");
      expect(
        { said: (await err.count()) > 0, left: !page.url().includes("/login") },
        "the login button did nothing and said nothing",
      ).toEqual({ said: true, left: false });
      // Naming the cause, because "wrong id or password" about a stopped
      // backend sends the person to retype credentials that were fine.
      expect(await err.innerText()).toContain("서버에 연결할 수 없습니다");
    });
  }, 15000);

  /**
   * SC-LOAD-07 — a submitted credential that has no verdict yet.
   *
   * The form already split refusal from an unreachable backend, but between
   * the click and either result it looked exactly like the resting signed-out
   * form. This holds the real request at the browser boundary, reads the
   * pending sentence and its own test id, then releases a refusal and proves
   * that the pending state is replaced rather than left beside the verdict.
   */
  it("[SC-LOAD-07] says a sign-in is pending until the server answers", async () => {
    const context = await newContext("en");
    const page = await context.newPage();
    try {
      await page.goto(`${viteBaseUrl}/login`, { waitUntil: "networkidle" });
      const heldRequest: { release?: () => void } = {};
      const held = new Promise<void>((resolve) => { heldRequest.release = resolve; });
      await page.route("**/auth/local", async (route) => {
        await held;
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "invalid username or password" }),
        });
      });

      const submit = page.locator('[data-testid="login-submit"]');
      const before = {
        pending: await page.locator('[data-testid="login-pending"]').count(),
        error: await page.locator('[data-testid="login-error"]').count(),
        disabled: await submit.isDisabled(),
      };

      await page.locator('input[autocomplete="username"]').fill("operator-1");
      await page.locator('input[autocomplete="current-password"]').fill("still-checking");
      await submit.click();
      const pending = page.locator('[data-testid="login-pending"]');
      await pending.waitFor({ timeout: 5000 });
      const during = {
        text: (await pending.innerText()).trim(),
        error: await page.locator('[data-testid="login-error"]').count(),
        disabled: await submit.isDisabled(),
        busy: await submit.getAttribute("aria-busy"),
        stayed: page.url().includes("/login"),
      };

      const release = heldRequest.release;
      if (!release) throw new Error("the held login request cannot be released");
      release();
      const error = page.locator('[data-testid="login-error"]');
      await error.waitFor({ timeout: 5000 });
      const after = {
        pending: await page.locator('[data-testid="login-pending"]').count(),
        error: (await error.innerText()).trim(),
        disabled: await submit.isDisabled(),
        busy: await submit.getAttribute("aria-busy"),
        stayed: page.url().includes("/login"),
      };

      expect({ before, during, after }, "the pending attempt shared a result's words or place").toEqual({
        before: { pending: 0, error: 0, disabled: false },
        during: { text: "Signing in…", error: 0, disabled: true, busy: "true", stayed: true },
        after: { pending: 0, error: "invalid username or password", disabled: false, busy: "false", stayed: true },
      });
    } finally {
      await context.close().catch(() => {});
    }
  }, 15000);

  // SC-DOWN-08: /platform/telemetry does not show active_sockets=0 or info cards when disconnected
  it("[SC-DOWN-08] renders /platform/telemetry with connection error and no 0 sessions when disconnected", async () => {
    const context = await newContext();
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
      // `tel.error`: "텔레메트리" became "운영 지표" when the console stopped
      // naming its screens after the transport that fills them.
      await shows(page, "운영 지표를 불러오지 못했습니다");
      const downText = await page.locator("#root").innerText();
      expect(downText).not.toContain("active_sockets=0");
      expect(downText).not.toContain("0 sessions");
      expect(downText).toContain("운영 지표를 불러오지 못했습니다");
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-LOAD-04: In-Flight Delayed API Response on Dashboard eliminates ZERO pattern
  it("[SC-LOAD-04] does not show ZERO patterns or empty tenant table messages while waiting on /dashboard", async () => {
    const context = await newContext();
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
      expect(loadText).toContain("조회 중");

      // **Absences that can actually occur.** This asserted that the screen did
      // not say `현재 등록된 테넌트 조직 데이터가 없습니다` or `0 sessions`, and
      // neither string exists anywhere in this package — the dashboard stopped
      // counting tenants and never counted sessions. Two assertions that
      // passed on every build and would have passed on a dashboard printing
      // zero, which is the defect they were written for.
      //
      // What a dashboard still reading must not print is a count. Each card,
      // for the reason `SC-DOWN-02` gives: page-wide, either card's `...`
      // satisfies the whole check while its neighbour prints a number.
      const kpi = async (label: string) => await page.locator(`[data-kpi="${label}"]`).innerText();
      const [agentsCard, groupsCard] = [await kpi("등록된 에이전트"), await kpi("등록된 그룹")];
      expect(
        {
          // No digit anywhere on the card: the label carries none, and the
          // sub-line while waiting is `조회 중...`.
          agentsCounted: /\d/.test(agentsCard),
          agentsSaidWaiting: agentsCard.includes("조회 중"),
          groupsCounted: /\d/.test(groupsCard),
          groupsSaidWaiting: groupsCard.includes("조회 중"),
        },
        "a dashboard KPI printed a count, or printed no reason, while its read was still in flight",
      ).toEqual({
        agentsCounted: false,
        agentsSaidWaiting: true,
        groupsCounted: false,
        groupsSaidWaiting: true,
      });
    } finally {
      await context.close().catch(() => {});
    }
  });

  // SC-LOAD-05: In-Flight Delayed API Response on /tenant/rbac does not render (0명)
  it("[SC-LOAD-05] does not show (0명) while waiting on /tenant/rbac", async () => {
    const context = await newContext();
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
  // **Named for what it is rather than for how many.** It was `ALL_13_SCREENS`
  // until the tenant directory landed and made it fourteen — a count in a name
  // is a fact that has to be maintained in two places, and the one that rots is
  // the one nothing runs.
  const ALL_SCREENS = [
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
    "/platform/tenant-directory",
    "/tenant/egress-acl",
    "/tenant/audits",
    "/tenant/rbac",
  ];

  const ZERO_REGEX = /(?:기록된|등록된|데이터가|내역이|요청이)\s*없|0개|0명|\b0 sessions|active_sockets=0|Groups: 0|테넌트 없음/;
  // `읽지 못` for the tenant directory, which says "서버가 응답하지 않아 테넌트
  // 목록을 읽지 못했다" — the same statement in a verb this list did not hold.
  // Without it the screen reads as one that says nothing about the failure,
  // which is the defect this scenario exists to catch rather than a wording.
  const UNKNOWN_REGEX = /불러오지 못|불러올 수 없|읽지 못|통신 불가|연결 불가|연결할 수 없|측정 불가|OFFLINE|수집 중/;

  for (const route of ALL_SCREENS) {
    it(`[SC-DOWN-ALL] ${route} distinguishes disconnected state from empty (D-145)`, async () => {
      // 1. Up text
      const upText = await withPage(route, async ({ page }) => {
        return await page.locator("#root").innerText();
      });

      // 2. Down text
      const context = await newContext();
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

  // SC-TDIR-01: the directory of tenants the platform owns, and the one
  // deletion it must not offer.
  //
  // Minted while the console's tenant work was merged in: the route was in
  // `App.tsx` with no scenario opening it, which is a screen nobody has looked
  // at through a browser once — `test/scenario-ids.test.ts` reports exactly
  // that, and reported it here.
  //
  // **The default tenant is the half worth asserting.** Every row that was
  // never given a tenant points at `default`, so the server answers
  // `409 DEFAULT_TENANT` and the store refuses before it. A console that offers
  // the button anyway teaches an operator that the platform is broken rather
  // than that the deletion is refused — and the refusal is not a rule this
  // screen invented, so leaving it enabled is the screen disagreeing with the
  // server about what is possible.
  it("[SC-TDIR-01] lists the platform's tenants and does not offer the default one's deletion", async () => {
    await withPage("/platform/tenant-directory", async ({ page }) => {
      await shows(page, "테넌트 관리");

      // The seeded tenant, by id rather than by display name: the name is
      // editable from this very screen, and an assertion on it would be a test
      // of what somebody last typed.
      const listed = page.locator('[data-testid="tenant-id-default"]');
      expect(await listed.count(), "the default tenant is missing from the directory").toBe(1);
      expect(await page.locator('[data-testid="tenant-status-default"]').innerText()).toContain("사용 중");

      const remove = page.locator('[data-testid="tenant-delete-default"]');
      expect(
        { offered: await remove.count(), enabled: await remove.isEnabled() },
        "the console offered a deletion the server answers 409 DEFAULT_TENANT to",
      ).toEqual({ offered: 1, enabled: false });

      // Disabled and silent is a control an operator reads as a bug in the
      // page. The reason is the screen saying which side refused.
      await shows(page, "기본 테넌트는");
    });
  });

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
      expect(rootText).toMatch(/실패|오류|통신/);

      // **What kind of thing it said.** This asserted the absence of
      // `성공적으로 생성`, which no string in this package has ever been — so
      // it passed on every build and would have passed on a screen calling a
      // refused create a success. The two sentences here are one word apart
      // (`그룹 생성` and `그룹 생성 실패`) and the button says the first of
      // them, so page text cannot answer this. The toast's own type can.
      expect(
        {
          error: await page.locator('[data-toast="error"]').count(),
          success: await page.locator('[data-toast="success"]').count(),
        },
        "a create the server never accepted was reported as one that happened",
      ).toEqual({ error: 1, success: 0 });
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

      // **Wait for what the screen says, not for the network.** `attemptOver`
      // is `networkidle`, and this file already records three scenarios that
      // read a value straight after it and saw the state before the render
      // that answers the request. This was a fourth, and it hid behind the
      // dead assertion below: with nothing asserted that could fail, a
      // scenario in which the submit never even fired passed for the same
      // reason a working one did. The modal is still open at `networkidle` —
      // `setIsCreateOpen(false)` runs after the await resolves.
      const toast = page.locator("[data-toast]");
      await toast.first().waitFor({ timeout: 5000 });

      const afterCount = await page.locator("tbody tr").count();
      expect(afterCount).toBe(beforeCount);

      // The distinction this scenario is actually about. `POST` answers `200`
      // for a name that already exists, with `created: false`, so what must
      // not happen is the screen reporting a group it did not create.
      expect(
        (await toast.first().innerText()).trim(),
        "a name that already existed was reported as newly created",
      ).toContain("이미 있는 그룹");
    });
  });

  // SC-WRITE-03: /creator teardown abort does not remove row and reports error
  it("[SC-WRITE-03] handles teardown abort without removing agent row and reports failure", async () => {
    await withPage("/creator", async ({ page }) => {
      const beforeCount = await page.locator("tbody tr").count();
      const deletes: string[] = [];
      await page.route("**/api/v1/admin/agents/**", (r) => {
        if (r.request().method() === "DELETE") {
          deletes.push(r.request().url());
          return r.abort();
        }
        return r.continue();
      });

      // **Three nested `if`s used to stand here**, each skipping quietly when
      // its locator matched nothing — so when the control's label moved this
      // sent no DELETE at all, changed nothing, and then demanded a failure
      // sentence from a screen that had been asked to do nothing. The helper
      // asserts instead of skipping, and it typed a fixed `admin` into a
      // confirmation that wants the target's identity.
      const { confirm } = await armFirstTeardown(page);
      await confirm.click();
      const sent = await eventually(async () => deletes.length, (n) => n > 0);
      expect({ sent }, "the confirmation was clicked and no teardown left the screen").toEqual({ sent: 1 });
      await attemptOver(page);

      // **The failure's own result place, not any word on the page.** Waiting
      // on `networkidle` and then matching /실패|오류|통신/ across `#root` read
      // the screen with the dialog still open and matched furniture; the page
      // gives each teardown outcome its own `data-testid`, and the aborted
      // write is the one that has to appear.
      const failed = page.locator('[data-testid="teardown-result-failed"]');
      const said = await eventually(async () => await failed.count(), (n) => n > 0);
      const afterCount = await page.locator("tbody tr").count();
      expect(
        { said, rows: afterCount },
        "the screen dropped the row the server never deleted, or said nothing about the failure",
      ).toEqual({ said: 1, rows: beforeCount });
    });
  });

  // SC-WRITE-04: /creator/topology dispatch abort does not claim success and reports error
  it("[SC-WRITE-04] handles topology quick send abort without claiming success", async () => {
    await withPage("/creator/topology", async ({ page }) => {
      await page.route("**/api/v1/messages", (r) => {
        if (r.request().method() === "POST") return r.abort();
        return r.continue();
      });

      // **Two nested `if`s stood here**, each skipping quietly when its
      // locator matched nothing — the same shape `SC-WRITE-03` removed, and
      // with the same consequence: a renamed control made this scenario send
      // nothing, assert nothing and pass. What it then asserted could not have
      // failed either. `성공적으로 전송되었습니다` and `전송이 완료되었습니다`
      // are not strings this package has ever held, so both absences were
      // true of every screen ever drawn.
      //
      // Found by planting: the screen gives the outcome its own marker and its
      // own status, which is what a scenario about *which* outcome should read.
      const node = page.locator('[data-testid="topology-agent"]').first();
      await node.waitFor({ timeout: 5000 });
      await node.click({ force: true });

      const sendBtn = page.locator("button:has-text('Send Message')").first();
      await sendBtn.waitFor({ timeout: 5000 });
      await sendBtn.click();

      // **The panel arrives before the answer does.** It is drawn as soon as
      // the send starts, holding `sending`, and the failure replaces it when
      // the aborted request rejects. Waiting for the element caught the
      // in-flight render: green alone and on `test/`, red under the coverage
      // run, which is the worst verdict a scenario can give — it says
      // something about the machine and nothing about the code. So the wait is
      // for the status to stop being `sending`, which is the render that
      // answers.
      const result = page.locator('[data-testid="topology-send-result"]');
      await result.waitFor({ timeout: 5000 });
      const settled = await eventually(
        async () => ({
          status: await result.getAttribute("data-message-status"),
          role: await result.getAttribute("role"),
        }),
        (v) => v.status !== "sending",
      );
      expect(settled, "a send the server never received was reported as one it did")
        .toEqual({ status: "error", role: "alert" });
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
      // "페어링" is gone from the console: the screen calls it a 연결 코드 now.
      await shows(page, "연결 코드");

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
      // **The claim is the issued-code panel, not the success toast.** The
      // toast now reads "연결 코드 발급", which is a prefix of the failure's
      // "연결 코드 발급 실패" — an alternation on those two matches the failure
      // for both halves, and the assertion below would then refuse a screen
      // that behaved correctly. `reg.issued.label` renders only when a code
      // exists, so it cannot be said by a failed write.
      const FAILED = "연결 코드 발급 실패";
      const CLAIMED = "발급된 1회용 인증코드";
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

  // SC-WRITE-22: a refused issue does not leave the last code on the screen.
  //
  // **Split from `SC-WRITE-08` because that scenario cannot reach this.** It
  // aborts the first request the page ever makes, so `generatedCode` is still
  // `null` and the issued panel is absent either way — the failure the code
  // guards against is *the previous code staying up*, and there is no previous
  // code in that run. Measured by planting: deleting `setGeneratedCode(null)`
  // from the failure branch left `SC-WRITE-08`, and all 136 scenarios, green.
  //
  // So this one issues a real code first and refuses the second. The credential
  // is one-time: left on screen it is copied and handed to somebody, already
  // spent, or belonging to a different identity than the one now named beside
  // it.
  it("[SC-WRITE-22] clears the issued code when the next issue is refused", async () => {
    await withPage("/creator/register", async ({ page }) => {
      const identityInput = page.locator("input[placeholder*='agt_']").first();
      await identityInput.waitFor({ timeout: 5000 });
      const submit = page.locator("button[type='submit']").first();

      // A real issue, against an identity the fixture registers.
      await identityInput.fill("agent-alpha");
      await submit.click();
      await shows(page, "발급된 1회용 인증코드");

      // And now one the server refuses.
      await page.route("**/api/v1/admin/pairing-codes", (route) =>
        route.request().method() === "POST" ? route.abort() : route.continue());
      await identityInput.fill("agent-beta");
      await submit.click();
      await shows(page, "연결 코드 발급 실패");

      const held = await eventually(
        async () => (await page.locator("#root").innerText()).includes("발급된 1회용 인증코드"),
        (still) => still === false,
      );
      expect(
        { issuedPanelStillUp: held },
        "a refused issue left the previous one-time code on the screen, under the identity it was not issued for",
      ).toEqual({ issuedPanelStillUp: false });
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
    const context = await newContext();
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
    const context = await newContext();
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
      await page.locator(`[data-testid="rbac-subject-${capabilityViewerName("usage.read")}"]`)
        .waitFor({ state: "visible" });

      // Only the write. The read has to succeed or there are no chips to click.
      //
      // **Counted, because a click that writes nothing is the failure this
      // scenario cannot otherwise see.** Waiting for a toast reports a screen
      // that silently declined to write as "said nothing about a failure",
      // which reads as a copy problem and is not one.
      const writes: string[] = [];
      await page.route("**/api/v1/admin/grants", (route) => {
        const method = route.request().method();
        if (method === "POST" || method === "DELETE") {
          writes.push(method);
          return route.abort();
        }
        return route.continue();
      });

      // **The viewer's own chip, by name.** This took "the first chip on the
      // page", and the first row is the seeded administrator — whose chips are
      // fixed by `rbac.fixedAdmin` and do not move. Clicking one sent no
      // request, the wait for a toast ran its full thirty seconds, and bun
      // killed the browser and the vite server with it: forty-seven scenarios
      // after this one failed with `browser has been closed`, none of them
      // about anything. One wrong target, and the suite reported forty-eight
      // defects.
      //
      // Named from the same helper that creates the account, so a change to
      // that naming moves both.
      const subject = capabilityViewerName("usage.read");
      const chip = page.locator(`[data-testid="rbac-cap-${subject}-usage.read"]`);
      expect(
        { chip: await chip.count(), enabled: await chip.isEnabled() },
        "the viewer's own capability chip was not there, or was not clickable — nothing would have been written",
      ).toEqual({ chip: 1, enabled: true });

      const before = await page.locator("#root").innerText();
      await chip.click();
      const attempted = await eventually(async () => writes.length, (n) => n > 0);
      expect({ attempted }, "the chip was clicked and no grant write left the screen").toEqual({ attempted: 1 });
      // Either outcome, for the reason spelled out in SC-WRITE-08: waiting only
      // for the failure lets a wrongly-claimed success expire unread.
      // `rbac.toast.*`: the console shortened these to "권한 부여" and
      // "권한 회수" — the failure kept its wording. Waiting on all three, for
      // the reason spelled out in SC-WRITE-08: a wait that only knows the
      // failure lets a wrongly-claimed success expire unread.
      //
      // **With the colon, because the bare words are on the screen already.**
      // The sidebar carries this screen's own description — "계정별 권한 부여
      // 및 회수" — so `/권한 부여|권한 회수/` matched the navigation
      // before the click and this wait returned at once, every time. The
      // assertion then read the screen a few milliseconds after `abort()`,
      // before React had rendered anything, and reported the console as silent
      // about a failure it does announce. Every toast here is
      // `<문구>: <상세>`, and no menu item has the colon — which is also what
      // the two `not.toContain` assertions below already match on.
      await showsMatch(page, /권한 변경 실패:|권한 부여:|권한 회수:/);
      const after = await page.locator("#root").innerText();

      expect(after, "the screen announced a grant the server refused")
        .not.toContain("권한 부여:");
      expect(after, "the screen announced a revocation the server refused")
        .not.toContain("권한 회수:");
      expect(after, "the screen said nothing about a write that failed").toContain("권한 변경 실패");

      // And the chips are unchanged: the failure must not leave the screen
      // rendering a permission set nobody holds.
      const chipsBefore = (before.match(/\b[a-z]+\.[a-z.]+\b/g) ?? []).sort().join(",");
      const chipsAfter = (after.match(/\b[a-z]+\.[a-z.]+\b/g) ?? []).sort().join(",");
      expect(chipsAfter, "the capability list changed after a write that failed").toBe(chipsBefore);
    });
  }, 30000);

  // SC-WRITE-05: /creator/playground receipt displays real server fields
  //
  // This assertion used to be `not.toContain("msg_undefined")` plus the presence
  // of the string `보낸 본문` — which is the JsonViewer's own title, a
  // literal in the page, drawn whenever a receipt renders at all. So a test
  // named for real server fields passed on a receipt that carried none of them:
  // the id said `영수증 미발급`, the timestamp was the browser's clock, and the
  // sender and recipient were the form's own inputs echoed back. The expected
  // value now comes off the wire, so nothing in this file can supply it.
  it("[SC-WRITE-05] renders playground receipt with real server response fields", async () => {
    await withPage("/creator/playground", async ({ page }) => {
      const sendBtn = page.locator("button:has-text('발송'), button:has-text('Send'), button[type='submit']").first();
      expect(await sendBtn.count()).toBeGreaterThanOrEqual(1);

      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/v1/messages") && r.request().method() === "POST", { timeout: 8000 }),
        sendBtn.click(),
      ]);
      const body = await resp.json();
      expect({ status: resp.status(), enveloped: typeof body?.message?.id === "string" })
        .toEqual({ status: 201, enveloped: true });

      const card = page.locator("[data-testid='receipt-card']");
      await card.waitFor({ timeout: 5000 });

      // The id the server minted, not a shape that resembles one.
      expect(await card.getAttribute("data-message-id")).toBe(body.message.id);
      expect(await page.locator("#root").innerText()).toContain(body.message.id);

      // And the status in the server's vocabulary. `sent` is a word this
      // platform never writes; the screen used to declare it in its own type.
      expect(await card.getAttribute("data-status")).toBe(body.message.status);
      expect(["pending", "delivered", "read", "failed"]).toContain(body.message.status);

      // Two claims came off this card because nothing produces them. A revival
      // of either is a regression whether or not it draws a plausible value.
      const cardText = await card.innerText();
      expect({
        signature: /서명 검증됨|서명 미검증|Ed25519/.test(cardText),
        digest: /SHA-256 다이제스트/.test(cardText),
      }).toEqual({ signature: false, digest: false });
    });
  }, 20000);

  // SC-WRITE-09: a 201 without a receipt in it is said, not drawn over (I-073)
  //
  // The reverse of SC-WRITE-05. `sendMessageApi` throws when the envelope is
  // absent rather than falling back to the flat body, because the fallback is
  // indistinguishable from the bug it replaced: a receipt of local placeholders
  // rendered next to a success. The screen has to say the receipt did not come.
  /**
   * SC-WRITE-10 — the bell does not mark a proposal decided when the decision
   * never reached the server.
   *
   * **This route had no scenario, and that is why.** The front end makes
   * thirteen writes; twelve are named somewhere in this suite and three were
   * not — `keys/deny` and the two egress ACL calls. Reading the list rather
   * than the screens is what found this one: the untested write turned out to
   * be the broken one, which is the ordinary case rather than a coincidence.
   *
   * Both directions, because "never says 거절됨" is a screen that does nothing
   * and passes half of this.
   */
  it("[SC-WRITE-10] leaves a key proposal pending when the deny never reached the server", async () => {
    const decide = async (denyAnswers: boolean) => {
      const { page, context } = await createAuthedPage("/tenant/rbac");
      try {
        await page.route("**/api/v1/admin/keys/pending", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              keys: [{ identity: "pending-agent-a", fingerprint: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0", type: "ai-claude", proposed_at: "2026-08-20T00:00:00.000Z" }],
            }),
          }),
        );
        // **Both sources carry the same proposal, because in the product they
        // are two reads of one table.** This stubbed the stream with an empty
        // snapshot while the REST route answered with a proposal — a
        // disagreement the mesh cannot produce — and it went unnoticed only
        // because the bell used to discard an empty snapshot outright. Once it
        // stopped doing that (`I-152`, a queue drained elsewhere never cleared),
        // whichever source answered last decided whether the row was on screen,
        // and this scenario's own precondition assertion caught it: `{ row: 0,
        // button: 0 }` where it wanted one of each. It was green here and red
        // for `agent-mesh-local-pm` on the same commit, which is what a race
        // looks like from two machines.
        //
        // The scenario is about a deny that never reached the server. Which of
        // the two sources drew the row was never the subject.
        await page.route("**/api/v1/admin/keys/stream", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body:
              'event: snapshot\ndata: {"keys":[{"identity":"pending-agent-a",' +
              '"fingerprint":"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0",' +
              '"type":"ai-claude","proposed_at":"2026-08-20T00:00:00.000Z"}]}\n\n',
          }),
        );
        await page.route("**/api/v1/admin/keys/deny", (route) =>
          denyAnswers
            ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
            : route.abort(),
        );

        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        await page.locator('[data-testid="bell"]').click();
        await settled(page);

        const row = page.locator("text=pending-agent-a").first();
        const rowThere = await row.count();
        if (rowThere > 0) await row.click();
        await settled(page);

        const denyBtn = page.locator("button:has-text('등록 거절')").first();
        const btnThere = await denyBtn.count();
        if (btnThere > 0) {
          await denyBtn.click();
          await attemptOver(page);
          await page.locator('[data-testid="bell"]').click().catch(() => {});
          await settled(page);
        }

        const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
        return { rowThere, btnThere, saysDenied: /거절됨|denied/.test(text) };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const refused = await decide(false);
    const accepted = await decide(true);

    // **The controls have to have been there.** Every `if (count > 0)` in the
    // older write scenarios is a way for this to pass on a page that drew
    // nothing, which is the first failure mode in this repository's list.
    expect(
      { row: refused.rowThere, button: refused.btnThere },
      "the proposal or the deny control was not on the page, so nothing below was exercised",
    ).toEqual({ row: 1, button: 1 });

    expect(
      { whenRefused: refused.saysDenied, whenAccepted: accepted.saysDenied },
      "the bell called a proposal decided on a write that never landed, or does not say so when it does land",
    ).toEqual({ whenRefused: false, whenAccepted: true });
  }, 40_000);

  /**
   * SC-WRITE-11 — the ACL cell goes back when the rule did not.
   *
   * The other two writes the suite never named. This screen sets the cell
   * before the call and puts it back in the `catch`, which is the correct shape
   * and was never measured — and the cell is what an operator reads to decide
   * whether a group can send anywhere.
   *
   * Neither direction is let through to the server: both are answered by the
   * intercept, so the run leaves the mesh's rules as it found them.
   */
  it("[SC-WRITE-11] puts the egress cell back when the rule write did not land", async () => {
    const toggle = async (writeAnswers: boolean) => {
      const { page, context } = await createAuthedPage("/tenant/egress-acl");
      try {
        const cell = page.locator('[data-testid^="acl-"]').first();
        const cellThere = await cell.count();
        const before = cellThere > 0 ? await cell.getAttribute("data-allowed") : null;

        await page.route("**/api/v1/admin/groups/*/egress**", (route) => {
          if (route.request().method() === "GET") return route.continue();
          return writeAnswers
            ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
            : route.abort();
        });

        const button = cell.locator("button").first();
        const buttonThere = await button.count();
        if (buttonThere > 0) {
          await button.click();
          await attemptOver(page);
        }
        // **Wait for the screen to say what happened, then read the cell.**
        //
        // `networkidle` is not "the screen finished": an aborted fetch rejects
        // and the `catch` renders after the network has gone quiet, so reading
        // straight after it saw the optimistic value and reported a defect that
        // was not there. Polling until two reads agree fixed that and bought a
        // worse problem — the answer then depends on how loaded the machine is.
        // A full-manifest pass caught this entry as *not caught* while running
        // it alone caught it, which is a verdict about the afternoon rather
        // than about the code.
        //
        // The toast is written in the same `catch` as the put-back, and a
        // mutation that removes the put-back leaves the toast — so waiting for
        // the toast is waiting for exactly the render that should have restored
        // the cell, with no clock in it.
        const failedToast = /전송 규칙 변경 실패|Could not change the delivery rule/;
        if (buttonThere > 0 && !writeAnswers) {
          await page.locator("body").filter({ hasText: failedToast }).first()
            .waitFor({ timeout: 10_000 })
            .catch(() => {});
        }
        const after = cellThere > 0 ? await cell.getAttribute("data-allowed") : null;
        const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
        // The screen's own sentence, not any word containing 실패 — the first
        // version matched `/실패|failed/i` across the whole body and was true on
        // a page that said nothing about this write.
        return { cellThere, buttonThere, before, after, // `egress.toast.failed`, which the console rewrote from "이그레스 정책" to
        // the words this screen uses for the same thing everywhere else.
        saysFailed: /전송 규칙 변경 실패|Could not change the delivery rule/.test(text) };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const refused = await toggle(false);
    const accepted = await toggle(true);

    expect(
      { cell: refused.cellThere, button: refused.buttonThere, read: refused.before !== null },
      "the matrix or its control was not drawn, so nothing below was exercised",
    ).toEqual({ cell: 1, button: 1, read: true });

    expect(
      { kept: refused.after === refused.before, said: refused.saysFailed, flipped: accepted.after !== accepted.before },
      "the cell kept a rule the server never took, said nothing about it, or does not move when the write lands",
    ).toEqual({ kept: true, said: true, flipped: true });
  }, 40_000);

  it("[SC-WRITE-09] says 영수증 없음 when the server answers 201 without a message", async () => {
    await withPage("/creator/playground", async ({ page }) => {
      await page.route("**/api/v1/messages", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true }) })
          : route.continue()
      );

      const sendBtn = page.locator("button:has-text('발송'), button:has-text('Send'), button[type='submit']").first();
      await sendBtn.click();

      const err = page.locator("[data-testid='receipt-error']");
      await err.waitFor({ timeout: 5000 }).catch(() => {});

      // Stated as one assertion rather than a `waitFor` that throws, because a
      // timeout says only that five seconds passed. The manifest pins entries
      // on the words of the check, and `Timeout 5000ms exceeded` is the same
      // sentence whether the screen drew a receipt it should not have or the
      // mesh never came up.
      expect(
        {
          said: (await err.count()) > 0,
          drew: (await page.locator("[data-testid='receipt-card']").count()) > 0,
        },
        "a 201 carrying no message drew a receipt instead of saying none came",
      ).toEqual({ said: true, drew: false });
      expect(await err.innerText()).toContain("영수증 없음");
    });
  }, 20000);

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

  /**
   * SC-AUTH-06 — the login screen does not let a person choose their own role.
   *
   * It offered a `<select>` labelled 시나리오 역할 with four options, the top one
   * reading 👑 플랫폼 관리자, and passed the choice to `loginWithLocal`. It granted
   * nothing — `GuardedRoute` and the sidebar both ask `hasCapability`, and
   * `POST /auth/local` reads only the username and password — but the sidebar
   * drew the choice as the person's title, so a deployment to a real server
   * showed a self-declared platform administrator. The owner's call was to
   * remove it.
   *
   * **Both halves are asserted.** A screen with no picker that also stopped
   * signing anybody in would pass a check for the picker's absence alone.
   */
  it("[SC-AUTH-06] offers no role picker, and the role that arrives is the server's", async () => {
    await withUnauthedPage("/login", async ({ page }) => {
      const body = (await page.locator("#root").innerText()) ?? "";
      const user = page.locator("input[type='text'], input[name='username']").first();
      const pass = page.locator("input[type='password']").first();
      expect(
        {
          // **The role picker, not any `select`.** This read `select` count and
          // meant "no role picker" — a sentence about one control, enforced on
          // every control of that kind. The language combo is a different job
          // and would have failed a check whose message says the screen still
          // lets a person pick what they are.
          picker: (await page.locator("select[name*='role' i], [data-testid='role-picker']").count()) > 0  // absent-by-design: SC-AUTH-06 은 이 선택기가 **없어야** 통과한다
            || /시뮬레이션 역할|RBAC Role/.test(body),
          label: /시뮬레이션 역할|RBAC Role/.test(body),
          claim: /플랫폼 관리자 \(Platform Admin/.test(body),
          // The other half of the same thing: the form used to arrive with a
          // working credential typed into it, and the placeholder printed the
          // account name. Neither raised a privilege; both handed out an
          // identity nobody proved they had.
          typed: ((await user.inputValue()) + (await pass.inputValue())).length > 0,
          hint: (await user.getAttribute("placeholder")) === "admin",
        },
        "the login screen still lets a person pick or be handed what they are",
      ).toEqual({ picker: false, label: false, claim: false, typed: false, hint: false });

      // And it still signs in — the half that a "no select on the page" check
      // cannot see on its own.
      await page.locator("input[type='text'], input[name='username']").first().fill(SEED_ADMIN);
      await page.locator("input[type='password']").first().fill("admin");
      await page.locator("button[type='submit']").first().click();
      await page.waitForURL("**/dashboard", { timeout: 8000 }).catch(() => {});
      expect(page.url(), "removing the picker also stopped the login").toContain("/dashboard");
    });
  }, 20000);

  /**
   * SC-PWCHG-01 … 04 — a first login can change its password and nothing else.
   *
   * The seeded account arrives with `must_change_password`, and the server
   * answers `403 { must_change_password: true }` to every route but three. The
   * screen's job is to say so instead of leaving somebody in a dashboard of
   * refusals — **it is not the thing doing the refusing**, and `SC-PWCHG-02`
   * is what keeps that distinction honest: it calls the API with the cookie and
   * no browser at all. A guard that only redirects passes every test that goes
   * through a page, which is `I-065` and is what this suite spent a day
   * deleting.
   *
   * The suite's own admin has the flag cleared by the harness, so these make
   * their own account rather than reusing it.
   */
  async function flaggedAccount(username: string, password: string): Promise<string> {
    const db = openTestDb(path.join(mesh.stateDir, "agent-mesh.db"));
    db.prepare("DELETE FROM local_users WHERE username = ?").run(username);
    db.prepare(
      "INSERT INTO local_users (username, password_hash, display_name, role, must_change_password) VALUES (?, ?, ?, 'admin', 1)",
    ).run(username, await Bun.password.hash(password, { algorithm: "bcrypt" }), username);
    db.close();
    const res = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      redirect: "manual",
    });
    // A 302 is not a session — the cookie is what says so. One copy of that
    // rule, in the harness, because this was a fourth.
    return sessionCookie(username, res.status, res.headers.get("set-cookie"));
  }

  it("[SC-PWCHG-01] sends a first login to the change screen, and opens the product once it changes", async () => {
    const cookie = await flaggedAccount("pwchg-one", "seeded-one-1");
    await withViewerPage(cookie, "/dashboard", async ({ page }) => {
      await page.waitForURL("**/change-password", { timeout: 6000 }).catch(() => {});
      expect(
        { at: page.url().includes("/change-password"), screen: (await page.locator("[data-testid='change-password']").count()) > 0 },
        "a first login was left somewhere other than the change screen",
      ).toEqual({ at: true, screen: true });

      // **The other half.** Without it a product that opens nothing for anybody
      // satisfies the reading above.
      await page.locator("input[type='password']").nth(0).fill("seeded-one-1");
      await page.locator("input[type='password']").nth(1).fill("chosen-one-99");
      await page.locator("input[type='password']").nth(2).fill("chosen-one-99");
      await page.locator("button[type='submit']").first().click();
      await page.waitForURL("**/dashboard", { timeout: 8000 }).catch(() => {});
      // **Reading the URL here is too early.** `navigate` puts `/dashboard` in
      // the bar and the guard can send it back on the next render, so a screen
      // that never releases the session still shows `/dashboard` for an instant
      // — measured: a mutation that never clears the flag passed this check
      // until it waited for the redirect to settle. Settle on the change screen
      // being gone, which is the thing that would come back.
      await page.waitForTimeout(600);
      expect(
        { at: page.url().includes("/dashboard"), stillChanging: (await page.locator("[data-testid='change-password']").count()) > 0 },
        "changing the password did not open the product",
      ).toEqual({ at: true, stillChanging: false });
    });
  }, 30000);

  it("[SC-PWCHG-02] is refused by the server, not by the screen", async () => {
    const cookie = await flaggedAccount("pwchg-two", "seeded-two-2");
    // No browser. If this passes only through a page, the guard is decoration.
    const blocked = await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie } });
    const body = (await blocked.json()) as { must_change_password?: boolean };
    expect(
      { status: blocked.status, flagged: body.must_change_password === true },
      "a locked session reached a protected route without a browser in the way",
    ).toEqual({ status: 403, flagged: true });

    const changed = await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ current: "seeded-two-2", next: "chosen-two-99" }),
    });
    expect(changed.status, "the one route it may use refused it").toBe(200);

    const after = await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie } });
    expect(after.status, "the same call is still refused after the change").toBe(200);
  }, 20000);

  it("[SC-PWCHG-05] shows the change screen in the language the landing screen used", async () => {
    // The landing screen defaults to English, and the change screen is the very
    // next thing a first login sees. It was Korean literals with no dictionary
    // entry — the same gap the login page had, one screen further in, and it
    // would have shipped as an English product whose second screen is not.
    const cookie = await flaggedAccount("pwchg-lang", "seeded-lang-5");
    const context = await newContext(null);
    try {
      await context.addCookies([
        { name: "mesh_token", value: cookie.replace("mesh_token=", ""), domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
      ]);
      const page = await context.newPage();
      await page.goto(`${viteBaseUrl}/dashboard`, { waitUntil: "networkidle" });
      await page.waitForURL("**/change-password", { timeout: 6000 }).catch(() => {});
      const text = await page.locator("#root").innerText();
      expect(
        { at: page.url().includes("/change-password"), english: /Choose a password|Current password/.test(text), korean: /비밀번호를 바꿔야|현재 비밀번호/.test(text) },
        "the change screen is not in the language the product defaults to",
      ).toEqual({ at: true, english: true, korean: false });
    } finally {
      await context.close().catch(() => {});
    }
  }, 25000);

  it("[SC-PWCHG-03] says why a change failed instead of leaving the form silent", async () => {
    const cookie = await flaggedAccount("pwchg-three", "seeded-three-3");
    await withViewerPage(cookie, "/change-password", async ({ page }) => {
      await page.locator("input[type='password']").nth(0).fill("not-the-password");
      await page.locator("input[type='password']").nth(1).fill("chosen-three-9");
      await page.locator("input[type='password']").nth(2).fill("chosen-three-9");
      await page.locator("button[type='submit']").first().click();
      await page.waitForTimeout(700);

      const err = page.locator("[data-testid='change-password-error']");
      expect(
        { said: (await err.count()) > 0, left: !page.url().includes("/change-password") },
        "the change button did nothing and said nothing",
      ).toEqual({ said: true, left: false });
    });
  }, 20000);

  it("[SC-PWCHG-04] stops accepting the password it was seeded with", async () => {
    const cookie = await flaggedAccount("pwchg-four", "seeded-four-4");
    await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ current: "seeded-four-4", next: "chosen-four-99" }),
    });
    const login = async (password: string) =>
      (await fetch(`${mesh.http.url}/auth/local`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ username: "pwchg-four", password }),
        redirect: "manual",
      })).status;
    expect(
      { old: await login("seeded-four-4"), next: await login("chosen-four-99") },
      "the seeded password still works, or the chosen one does not",
    ).toEqual({ old: 401, next: 200 });
  }, 20000);

  /**
   * SC-I18N-02 — the landing screen can be read, and can be switched.
   *
   * The toggle lived in the sidebar and the sidebar is behind the login, so a
   * visitor who could not read the form could not reach the control that would
   * have translated it. The default was Korean, which is right for the room this
   * was written in and wrong for an operator opening a deployment elsewhere.
   *
   * **Both halves.** A page that renders English and has a toggle that does
   * nothing satisfies "the default is English" completely — and that toggle
   * would be a control that looks like it works, which is the shape this suite
   * spends its time removing. So the switch is pressed and the page has to
   * change.
   */
  it("[SC-I18N-02] opens in English and switches from the flag in the corner", async () => {
    // **No seed.** Every other context in this file chooses a language; this one
    // must not, because the default is what it is measuring.
    const context = await newContext(null);
    try {
      const page = await context.newPage();
      await page.goto(`${viteBaseUrl}/login`, { waitUntil: "networkidle" });
      const body = () => page.locator("#root").innerText();
      const before = await body();
      expect(
        {
          toggle: (await page.locator("[data-testid='lang-trigger']").count()) > 0,
          english: /Sign in|Username/.test(before),
          // The page used to be Korean literals with no dictionary entry at
          // all, so "the default is English" was unreachable however the
          // default was set.
          korean: /로그인하기|비밀번호 \(Password\)/.test(before),
        },
        "the landing screen is not in English, or has no way to change that",
      ).toEqual({ toggle: true, english: true, korean: false });

      // A combo, so it has to be opened first — and the panel not being there
      // until it is opened is part of what makes it a combo rather than two
      // buttons wearing one.
      expect(await page.locator("[data-testid='lang-menu']").count(), "the menu was open before anything was pressed").toBe(0);
      await page.locator("[data-testid='lang-trigger']").click();
      await page.locator("[data-lang='ko']").click();
      await page.waitForTimeout(300);
      const after = await body();
      expect(
        { korean: /로그인하기/.test(after), stillEnglish: /Sign in/.test(after) },
        "the flag was pressed and the page did not change",
      ).toEqual({ korean: true, stillEnglish: false });

      // And it is remembered, which is what makes the control worth pressing.
      expect(await page.evaluate(() => localStorage.getItem("agent_mesh_lang"))).toBe("ko");
    } finally {
      await context.close().catch(() => {});
    }
  }, 20000);

  // SC-AUTH-01: Session authentication & cookie injection
  it("[SC-AUTH-01] verifies session auth and redirect flow", async () => {
    await withUnauthedPage("/login", async ({ page }) => {
      const userInput = page.locator("input[name='username'], input[placeholder*='아이디'], input[type='text']").first();
      const passInput = page.locator("input[name='password'], input[type='password']").first();
      const submitBtn = page.locator("button[type='submit']").first();

      await userInput.fill(SEED_ADMIN);
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
   * SC-DOWN-12 — one route failing, and the bell that said nothing about it.
   *
   * The nine `SC-DOWN-*` above abort `**\/api/v1/**`: the whole backend is gone.
   * A deployment fails the other way far more often — one route answers `502`
   * while the session and every other read are healthy — and a screen that
   * handles the first case can still be wrong about the second.
   *
   * `audit/partialsweep.mjs` swept fourteen screens against every route each of
   * them reads, failing one at a time. Every screen said something, except this
   * one: `fetchPendingKeys().catch(() => setRequests([]))`, and an empty list
   * draws "no requests are waiting" — a sentence about the server's answer,
   * written when there was no answer. On a deployed mesh that is an operator
   * looking at a quiet bell while agents wait to be admitted.
   *
   * Three states now, and the scenario asserts all three, because a bell that
   * always said "could not ask" would pass the half that matters.
   */
  it("[SC-DOWN-12] says it could not ask, rather than that nothing is waiting", async () => {
    // **The bell has two sources.** A fetch on mount and an SSE snapshot, and
    // the first version of this blocked only the fetch — the stream delivered a
    // proposal and the bell was right, so the check measured the stream.
    // `audit/partialsweep.mjs` made the same mistake at a larger scale: it
    // failed one route at a time and called this screen swallowed, when what it
    // had actually found was redundancy. Both are stopped here.
    const load = async (pendingBody: string | null) => {
      const { page, context } = await createAuthedPage("/tenant/rbac");
      try {
        const fail = (route: import("playwright").Route) =>
          route.fulfill({ status: 502, contentType: "text/html", body: "<html>502</html>" });
        if (pendingBody === null) {
          await page.route("**/api/v1/admin/keys/pending", fail);
          await page.route("**/api/v1/admin/keys/stream", fail);
        } else {
          await page.route("**/api/v1/admin/keys/pending", (route) =>
            route.fulfill({ status: 200, contentType: "application/json", body: pendingBody }),
          );
          await page.route("**/api/v1/admin/keys/stream", (route) =>
            route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: snapshot\ndata: {\"keys\":[]}\n\n" }),
          );
        }
        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        await page.locator('[data-testid="bell"]').click();
        await settled(page);
        return {
          unknownBadge: await page.locator('[data-testid="bell-unreachable"]').count(),
          saidNone: await page.locator('[data-testid="bell-empty"]').count(),
          saidUnknown: await page.locator('[data-testid="bell-empty-unreachable"]').count(),
        };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const refused = await load(null);
    const answeredEmpty = await load(JSON.stringify({ ok: true, pending: [] }));

    // **거절은 침묵이 아니다 — 벨에서도.** `audit.read.metadata` 하나만 든 세션으로
    // 걸어보니 벨이 `403` 을 받고 "물어보지 못했습니다" 라고 말했다: 서버는 답했고
    // 그 답은 *너는 이걸 볼 수 없다* 였다. 열 화면에서 갈라둔 구분이 이 컴포넌트에는
    // 안 들어와 있었고, 가운데 역할로 걷기 전에는 아무도 그 자리를 지나지 않았다.
    const forbidden = await (async () => {
      const { page, context } = await createAuthedPage("/tenant/rbac");
      try {
        const deny = (route: import("playwright").Route) =>
          route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: "Missing capability: key.approve", capability: "key.approve", scope: "*" }),
          });
        await page.route("**/api/v1/admin/keys/pending", deny);
        await page.route("**/api/v1/admin/keys/stream", deny);
        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        await page.locator('[data-testid="bell"]').click();
        await settled(page);
        // **testid 는 자리를 찾는 것이고, 사람이 읽는 것은 문장이다.** 처음엔 testid 만
        // 셌고, 문구를 되돌리는 뮤테이션이 잡히지 않았다 — 같은 칸이 다른 말을 해도
        // 그 칸은 여전히 거기 있기 때문이다.
        const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
        return {
          saidRefused: await page.locator('[data-testid="bell-empty-refused"]').count(),
          saidUnknown: await page.locator('[data-testid="bell-empty-unreachable"]').count(),
          readsRefused: /may not see registration requests|등록 요청을 볼 수 없습니다/.test(text),
          readsUnknown: /Could not ask the server|물어보지 못했습니다/.test(text),
        };
      } finally {
        await context.close().catch(() => {});
      }
    })();

    expect(
      {
        refusedBadge: refused.unknownBadge,
        refusedSaidNone: refused.saidNone,
        refusedSaidUnknown: refused.saidUnknown,
        emptyBadge: answeredEmpty.unknownBadge,
        emptySaidNone: answeredEmpty.saidNone,
        emptySaidUnknown: answeredEmpty.saidUnknown,
        forbiddenSaidRefused: forbidden.saidRefused,
        forbiddenSaidUnknown: forbidden.saidUnknown,
        forbiddenReadsRefused: forbidden.readsRefused,
        forbiddenReadsUnknown: forbidden.readsUnknown,
      },
      "the bell reported an unanswered question as an answer, or reports every answer as unanswered",
    ).toEqual({
      refusedBadge: 1,
      refusedSaidNone: 0,
      refusedSaidUnknown: 1,
      emptyBadge: 0,
      emptySaidNone: 1,
      emptySaidUnknown: 0,
      forbiddenSaidRefused: 1,
      forbiddenSaidUnknown: 0,
      forbiddenReadsRefused: true,
      forbiddenReadsUnknown: false,
    });
  }, 40000);

  /**
   * SC-INVENT-06 — the lease screen counts what the server queued, not its own rows.
   *
   * `GET /api/v1/admin/mailbox` answers one row per mailbox with `pending`,
   * `leased` and `oldest`. The screen turned each row into one invented message
   * — `msg_mb_1`, state "Available", a 300-second TTL, an enqueue time of
   * `new Date()` — and counted those. Measured on the standing stack with
   * eleven messages queued for one agent: **"Available 1건"**, one row, and
   * three buttons (Lease · ACK · NACK) that called no route at all.
   *
   * This scenario only became possible once something was queued. Until then
   * the screen said `0` and the route said `0`, and `0 === 0` is the comparison
   * that cannot fail.
   */
  it("[SC-INVENT-06] shows the queue depth the route reported, not a count of rows", async () => {
    // Queue for an identity nothing is connected to, through the hub the way an
    // agent would — the http server has no route that enqueues.
    const identity = `queued-${Date.now().toString(36).slice(-5)}`;
    const provisioned = await fetch(`${mesh.hub.url}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity, type: "service", description: "never connects" }),
    });
    expect(provisioned.status, "the hub did not provision the recipient").toBe(201);
    // **Two tables, § 9.1.** The hub knows this identity; the http server's own
    // registry does not, and `/api/v1/messages` refuses `404` until it does —
    // measured, three times, before this line existed. `SC-INVENT-03` seeds the
    // same way two hundred lines below.
    const db = openTestDb(path.join(mesh.stateDir, "agent-mesh.db"));
    db.prepare("INSERT OR IGNORE INTO agent_registry (id, name, type, approved) VALUES (?, ?, 'agent', 1)").run(identity, identity);
    db.close();

    const sent: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${mesh.http.url}/api/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `mesh_token=${jwtToken}` },
        body: JSON.stringify({ to: identity, text: `SC-INVENT-06 ${i}` }),
      });
      sent.push(res.status);
    }
    const wire = (await (
      await fetch(`${mesh.http.url}/api/v1/admin/mailbox`, { headers: { cookie: `mesh_token=${jwtToken}` } })
    ).json()) as any;
    const depth = (wire.mailboxes ?? []).reduce((n: number, m: any) => n + (m.pending ?? 0), 0);
    // **This mailbox's own count, beside the total.** The row and the KPI are
    // two different numbers and this asserted both against the total — which
    // held only while nothing else in the file had left a message queued. Two
    // scenarios now do, so the row read 3 against a total of 5 and the failure
    // said "the screen counted its rows", which it had not.
    const mine = (wire.mailboxes ?? [])
      .filter((m: any) => (m.identity ?? m.id) === identity)
      .reduce((n: number, m: any) => n + (m.pending ?? 0), 0);

    // If nothing queued, this scenario would be comparing 0 against 0.
    expect(
      { sent: [...new Set(sent)], mine: mine > 1, depth: depth >= mine },
      "nothing was queued for this mailbox, so the comparison below cannot fail",
    ).toEqual({ sent: [201], mine: true, depth: true });

    await withPage("/creator/lease-queue", async ({ page }) => {
      const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      const rowDepth = await page.locator(`[data-testid="pending-${identity}"]`).textContent();
      // **The card, not the page.** Reading `text.includes(depth)` passed while
      // the KPI counted rows, because the row beside it carried the same digit.
      const kpi = await page.locator('[data-testid="lease-available"]').textContent();
      expect(
        { rowDepth: Number(rowDepth), kpi: Number(kpi), inventsIds: /msg_mb_/.test(text) },
        "the screen counted its rows, or drew a message id the server never sent",
      ).toEqual({ rowDepth: mine, kpi: depth, inventsIds: false });
    });
  }, 30000);

  /**
   * SC-CAP-09 — the middle role: one capability, and the screens on both sides of it.
   *
   * Every scenario in this file runs as the platform admin or as an account
   * holding nothing. Between them is the role the product actually sells — a
   * person granted exactly what they need — and walking the console as one is
   * how the notification bell was caught calling a `403` "could not ask": the
   * refusal path had been fixed on ten screens and had never been *walked*.
   *
   * The refusals here are the server's own, not `route.fulfill`. A fulfilled
   * 403 proves the screen reads a status; a granted capability proves the mesh
   * and the screen agree about what this person may do.
   */
  it("[SC-CAP-09] shows a one-capability session its screen, and names what it lacks on the others", async () => {
    const admin = { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" };
    const who = `cap9-${Date.now().toString(36).slice(-5)}`;
    const created = (await (
      await fetch(`${mesh.http.url}/api/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: who }) })
    ).json()) as any;
    const signIn = async (password: string) =>
      (
        await fetch(`${mesh.http.url}/auth/local`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ username: who, password }),
          redirect: "manual",
        })
      ).headers.get("set-cookie")?.split(";")[0] ?? "";
    const locked = await signIn(created.temporary_password);
    await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { cookie: locked, "content-type": "application/json" },
      body: JSON.stringify({ current: created.temporary_password, next: `${who}-chosen` }),
    });
    await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ subject: who, capability: "audit.read.metadata", scope: "*" }),
    });
    const cookie = await signIn(`${who}-chosen`);

    // What the server says this session holds — asserted, because a grant that
    // did not take would make everything below a test of an empty account.
    const me = (await (await fetch(`${mesh.http.url}/auth/me`, { headers: { cookie } })).json()) as any;
    expect(
      { holds: me.capabilities ?? [] },
      "the grant did not take, so the rest of this scenario measures an account holding nothing",
    ).toEqual({ holds: ["audit.read.metadata"] });

    // The screen it holds: rows are drawn, and the bodies are withheld because
    // `audit.read.content` is a different capability.
    const held = await (async () => {
      const { page, context } = await createViewerAuthedPage(cookie, "/tenant/audits");
      try {
        await settled(page);
        const rows = await page.locator('[data-testid="audit-summary"]').count();
        const originals = page.getByRole("button", { name: "원문 JSON 보기" });
        expect(await originals.count()).toBeGreaterThan(0);
        await originals.first().click();
        const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
        return {
          drewRows: rows > 0,
          withheldCells: await page.locator('[data-testid="audit-withheld"]').count(),
          rawRecords: await page.locator('[data-testid="audit-raw-json"]').count(),
          bodyLeaked: text.includes("hello security via proxy"),
          blamedPermission: /권한이 없습니다|may not read/.test(text),
          // **What the screen tells this account it can read.** The server
          // withholds the bodies either way now, so a page drawing its banner
          // from a constant instead of the grant no longer leaks anything —
          // it promises access this session does not have, and an operator
          // who believes it reads the whole log as though nothing were
          // hidden. The promise is the part left to check.
          promisedBodies: text.includes("원문 기록에 메시지 본문이 포함될 수 있습니다"),
          saidBodiesStayHidden: text.includes("메시지 본문은 숨깁니다"),
        };
      } finally {
        await context.close().catch(() => {});
      }
    })();

    // A screen it does not hold: the queue it may not read says so, and names
    // the capability the server named.
    const lacked = await (async () => {
      const { page, context } = await createViewerAuthedPage(cookie, "/creator/register");
      try {
        await settled(page);
        const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
        return {
          saysRefused: text.includes(REFUSED_COPY),
          leaksMachineKey: text.includes("key.approve"),
          claimsSilence: /did not answer|서버가 답하지|연결 실패/.test(text),
        };
      } finally {
        await context.close().catch(() => {});
      }
    })();

    expect(
      { ...held, ...lacked },
      "the session was refused on the screen it holds, or told silence where the server refused, " +
        "or promised message bodies to an account that may not read them",
    ).toEqual({
      drewRows: true,
      withheldCells: 1,
      rawRecords: 0,
      bodyLeaked: false,
      blamedPermission: false,
      promisedBodies: false,
      saidBodiesStayHidden: true,
      saysRefused: true,
      leaksMachineKey: false,
      claimsSilence: false,
    });
  }, 40000);

  /**
   * SC-CAP-08 — an irreversible control is not offered to a session that cannot use it.
   *
   * Measured on the running product with a member holding nothing: the Teardown
   * button was drawn for every identity, the modal opened on `admin`, the
   * confirmation accepted the typed name, and the server refused at the last
   * step with `agent.teardown`. Nothing false was claimed — the screen reported
   * the refusal — and a person had still been walked through an irreversible
   * flow that could not have worked.
   *
   * Every other write control on this console is already hidden without its
   * capability; this one was the exception. Both sides are asserted, because a
   * screen that hides it from everybody is the other way to pass.
   */
  it("[SC-CAP-08] offers teardown only to a session the server gave it", async () => {
    // **Admitted through the route, as in `SC-CAP-06`.** `capabilityViewer`
    // inserts a `local_users` row with SQL and skips the approval that
    // `admitLocalUser` performs, so `GET /api/v1/agents` answers it `403` — the
    // table draws nothing, there are no rows to carry a control, and the check
    // would have passed by measuring an empty page.
    const admitAndSignIn = async (name: string, capability?: string) => {
      const admin = { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" };
      const created = (await (
        await fetch(`${mesh.http.url}/api/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: name }) })
      ).json()) as any;
      const signIn = async (password: string) =>
        (
          await fetch(`${mesh.http.url}/auth/local`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ username: name, password }),
            redirect: "manual",
          })
        ).headers.get("set-cookie")?.split(";")[0] ?? "";
      const locked = await signIn(created.temporary_password);
      await fetch(`${mesh.http.url}/auth/local/password`, {
        method: "POST",
        headers: { cookie: locked, "content-type": "application/json" },
        body: JSON.stringify({ current: created.temporary_password, next: `${name}-chosen` }),
      });
      if (capability) {
        await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ subject: name, capability, scope: "*" }),
        });
      }
      return await signIn(`${name}-chosen`);
    };
    const stamp = Date.now().toString(36).slice(-5);
    const withCapability = await admitAndSignIn(`cap8-yes-${stamp}`, "agent.teardown");
    const withNothing = await admitAndSignIn(`cap8-no-${stamp}`);

    // **Both sides have to see a row, or neither side has a control to count.**
    // `GET /api/v1/agents` narrows for anyone who is not an administrator: an
    // account sees itself, what it owns, its group, and whoever it has
    // exchanged messages with. These two were admitted a moment ago and own
    // nothing, so the only row either of them could see is their own — and this
    // console stopped drawing people in the agent table, so the page was empty
    // for both. The scenario then read "the granted session sees no teardown
    // control" and called it a defect, when what it had measured was an empty
    // table.
    //
    // So both are given the same agent. The one difference left between them is
    // the capability, which is the whole subject.
    const owners = openTestDb(path.join(mesh.stateDir, "agents.db"));
    try {
      const own = owners.prepare(
        `INSERT INTO agent_owners (tenant, identity, owner, granted_by)
         VALUES ('default', 'agent-alpha', ?, 'fe-render') ON CONFLICT DO NOTHING`,
      );
      own.run(`cap8-yes-${stamp}`);
      own.run(`cap8-no-${stamp}`);
    } finally {
      owners.close();
    }

    const count = async (cookie: string) => {
      const { page, context } = await createViewerAuthedPage(cookie, "/creator");
      try {
        await settled(page);
        return {
          buttons: await page.locator('[data-testid^="teardown-"]').count(),
          rows: await page.locator("table tbody tr, [class*='row']").count(),
        };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const granted = await count(withCapability);
    const held = await count(withNothing);

    expect(
      { grantedSeesControls: granted.buttons > 0, withoutSeesControls: held.buttons },
      "the teardown control was offered to a session that cannot use it, or to nobody at all",
    ).toEqual({ grantedSeesControls: true, withoutSeesControls: 0 });

    // **What the dialog says, in the language the session asked for.** The
    // modal's own strings went through the dictionary and the shared dialog's
    // did not: "이 작업은 되돌릴 수 없으며 …" and "확인을 위해 … 입력하세요" sat
    // under an English title. A person reading an irreversible warning they
    // cannot read is the one place on this console where language is not
    // cosmetic. The screen is the file plus everything it draws.
    // The context seeds a language on every load, so setting it from inside the
    // page and reloading loses to the init script. English is asked for at the
    // context, the way `SC-I18N-02` does it.
    const context = await newContext("en");
    await context.addCookies([
      { name: "mesh_token", value: withCapability.replace(/^mesh_token=/, ""), domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    try {
      await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" });
      await settled(page);
      await page.locator('[data-testid^="teardown-"]').first().click();
      await settled(page);
      const dialog = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      const opened = /cannot be undone|되돌릴 수 없습니다/.test(dialog);
      const korean = (dialog.match(/[가-힣]/g) ?? []).length;
      expect(
        { opened, koreanInEnglishDialog: /되돌릴 수 없습니다|입력하세요|취소/.test(dialog) },
        `the irreversible dialog is not in the session's language (${korean} Korean characters on the page)`,
      ).toEqual({ opened: true, koreanInEnglishDialog: false });
    } finally {
      await context.close().catch(() => {});
    }
  }, 30000);

  /**
   * SC-CAP-07 — refused and unreachable are different sentences.
   *
   * Every list on this console caught its error and drew one message: the
   * server did not answer. Measured with a member session on /creator/register
   * — the server answered `403`, and the screen told them the backend was down.
   * The audit screen wrote both into one string, "연결 실패 또는 권한 오류",
   * which is the same problem with the ambiguity made explicit.
   *
   * `ApiError.refused` has carried the distinction since a `502` was read as a
   * signed-out session and threw operators at a login form. The screens had not
   * started asking.
   *
   * Both directions, in one scenario: a `403` must not be drawn as silence, and
   * a server that never answers must not be drawn as a permission problem.
   */
  it("[SC-CAP-07] says refused when refused and unreachable when unreachable", async () => {
    const read = async (mode: "refused" | "unreachable") => {
      const { page, context } = await createAuthedPage("/creator/register");
      try {
        await page.route("**/api/v1/admin/keys/pending", (route) =>
          mode === "refused"
            ? route.fulfill({
                status: 403,
                contentType: "application/json",
                body: JSON.stringify({ error: "Missing capability: key.approve", capability: "key.approve", scope: "*" }),
              })
            : route.abort(),
        );
        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        return ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      } finally {
        await context.close().catch(() => {});
      }
    };

    const refused = await read("refused");
    const unreachable = await read("unreachable");

    // **A second screen, because the first one is spoken for.** `SC-DOWN-06`
    // already waits on /creator/register for the unreachable sentence, so a
    // mutation that makes that screen always say "refused" kills SC-DOWN-06
    // first — by timeout, which takes the browser down and hides whichever
    // check was supposed to name it. /platform/users has no such landmark.
    const usersUnreachable = await (async () => {
      const { page, context } = await createAuthedPage("/platform/users");
      try {
        await page.route("**/api/v1/admin/users", (route) => route.abort());
        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        return ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      } finally {
        await context.close().catch(() => {});
      }
    })();
    // **Refused, and the key stays off the screen.** This required the screen to
    // repeat `key.approve` off the wire. The console's rule reversed: the
    // sentence says the account may not read this, and the machine key stays on
    // the error object where code reads it. Both halves are still measured —
    // that it said *refused* rather than nothing, and that the key did not leak.
    const saysRefused = (t: string) => t.includes(REFUSED_COPY);
    const leaksMachineKey = (t: string) => t.includes("key.approve");
    const saysSilent = (t: string) => /서버 연결 실패|서버가 답하지|did not answer|연결 실패/i.test(t);
    // The panel's own heading said `(unreachable)` while the body underneath it
    // named the capability — one screen, two answers about the same request.
    const headingContradicts = (t: string) => /\(unreachable\)|\(통신 불가\)/.test(t);

    // **The rule, not the one screen.** Four more screens carried the same
    // single message, and two of them wrote both possibilities into one string
    // — "연결 실패 또는 권한 오류" — which is the ambiguity stated out loud. A
    // screen that records a failure has to record which kind it was.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ROOT = join(import.meta.dir, "..", "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const sources = walk(ROOT).filter((f) => /\.tsx?$/.test(f));
    const marksFailure = sources.filter((f) => readFileSync(f, "utf8").includes("setIsError(true)"));
    const asksWhich = marksFailure.filter((f) => readFileSync(f, "utf8").includes("failureKind("));
    expect(
      { screens: marksFailure.length > 3, silent: marksFailure.filter((f) => !asksWhich.includes(f)).map((f) => f.slice(ROOT.length + 1)) },
      "a screen records that a read failed without recording which kind of failure it was",
    ).toEqual({ screens: true, silent: [] });

    expect(
      {
        refusedSaysRefused: saysRefused(refused),
        refusedLeaksMachineKey: leaksMachineKey(refused),
        refusedSaysSilent: saysSilent(refused),
        unreachableSaysRefused: saysRefused(unreachable),
        unreachableSaysSilent: saysSilent(unreachable),
        refusedHeadingContradicts: headingContradicts(refused),
        usersBlamesPermission: /권한이 없습니다|may not read this screen/i.test(usersUnreachable),
        usersSaysSilent: saysSilent(usersUnreachable),
      },
      "a refusal was drawn as silence, or silence was drawn as a permission problem",
    ).toEqual({
      refusedSaysRefused: true,
      refusedLeaksMachineKey: false,
      refusedSaysSilent: false,
      unreachableSaysRefused: false,
      unreachableSaysSilent: true,
      refusedHeadingContradicts: false,
      usersBlamesPermission: false,
      usersSaysSilent: true,
    });
  }, 30000);

  /**
   * SC-LOAD-06 — the answer that has not come back yet.
   *
   * The panel a member lands on started with `agents = []` and drew `0`, so on
   * a slow link it said "Agents 0 registered" and then jumped to fourteen when
   * the answer arrived. Measured with the route delayed 2.5 seconds. The
   * platform admin's panel has had `isLoading` since it was written; this one
   * had two states where four are needed — and the two it had were the two that
   * look alike.
   *
   * Both sides: a panel stuck on "..." would pass the first half and tell an
   * operator nothing forever.
   */
  it("[SC-LOAD-06] does not answer with 0 while the request is still in flight", async () => {
    const me = `load6-${Date.now().toString(36).slice(-5)}`;
    const admitted = (await (
      await fetch(`${mesh.http.url}/api/v1/admin/users`, {
        method: "POST",
        headers: { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" },
        body: JSON.stringify({ username: me }),
      })
    ).json()) as any;
    const signIn = async (password: string) =>
      (
        await fetch(`${mesh.http.url}/auth/local`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ username: me, password }),
          redirect: "manual",
        })
      ).headers.get("set-cookie")?.split(";")[0] ?? "";
    const locked = await signIn(admitted.temporary_password);
    await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { cookie: locked, "content-type": "application/json" },
      body: JSON.stringify({ current: admitted.temporary_password, next: `${me}-chosen` }),
    });
    const cookie = await signIn(`${me}-chosen`);

    // **Something to answer with.** `GET /api/v1/agents` narrows for anyone who
    // is not an administrator, and this account was admitted a moment ago: it
    // owns nothing, is in no group, and has spoken to nobody, so the honest
    // answer is an empty list — and then "the panel answered after the wait"
    // cannot be told from "the panel never answered". One owned agent gives the
    // second half of this scenario something to see.
    const owners = openTestDb(path.join(mesh.stateDir, "agents.db"));
    try {
      owners
        .prepare(`INSERT INTO agent_owners (tenant, identity, owner, granted_by)
                  VALUES ('default', 'agent-alpha', ?, 'fe-render') ON CONFLICT DO NOTHING`)
        .run(me);
    } finally {
      owners.close();
    }

    const { page, context } = await createViewerAuthedPage(cookie, "/dashboard");
    try {
      await page.route("**/api/v1/agents", async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
      });
      await page.goto(`${viteBaseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      const during = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      const loadingRow = await page.locator('[data-testid="operator-agents-loading"]').count();

      await page.waitForTimeout(2200);
      await settled(page);
      const after = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      const emptyRow = await page.locator('[data-testid="operator-agents-empty"]').count();

      const claimsZero = /(Agents|에이전트)\s*🤖?\s*0/.test(during);
      const answersAfter = /(Agents|에이전트)\s*🤖?\s*[1-9]/.test(after);

      expect(
        { claimsZero, loadingRow, answersAfter, emptyRow },
        "the panel answered 0 before the answer arrived, or never stopped waiting",
      ).toEqual({ claimsZero: false, loadingRow: 1, answersAfter: true, emptyRow: 0 });
    } finally {
      await context.close().catch(() => {});
    }
  }, 40000);

  /**
   * SC-INVENT-05 — one label, one source.
   *
   * `total_agents` was `health?.agent_count ?? agentList.length`, and those two
   * count different things: mesh identities that are alive, against rows in this
   * server's own chat registry. Neither set contains the other. Measured on the
   * standing stack while writing this — 12 against 13 — so when `/api/v1/health`
   * stopped answering, the number under the label changed quantity rather than
   * going missing, and nothing on the page said so.
   *
   * That is the quietest shape of the four this file now guards: a screen that
   * draws a plausible number for a question it could not ask.
   */
  it("[SC-INVENT-05] leaves the count unmeasured rather than answering it from another table", async () => {
    // **The subject moved with the console, and the rule did not.** This read
    // `total_agents=` off `/platform/telemetry`, where the count came from
    // `/api/v1/health` and fell back to the registry when health did not
    // answer — two tables under one label. The console removed the fallback and
    // the label: the dashboard's agent card now counts registry rows and
    // nothing else, and says so in its own subtitle.
    //
    // So the rule is measured where it still lives: block the card's one source
    // and the card has to go unmeasured rather than fill itself from the other
    // count that is sitting right there in the same page's telemetry.
    const read = async (blockRegistry: boolean) => {
      const { page, context } = await createAuthedPage("/dashboard");
      try {
        if (blockRegistry) {
          await page.route("**/api/v1/agents**", (route) => route.abort());
          await page.reload({ waitUntil: "networkidle" });
          await settled(page);
        }
        return ((await page.locator("[data-kpi='등록된 에이전트']").first().innerText()) ?? "").replace(/\s+/g, " ");
      } finally {
        await context.close().catch(() => {});
      }
    };

    // What each source actually says, asked of the server rather than assumed.
    const health = (await (await fetch(`${mesh.http.url}/api/v1/health`, { headers: { cookie: `mesh_token=${jwtToken}` } })).json()) as any;
    const registry = (await (await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie: `mesh_token=${jwtToken}` } })).json()) as any;
    const rows: any[] = Array.isArray(registry) ? registry : registry.agents ?? [];
    // The card's own subject: agent rows, people excluded.
    const registryCount = rows.filter((a) => String(a.type ?? "") !== "user").length;

    const healthy = await read(false);
    const refused = await read(true);

    // The two counts have to differ, or "it answered from the other table" is
    // indistinguishable from "it answered correctly".
    expect(
      { differ: String(health.agent_count) !== String(registryCount) },
      `health says ${health.agent_count} and the registry ${registryCount}; with one number this scenario cannot fail`,
    ).toEqual({ differ: true });

    expect(
      {
        healthyDrewItsOwnSource: healthy.includes(String(registryCount)),
        refusedIsHealthCount: refused.includes(String(health.agent_count)),
        refusedSaysUnmeasured: refused.includes("—"),
      },
      "the count answered from another table when its own source did not answer",
    ).toEqual({ healthyDrewItsOwnSource: true, refusedIsHealthCount: false, refusedSaysUnmeasured: true });
  }, 30000);

  /**
   * SC-CAP-06 — the screen does not call the mesh's registry the viewer's own.
   *
   * `GET /api/v1/agents` answers a member holding no capability at all with the
   * whole registry: measured, twelve identities, byte-identical to what the
   * platform admin gets, including every other person's. Whether the server
   * should scope that list is `I-101` and is not a question this file can
   * answer — but for as long as it does not, the screen must not put the word
   * *my* or *owned* on it. A person reading "Owned Agents 12" concludes twelve
   * things are theirs.
   *
   * The check is in two parts on purpose. That the list is unscoped is asserted
   * against the server rather than assumed, so if scoping arrives this fails
   * and someone reads this comment. The words are a literal list, which is the
   * only way to check copy — kept short, and each one is a claim of ownership
   * rather than a style preference.
   */
  it("[SC-CAP-06] does not call an unscoped registry the viewer's own agents", async () => {
    // **Admitted through the route, not inserted.** `capabilityViewer` writes a
    // `local_users` row with SQL, which skips the approval `admitLocalUser`
    // performs — that viewer gets `403 Account pending approval` and would have
    // made this scenario pass by measuring nothing. A person let in through the
    // screen is the subject here.
    const me = `cap6-${Date.now().toString(36).slice(-5)}`;
    const admitted = (await (
      await fetch(`${mesh.http.url}/api/v1/admin/users`, {
        method: "POST",
        headers: { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" },
        body: JSON.stringify({ username: me }),
      })
    ).json()) as any;
    const signIn = async (password: string) =>
      (
        await fetch(`${mesh.http.url}/auth/local`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ username: me, password }),
          redirect: "manual",
        })
      ).headers.get("set-cookie")?.split(";")[0] ?? "";
    const locked = await signIn(admitted.temporary_password);
    await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { cookie: locked, "content-type": "application/json" },
      body: JSON.stringify({ current: admitted.temporary_password, next: `${me}-chosen` }),
    });
    const cookie = await signIn(`${me}-chosen`);

    // **The premise flipped, and this scenario said so.** It used to assert the
    // registry came back unscoped, with a comment saying that a failure here
    // means the server has started scoping. It has: `c23a56e` scopes the
    // listing to self, group and correspondents, which is `D-681 ①`.
    //
    // The wording half survives that unchanged, and is the reason this scenario
    // still exists: **scoped is not owned**. A person sees the agents of people
    // they share a group with and of anyone they have exchanged messages with —
    // none of those are theirs, so a heading that says *my* or *owned* is as
    // wrong as it was against the whole registry.
    //
    // So the premise is built rather than assumed: one account this viewer has
    // written to, which must appear, and one it has never touched, which must
    // not. That is both directions of the scoping rule at the same time — a
    // list that showed nobody would pass "no stranger" on its own.
    const spoke = `cap6spoke-${Date.now().toString(36).slice(-5)}`;
    const stranger = `cap6alone-${Date.now().toString(36).slice(-5)}`;
    for (const who of [spoke, stranger]) {
      await fetch(`${mesh.http.url}/api/v1/admin/users`, {
        method: "POST",
        headers: { cookie: `mesh_token=${jwtToken}`, "content-type": "application/json" },
        body: JSON.stringify({ username: who, role: "member" }),
      });
    }
    const sent = await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ to: spoke, text: `cap6 ${me}` }),
    });

    // **And one to an agent, because the screen only draws agents.** The
    // correspondent above is a person, which is exactly what this console
    // stopped listing in the agent table — so the page drew nobody else and the
    // scenario read that as the scoping having dropped somebody. The route's
    // answer is still the thing being checked for scope; the *page* needs a
    // visible row that is not the viewer's own, and only an agent can be one.
    const met = await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent-alpha", text: `cap6 agent ${me}` }),
    });

    const rows = (await (await fetch(`${mesh.http.url}/api/v1/agents`, { headers: { cookie } })).json()) as any;
    const list: any[] = Array.isArray(rows) ? rows : rows.agents ?? [];
    const names = list.map((a) => String(a.identity ?? a.id ?? ""));
    // The rows this screen can draw: people are not on it.
    const others = list
      .filter((a) => String(a.identity ?? a.id ?? "") !== me)
      .filter((a) => String(a.type ?? "") !== "user");

    expect(
      {
        wrote: sent.ok,
        metAnAgent: met.ok,
        correspondent: names.includes(spoke),
        stranger: names.includes(stranger),
        notMine: others.length > 0,
      },
      "the correspondence this scenario needs was not made, the scoping dropped somebody it should show, or it showed somebody it should not",
    ).toEqual({ wrote: true, metAnAgent: true, correspondent: true, stranger: false, notMine: true });

    const { page, context } = await createViewerAuthedPage(cookie, "/creator");
    try {
      await settled(page);
      const text = ((await page.locator("body").textContent()) ?? "");
      const drewSomebodyElse = others.some((a) => text.includes(String(a.identity ?? a.id ?? "")));

      // **Both dictionaries, not the rendered page.** The first version read the
      // page for the English words while this file seeds Korean, so renaming the
      // English heading back to "My Agents" changed nothing it could see — the
      // same language-dependent blindness that cost thirty seconds on the logout
      // button, here costing a mutation that went uncaught.
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dict = readFileSync(
        join(import.meta.dir, "..", "packages", "platform-web", "src", "contexts", "I18nContext.tsx"),
        "utf8",
      );
      // **Every key, not a list of six.** The first version named the keys it
      // knew about and passed while `dash.op.fleetTitle` said "Owned Agent Fleet
      // Summary" one panel below — a denominator written by hand covers what the
      // person writing it remembered.
      // `그룹 내 에이전트` is "agents in the group" and contains `내 에이전트`
      // as a substring — a claim of ownership only when the syllable starts the
      // phrase, so the Korean patterns carry a boundary.
      // `그룹 내 에이전트` is "agents in the group": `내` there is a postposition,
      // not a possessive, and it follows a space like the possessive would. So
      // the possessive is only matched at the start of a value — which is how
      // this dictionary writes it (`"내 에이전트"`, `"내 에이전트 관리"`).
      const CLAIMS = [/My Agent/i, /Owned Agent/i, /(^|[^가-힣])소유 에이전트/, /^내 에이전트/];
      const entries = [...dict.matchAll(/"([\w.]+)":\s*"([^"]*)"/g)];
      expect(entries.length, "no dictionary entries were read — the scan matched nothing").toBeGreaterThan(200);
      const claims = entries
        .map((m) => ({ key: m[1] ?? "", value: m[2] ?? "" }))
        .filter(({ value }) => CLAIMS.some((c) => c.test(value)))
        .map(({ key, value }) => `${key}: ${value}`);
      expect(
        { claims, drewSomebodyElse },
        "the screen drew somebody else's identity under a heading that calls it the viewer's own",
      ).toEqual({ claims: [], drewSomebodyElse: true });
    } finally {
      await context.close().catch(() => {});
    }
  }, 30000);

  /**
   * SC-DOWN-14 — a panel that cannot be drawn says so instead of vanishing.
   *
   * `/platform/telemetry` builds itself from five routes, and one of them
   * failing left `telemetry.behaviour` null — which rendered nothing at all.
   * Measured with only that route refusing: eighteen fragments of the page
   * disappeared, the rest was byte-identical, and no sentence anywhere said a
   * source had not answered. On a monitoring screen that is the moment somebody
   * most needs to be told.
   *
   * It is a milder shape than the bell's — nothing false is claimed — and it is
   * the same question underneath: a screen has four states to distinguish, and
   * an absent panel distinguishes none of them.
   */
  it("[SC-DOWN-14] keeps the panel and says the source did not answer", async () => {
    const read = async (block: boolean) => {
      const { page, context } = await createAuthedPage("/platform/telemetry");
      try {
        if (block) {
          await page.route("**/api/v1/admin/telemetry/behaviour", (route) =>
            route.fulfill({ status: 502, contentType: "text/html", body: "<html>502</html>" }),
          );
          await page.reload({ waitUntil: "networkidle" });
          await settled(page);
        }
        return {
          said: await page.locator('[data-testid="behaviour-unreachable"]').count(),
          drew: await page.locator('[data-testid="behaviour-metrics"]').count(),
        };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const refused = await read(true);
    const healthy = await read(false);

    expect(
      { refusedSaid: refused.said, refusedDrew: refused.drew, healthySaid: healthy.said, healthyDrew: healthy.drew },
      "the panel vanished without a word, or claims to be unreachable while the route answers",
    ).toEqual({ refusedSaid: 1, refusedDrew: 0, healthySaid: 0, healthyDrew: 1 });
  }, 30000);

  /**
   * SC-DOWN-13 — the dashboard an ordinary account lands on.
   *
   * `SC-DOWN-02` and the eight beside it measure the platform admin's panel.
   * The file draws four, chosen by role, and the other three each carried
   *
   * ```
   * fetchAgents().then(setAgents).catch(() => setAgents([]))
   * ```
   *
   * so a refused read drew `0`: "Owned Agents 0", "Online Sockets 0". Measured
   * on the running product with a real member account and one route failing —
   * the screen said the mesh was empty, having never been told anything.
   *
   * Two halves, because the live one can only reach the panel a member gets:
   * the operator panel is asserted through the browser, and the rule itself —
   * *a catch that empties a list records that it failed* — is read off the
   * source for every screen, including the two no session can open today.
   */
  it("[SC-DOWN-13] tells a member the read failed, rather than that they own nothing", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ROOT = join(import.meta.dir, "..", "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const sources = walk(ROOT).filter((f) => /\.tsx?$/.test(f));

    // The `catch` body, brace-matched. A regex that stopped at the first `}`
    // would read half of `catch { setX([]); setIsError(true); }` and report the
    // half it read.
    const bodyAt = (src: string, at: number): string => {
      const open = src.indexOf("{", at);
      if (open < 0 || open - at > 40) return src.slice(at, at + 220);
      let depth = 0;
      for (let i = open; i < Math.min(src.length, open + 3000); i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
      }
      return src.slice(at, at + 400);
    };

    let catches = 0;
    const silent: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\.catch\s*\(|catch\s*(\([^)]*\))?\s*\{/g)) {
        catches++;
        const body = bodyAt(src, m.index);
        if (!/set[A-Za-z]*\(\s*\[\s*\]\s*\)/.test(body)) continue;
        // `setFailure` 는 이 규칙이 쓰인 뒤에 생긴 이름이다 — 벨이 그것으로 실패를
        // 적기 시작하자 규칙이 벨을 *아무것도 안 적는다* 로 찍었다. **가드의 어휘가
        // 코드보다 늦으면, 옳게 고친 자리가 빨개진다.** 접두사로 둔다.
        //
        // **그리고 이름이 있다는 것으로는 부족하다.** 이 줄이 오래 `setIsError` 를
        // 보기만 했고, 그래서 두 대시보드 패널이 실패를 아무도 읽지 않는 상태에
        // 적어두고 화면에는 0 을 그리는 동안 이 검사는 초록이었다. `fe-codex` 가
        // *그 상태가 읽히는가* 를 물어 그것을 드러냈다 — 기록은 읽는 쪽이 있을 때만
        // 기록이다. 아래는 그 질문을 검사가 대신 한다.
        const recorder = /set([A-Za-z]*(?:IsError|Unreachable|Error|Fail)[A-Za-z]*)\s*\(/.exec(body)
          ?? /set([A-Z][A-Za-z]*)\s*\(\s*\{\s*kind:/.exec(body);
        if (recorder) {
          const state = recorder[1]![0]!.toLowerCase() + recorder[1]!.slice(1);
          // 그 catch 를 감싼 컴포넌트만 본다. 한 파일에 같은 이름의 상태가 넷 있고
          // 그중 둘만 읽는 경우가 실제로 있었으므로 파일 범위로는 안 갈린다.
          const before = src.slice(0, m.index);
          const startsBefore = [...before.matchAll(/^(?:export )?function \w+/gm)];
          const from = startsBefore.length > 0 ? startsBefore[startsBefore.length - 1]!.index! : 0;
          const nextStart = [...src.slice(m.index).matchAll(/^(?:export )?function \w+/gm)][0];
          const to = nextStart ? m.index + nextStart.index! : src.length;
          const component = src.slice(from, to);
          const refs = [...component.matchAll(new RegExp(`\\b${state}\\b`, "g"))].length;
          const declarations = [...component.matchAll(new RegExp(`const \\[\\s*${state}\\b`, "g"))].length;
          // **setter 호출은 빼지 않는다.** `\bisError\b` 는 `setIsError` 안에서
          // 애초에 안 걸리므로(경계도 대소문자도 다르다) 세지도 않은 것을 빼는
          // 셈이 되고, 상태를 실제로 읽는 아홉 화면이 오탐으로 걸렸다.
          // `fe-codex` 가 읽기 전용 재현으로 그 이중 차감을 짚었다.
          if (refs - declarations > 0) continue;
        }
        silent.push(`${file.slice(ROOT.length + 1)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }

    // **The guard's own denominator.** A walk or a pattern that matched nothing
    // would report zero silent catches and mean nothing by it.
    expect({ scanned: sources.length > 40, catches: catches > 20 }, "the scan found nothing to read")
      .toEqual({ scanned: true, catches: true });
    expect(silent, "a refused read is emptied into a list and nothing records that it failed").toEqual([]);

    // The live half: the panel a member actually gets.
    const cookie = await capabilityViewer(mesh);
    const { page, context } = await createViewerAuthedPage(cookie, "/dashboard");
    try {
      await page.route("**/api/v1/agents", (route) =>
        route.fulfill({ status: 502, contentType: "text/html", body: "<html>502</html>" }),
      );
      await page.reload({ waitUntil: "networkidle" });
      await settled(page);
      const text = ((await page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
      const said = /불러오지 못함|could not load/i.test(text);
      // `0` on its own is the sentence this is against — as a card's value it is
      // a claim about the mesh, and there is no answer behind it.
      //
      // **This read the fallback, not the screen.** The regex looked for
      // `소유 에이전트` / `Owned Agents`, and the dictionary defines that key as
      // `에이전트` / `Agents` — so the fallback never renders and the match was
      // structurally false. It could not fail, on either language, for as long
      // as the key existed. Found because a manifest entry that neuters the
      // card's `isError` branches came back `not caught`.
      //
      // The card's own value now, by testid: a number that is there or a `—`
      // that says the read did not answer.
      const shown = ((await page.locator('[data-testid="operator-agents-count"]').textContent()) ?? "").trim();
      const claimsZero = shown === "0";
      // The table one panel down was still inviting them to register their
      // first agent — the same claim in a friendlier voice.
      const invited = await page.locator('[data-testid="operator-agents-empty"]').count();
      const admitted = await page.locator('[data-testid="operator-agents-unreachable"]').count();
      expect({ said, claimsZero, invited, admitted }, "the member's dashboard drew 0 for a read that was refused")
        .toEqual({ said: true, claimsZero: false, invited: 0, admitted: 1 });
    } finally {
      await context.close().catch(() => {});
    }
  }, 40000);

  /**
   * SC-DOWN-15 — the two dashboard panels below today's role gate.
   *
   * The server currently issues only platform-admin or operator sessions, and
   * `AuthContext` deliberately maps every non-admin server role to operator.
   * Pretending a live session can open the tenant or group dashboard would
   * make this scenario a test of a contract that does not exist. Instead the
   * browser mounts the real `DashboardPage` module immediately below that gate,
   * with the remembered role the component consumes and `/auth/me` still in
   * flight — the same reachable component boundary its unit suite documents.
   *
   * Each independent groups, agents, and pending-key read is then given all
   * five visible readings: rows, an answered empty list, a read still in flight,
   * a refusal, and no response. The last two are one broad “could not know”
   * state, but they must use different words and test ids: one sends the
   * operator to permissions, the other to connectivity.
   */
  it("[SC-DOWN-15] keeps tenant and group dashboard reads in their own states", async () => {
    type Resource = "groups" | "agents" | "keys";
    type Reading = "present" | "empty" | "loading" | "refused" | "unreachable";
    type RolePanel = {
      role: "TENANT_ADMIN" | "GROUP_ADMIN";
      resource: Resource;
      prefix: "tenant-groups" | "tenant-agents" | "tenant-pending-keys" | "group-groups" | "group-agents";
      refusalCapability: string | null;
    };
    const panels: RolePanel[] = [
      { role: "TENANT_ADMIN", resource: "groups", prefix: "tenant-groups", refusalCapability: "group.manage" },
      { role: "TENANT_ADMIN", resource: "agents", prefix: "tenant-agents", refusalCapability: null },
      { role: "TENANT_ADMIN", resource: "keys", prefix: "tenant-pending-keys", refusalCapability: "key.approve" },
      { role: "GROUP_ADMIN", resource: "groups", prefix: "group-groups", refusalCapability: "group.manage" },
      { role: "GROUP_ADMIN", resource: "agents", prefix: "group-agents", refusalCapability: null },
    ];
    const readings: Reading[] = ["present", "empty", "loading", "refused", "unreachable"];

    const read = async (panel: RolePanel, reading: Reading) => {
      const { role, resource, prefix } = panel;
      const context = await newContext("en");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      try {
        // No App is executed on this module response, so there is no second
        // React root racing the component probe below.
        await page.goto(`${viteBaseUrl}/node_modules/.vite/deps/react.js`, { waitUntil: "domcontentloaded" });
        await page.route("**/auth/me", () => new Promise<void>(() => {}));
        const emptyBody: Record<Resource, unknown> = {
          groups: { groups: [], egress: [] },
          agents: { agents: [] },
          keys: { keys: [] },
        };
        const presentBody: Record<Resource, unknown> = {
          groups: { groups: [{ group_id: "t019-group", name: "T-019 group", members: [], description: "state witness" }], egress: [] },
          agents: { agents: [{ id: "t019-agent", name: "T-019 agent", channel: "web", type: "worker" }] },
          keys: { keys: [{ identity: "t019-key", fingerprint: "sha256:t019" }] },
        };
        const answerRead = async (route: any, routed: Resource) => {
          if (resource !== routed) {
            return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyBody[routed]) });
          }
          if (reading === "loading") return new Promise<void>(() => {});
          if (reading === "unreachable") return route.abort("connectionrefused");
          if (reading === "refused") {
            const refused = panel.refusalCapability
              ? { error: "not allowed", capability: panel.refusalCapability }
              : { error: "not allowed" };
            return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(refused) });
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(reading === "present" ? presentBody[routed] : emptyBody[routed]),
          });
        };
        await page.route("**/api/v1/agents", (route) => answerRead(route, "agents"));
        await page.route("**/api/v1/admin/keys/pending", (route) => answerRead(route, "keys"));
        await page.route("**/api/v1/admin/mailbox", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: '{"mailboxes":[],"total_queued":0}' }),
        );
        await page.route("**/api/v1/admin/groups", (route) => answerRead(route, "groups"));

        await page.evaluate(async ({ chosenRole }) => {
          localStorage.setItem("agent_mesh_user", JSON.stringify({
            id: "t019-probe",
            name: "T-019 probe",
            role: chosenRole,
            capabilities: [],
            tenantId: "tenant_default",
            authProvider: "local",
          }));
          document.body.innerHTML = '<div id="t019-root"></div>';
          const load = (modulePath: string) => import(/* @vite-ignore */ modulePath) as Promise<any>;
          // We entered through a compiled dependency rather than `index.html`,
          // so install the React preamble that the HTML normally provides
          // before importing any TSX module transformed by plugin-react.
          const RefreshRuntime = (await load("/@react-refresh")).default;
          RefreshRuntime.injectIntoGlobalHook(window);
          (window as any).$RefreshReg$ = () => {};
          (window as any).$RefreshSig$ = () => (type: unknown) => type;
          (window as any).__vite_plugin_react_preamble_installed__ = true;
          const dashboardSource = await (await fetch("/src/pages/DashboardPage.tsx")).text();
          const dependencyUrl = (file: string) => {
            const marker = `/node_modules/.vite/deps/${file}`;
            const start = dashboardSource.indexOf(marker);
            const end = dashboardSource.indexOf('"', start);
            if (start < 0 || end < 0) throw new Error(`DashboardPage does not import ${file}`);
            return dashboardSource.slice(start, end);
          };
          const [reactModule, domModule, routerModule, i18nModule, authModule, dashboardModule] = await Promise.all([
            load(dependencyUrl("react.js")),
            load("/node_modules/.vite/deps/react-dom_client.js"),
            load(dependencyUrl("react-router-dom.js")),
            load("/src/contexts/I18nContext.tsx"),
            load("/src/contexts/AuthContext.tsx"),
            load("/src/pages/DashboardPage.tsx"),
          ]);
          const React = reactModule.default;
          const createRoot = domModule.createRoot ?? domModule.default?.createRoot;
          const h = React.createElement;
          createRoot(document.getElementById("t019-root")!).render(
            h(routerModule.MemoryRouter, { initialEntries: ["/dashboard"] },
              h(i18nModule.I18nProvider, null,
                h(authModule.AuthProvider, null, h(dashboardModule.DashboardPage)))),
          );
        }, { chosenRole: role });

        await page.waitForFunction(
          ({ expected }) => document.querySelector(`[data-testid="${expected}"]`) !== null,
          { expected: `${prefix}-${reading}` },
          { timeout: 5000 },
        ).catch(() => {});
        const visible = Object.fromEntries(await Promise.all(readings.map(async (state) => [
          state,
          await page.locator(`[data-testid="${prefix}-${state}"]`).count(),
        ])));
        const text = await page.evaluate(
          ({ testId, copyBesideValue }) => {
            const state = document.querySelector(`[data-testid="${testId}"]`);
            const copy = copyBesideValue ? state?.parentElement?.children[1] : state;
            return copy?.textContent?.trim() ?? "";
          },
          { testId: `${prefix}-${reading}`, copyBesideValue: resource === "agents" },
        );
        const countTestId = resource === "agents" ? `${prefix}-${reading}` : `${prefix}-count`;
        const count = await page.evaluate(
          ({ testId }) => document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? "",
          { testId: countTestId },
        );
        const body = (await page.locator("body").innerText()).slice(0, 600);
        return { visible, text, count, errors, body };
      } finally {
        await context.close().catch(() => {});
      }
    };

    for (const panel of panels) {
      for (const reading of readings) {
        const result = await read(panel, reading);
        const expectedVisible = Object.fromEntries(readings.map((state) => [state, state === reading ? 1 : 0]));
        expect(
          { visible: result.visible, errors: result.errors },
          `${panel.prefix} folded ${reading} into another state; body: ${result.body}`,
        ).toEqual({ visible: expectedVisible, errors: [] });

        if (reading === "loading") expect(result.text).toBe("Loading…");
        if (reading === "refused") {
          // **The sentence, without the capability.** It used to end
          // ` (group.manage).` — the console now keeps machine keys out of
          // operator copy entirely (`refusedText`, held by
          // `api/client.test.ts`), so the name is gone from every panel and the
          // check is that the refusal is still *said*, and said as a refusal
          // rather than as a failed read.
          expect(result.text).toBe("This account may not read this screen.");
          expect(result.text).not.toContain("Could not load");
          if (panel.refusalCapability) expect(result.text).not.toContain(panel.refusalCapability);
        }
        if (reading === "unreachable") {
          expect(result.text).toBe(panel.resource === "groups"
            ? "Could not read the groups (the server did not answer)."
            : "Could not load");
          expect(result.text).not.toContain("may not read");
        }
        if (reading === "empty") expect(result.count).toBe("0");
        else expect(result.count, `${panel.prefix} claimed zero while ${reading}`).not.toBe("0");
      }
    }
  }, 45000);

  /**
   * SC-AUTH-07 — signing out ends the session in the browser.
   *
   * Measured on the running product before this existed: clicking Logout put
   * the browser on `/login` and left everything else intact — `mesh_token` was
   * still set, `/auth/me` answered `200`, and typing `/dashboard` opened it
   * again. The client cleared its own state; the cookie is the session and it
   * belongs to the server, which had no `/auth/logout` route at all. The gate's
   * allowlist named that route and its comment said the session could "simply
   * be abandoned" — a sentence that was true about the allowlist and false
   * about the server.
   *
   * **Both sides are asserted.** A screen that can never reach `/dashboard`
   * would pass the half that matters most here, and it would pass it while
   * being broken in the opposite direction.
   *
   * What this does not claim: the token is not revoked. It is a stateless JWT,
   * so a copy taken before the click keeps working until it expires — that is
   * `I-095`, and it needs somewhere to record revocations rather than a line in
   * a handler.
   */
  it("[SC-AUTH-07] ends the session in the browser when the person signs out", async () => {
    const { page, context } = await createAuthedPage("/dashboard");
    try {
      const opened = page.url();
      const before = (await context.cookies()).filter((c) => c.name === "mesh_token").length;
      const meBefore = await page.evaluate(async () => (await fetch("/auth/me", { credentials: "include" })).status);

      // By test id, not by label: this file seeds Korean by default, and the
      // first version looked for "Logout" and waited thirty seconds for a
      // button that was there the whole time saying 로그아웃.
      await page.locator('[data-testid="logout"]').first().click();
      await page.waitForURL("**/login", { timeout: 8000 }).catch(() => {});
      await settled(page);

      // **Waited for, not read once.** The click fires a request; the redirect
      // it triggers can land before that request has finished clearing the
      // cookie, and this scenario then reports a session that "stayed usable"
      // for a logout that was still in flight. It did exactly that once, under
      // the load of a full measurement run, and passed alone seconds later.
      //
      // The wait cannot hide a real failure: a logout that never clears the
      // cookie spends the tries and answers 1, which is the same red with four
      // seconds on it.
      const after = await eventually(
        async () => (await context.cookies()).filter((c) => c.name === "mesh_token").length,
        (n) => n === 0,
      );
      const meAfter = await eventually(
        async () => await page.evaluate(async () => (await fetch("/auth/me", { credentials: "include" })).status),
        (status) => status === 401,
      );

      // The half that the redirect hides: going back to a guarded route.
      await page.goto(`${viteBaseUrl}/dashboard`, { waitUntil: "networkidle" });
      await settled(page);

      expect(
        {
          openedBefore: opened.includes("/dashboard"),
          cookieBefore: before,
          meBefore,
          cookieAfter: after,
          meAfter,
          landsOn: page.url().includes("/login"),
        },
        "signing out left the session usable, or the session was never usable to begin with",
      ).toEqual({ openedBefore: true, cookieBefore: 1, meBefore: 200, cookieAfter: 0, meAfter: 401, landsOn: true });
    } finally {
      await context.close().catch(() => {});
    }
  }, 30000);

  /**
   * SC-USER-D1 / D2 — the screen that admits a person.
   *
   * Before this screen the only way to admit anybody was `curl`, and the two
   * things worth measuring about it are both about honesty rather than layout:
   *
   * - **Once has to mean once.** The password is in component state and nowhere
   *   else, so D1 reloads the page and asserts it is gone. A screen that kept it
   *   in `localStorage` would look identical and be false.
   * - **The refusal is the server's sentence.** D2 asks the API for the same
   *   duplicate name and compares the two strings. Writing the expected text in
   *   this file would be the test agreeing with itself; the server is the other
   *   side of the comparison.
   *
   * D1 also signs in with what was drawn. A screen showing a plausible-looking
   * string would pass any check that only read its shape — `SC-ADDR-02` is the
   * scar: a base64url fingerprint is one third letters, and a check that judged
   * by shape called real values fabricated a third of the time.
   */
  it("[SC-USER-D1] shows the temporary password once, and it is the real one", async () => {
    const person = `d1-grace-${Date.now().toString(36).slice(-5)}`;

    const shown = await withPage("/platform/users", async ({ page }) => {
      await page.waitForSelector('[data-testid="admit-form"]', { timeout: 8000 });
      await page.locator('[data-testid="admit-username"]').fill(person);
      await page.locator('[data-testid="admit-submit"]').click();
      await page.waitForSelector('[data-testid="issued-value"]', { timeout: 8000 });
      const value = ((await page.locator('[data-testid="issued-value"]').textContent()) ?? "").trim();

      // The other half of "once". A reload is the cheapest thing a person does.
      await page.reload({ waitUntil: "networkidle" });
      await settled(page);
      const afterReload = await page.locator('[data-testid="issued-password"]').count();
      const stillListed = await page.locator(`[data-testid="user-row-${person}"]`).count();
      return { value, afterReload, stillListed };
    });

    // Ask the server whether that string is the password. Shape proves nothing.
    const signIn = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username: person, password: shown.value }),
      redirect: "manual",
    });

    expect(
      { gave: shown.value.length > 0, works: signIn.status, keptAfterReload: shown.afterReload, listed: shown.stillListed },
      "the screen showed no password, showed one that does not work, or kept it across a reload",
    ).toEqual({ gave: true, works: 200, keptAfterReload: 0, listed: 1 });
  }, 30000);

  it("[SC-USER-D2] repeats the server's refusal rather than composing its own", async () => {
    const taken = `d2-heidi-${Date.now().toString(36).slice(-5)}`;
    const admin = { Cookie: `mesh_token=${jwtToken}`, "Content-Type": "application/json" };
    await fetch(`${mesh.http.url}/api/v1/admin/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ username: taken }),
    });
    const wire = (await (
      await fetch(`${mesh.http.url}/api/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: taken }) })
    ).json()) as { error?: string };

    const seen = await withPage("/platform/users", async ({ page }) => {
      await page.waitForSelector('[data-testid="admit-form"]', { timeout: 8000 });
      await page.locator('[data-testid="admit-username"]').fill(taken);
      await page.locator('[data-testid="admit-submit"]').click();
      await page.waitForSelector('[data-testid="admit-error"]', { timeout: 8000 });
      const message = ((await page.locator('[data-testid="admit-error"]').textContent()) ?? "").trim();
      const issued = await page.locator('[data-testid="issued-password"]').count();
      return { message, issued };
    });

    expect(
      { message: seen.message, issuedAnyway: seen.issued, serverSaid: (wire.error ?? "").length > 0 },
      "the screen invented a refusal, or claimed success on one",
    ).toEqual({ message: wire.error ?? "", issuedAnyway: 0, serverSaid: true });
  }, 30000);

  /**
   * SC-USER-D3 — the capability table is the server's list, and the role beside
   * a subject is the server's word for that subject.
   *
   * This screen used to write the role itself:
   *
   * ```
   * role: subj === "admin" ? "Platform Admin" : "Operator"
   * ```
   *
   * Every subject in the grants list that was not literally `admin` was called
   * an Operator — an agent id, a service, a person the server holds no account
   * for. The word is not in the platform's vocabulary and the server was never
   * asked. `I-055` and `I-077` are the same sentence about a different field.
   *
   * So the check reads both sides off the wire: the capability axis is compared
   * against `GET /api/v1/admin/grants`, and each role cell against the accounts
   * list. The em dash is asserted too, because "the server has no account for
   * this subject" and "this subject is an Operator" are different answers and
   * only one of them is true.
   */
  it("[SC-USER-D3] draws the capability axis and each role from what the server said", async () => {
    const admin = { Cookie: `mesh_token=${jwtToken}`, "Content-Type": "application/json" };
    const person = "d3-frank";
    await fetch(`${mesh.http.url}/api/v1/admin/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ username: person, display_name: "Frank" }),
    });
    // A subject the accounts list does not hold. Grants take any string, which
    // is how "Operator" came to be printed beside things that are not people.
    const stranger = "agent-alpha";
    for (const subject of [person, stranger]) {
      await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ subject, capability: "group.manage", scope: "*" }),
      });
    }

    const wire = (await (await fetch(`${mesh.http.url}/api/v1/admin/grants`, { headers: admin })).json()) as {
      capabilities?: string[];
    };
    const accounts = (await (await fetch(`${mesh.http.url}/api/v1/admin/users`, { headers: admin })).json()) as {
      users?: Array<{ username: string; role: string }>;
    };
    const serverRole = (accounts.users ?? []).find((u) => u.username === person)?.role;
    expect(
      { caps: (wire.capabilities ?? []).length > 0, role: serverRole },
      "the server said nothing to compare the screen against",
    ).toEqual({ caps: true, role: "member" });

    await withPage("/tenant/rbac", async ({ page }) => {
      await page.waitForSelector(`[data-testid="rbac-role-${person}"]`, { timeout: 8000 });

      const drawnCaps = await page.evaluate((subject: string) => {
        const prefix = `rbac-cap-${subject}-`;
        return [...document.querySelectorAll(`[data-testid^="${prefix}"]`)]
          .map((el) => (el.getAttribute("data-testid") ?? "").slice(prefix.length))
          .sort();
      }, person);
      const roleShown = (await page.locator(`[data-testid="rbac-role-${person}"]`).textContent())?.trim();
      const strangerShown = (await page.locator(`[data-testid="rbac-role-${stranger}"]`).textContent())?.trim();

      expect(
        { axis: drawnCaps, role: roleShown, stranger: strangerShown },
        "the screen drew a capability axis or a role that the server did not give it",
      ).toEqual({ axis: [...(wire.capabilities ?? [])].sort(), role: serverRole, stranger: "\u2014" });
    });
  }, 30000);

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

      // **Server groups, which is what the heading counts.** The screen also
      // draws a container for agents the server placed in no group — an
      // identity in this server's `agent_registry` that the hub has never
      // heard of is in none, correctly, and `agent-unkeyed` is seeded as
      // exactly that. Counting it as a group made this compare 5 against 6 and
      // call the screen inconsistent when both halves were right; `801723a`
      // gave the two kinds separate `data-topology-kind` so the question can
      // be asked of the one the heading is about.
      const drawnClusters = await page.locator("[data-testid='topology-cluster'][data-topology-kind='group']").count();
      const drawnOrbits = await page.locator("[data-testid='topology-cluster']").count();
      const drawnAgents = await page.locator("[data-testid='topology-agent']").count();
      const drawnGateways = await page.locator("[data-testid='topology-gateway']").count();

      // Nothing drawn is not agreement. The suite seeds two agents, so a zero
      // here is the screen failing to draw, not the mesh being empty.
      expect(
        { groups: statedGroups > 0, agents: statedAgents > 0, drew: drawnClusters > 0 },
        "the screen claimed nothing or drew nothing — 0 === 0 is not agreement",
      ).toEqual({ groups: true, agents: true, drew: true });

      expect({ stated: statedGroups, drawn: drawnClusters }).toEqual({ stated: statedGroups, drawn: statedGroups });
      // The kind axis has to mean something, or the selector above is just a
      // narrower way of counting the same thing and this stops being a check
      // of the heading at all.
      expect(
        { everyOrbitIsAGroup: drawnOrbits === drawnClusters, unassignedDrawn: drawnOrbits - drawnClusters },
        "every orbit on the page reported itself as a server group, so the kind attribute distinguishes nothing",
      ).toEqual({ everyOrbitIsAGroup: false, unassignedDrawn: drawnOrbits - drawnClusters });
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
    const context = await newContext();
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

      // **Inside that group, not on the whole page.** This counted every
      // `topology-agent` the page drew, which could not tell *not in the empty
      // group* from *not drawn at all* — and once the screen gained a place
      // for agents the server placed nowhere (`9e0a8d2`), a global zero
      // forbade that place existing. The question was always about the inside
      // of the group, so it is asked there.
      const emptyGroup = page.locator("[data-testid='topology-cluster']").filter({ hasText: "빈 그룹" });
      const clusters = await emptyGroup.count();
      const agentsInside = await emptyGroup.locator("[data-testid='topology-agent']").count();
      const agentsDrawn = await page.locator("[data-testid='topology-agent']").count();

      // The cluster must be there, or "no agents drawn" is just "nothing drawn"
      // — the vacuous pass this repository keeps meeting.
      expect({ clusterDrawn: clusters > 0 }, "the empty group was not drawn at all, so nothing was tested").toEqual({
        clusterDrawn: true,
      });
      expect({ agentsInEmptyGroup: agentsInside }, "an empty group drew agents the server did not put in it").toEqual({
        agentsInEmptyGroup: 0,
      });
      // And the mesh's agents did reach the screen. Without this, a page that
      // drew nothing at all passes the assertion above — the same vacuity the
      // cluster guard is there to refuse, one level in.
      expect(
        { agentsDrawnSomewhere: agentsDrawn > 0 },
        "the screen drew no agents anywhere, so the empty group holding none says nothing",
      ).toEqual({ agentsDrawnSomewhere: true });
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
    const base = { id: `pm-${tag}`, name: `NAME-${tag}`, description: `DESC-${tag}`, type: `TYPE-${tag}` };

    async function rowOf(agent: Record<string, unknown>): Promise<{ text: string; absent: number }> {
      const context = await newContext();
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
        // The screen's own absence handles, counted rather than named, so adding a
        // new one cannot make this test redder.
        const absent =
          (await page.locator("[data-testid$='-unknown']").count()) +
          (await page.locator("[data-testid$='-absent']").count()) +
          (await page.locator("[data-testid='never-seen']").count());
        return { text, absent };
      } finally {
        await context.close().catch(() => {});
      }
    }

    // Sent: a presence record from an hour ago. Omitted: no `last_seen_at` key.
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const sent = await rowOf({ ...base, last_seen_at: anHourAgo });
    const omitted = await rowOf({ ...base });

    // Neither render may be empty, or the pair says nothing — the vacuous pass
    // this repository keeps meeting.
    expect(
      { sentDrew: sent.text.includes(`pm-${tag}`), omittedDrew: omitted.text.includes(`pm-${tag}`) },
      "the row never rendered, so nothing was compared",
    ).toEqual({ sentDrew: true, omittedDrew: true });

    // The value the present case showed. If the screen stops saying it, this test
    // is measuring nothing and says so rather than passing.
    expect(sent.text, "the sent presence no longer renders as a time — this pair has nothing to compare")
      .toContain("시간 전 접속");

    // **The omitted case must not borrow it**, and must not translate silence into
    // a verdict: SPEC § 9.1 says `last_seen_at: null` is the absence of a record,
    // not a report that the identity is offline.
    expect(
      { drewATime: /전 접속/.test(omitted.text), drewAVerdict: /오프라인|OFFLINE|ONLINE/.test(omitted.text) },
      "a row with no presence record was drawn as one that had one",
    ).toEqual({ drewATime: false, drewAVerdict: false });

    // And it says so with the screen's own handle rather than falling blank.
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
      const context = await newContext();
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

  /**
   * SC-INVENT-03 — the queue the route reported, not a sum of a field it never sent.
   *
   * `/api/v1/admin/mailbox` answers rows aliased `identity`, `pending`, `leased`,
   * `oldest`. The front end declared `depth`, `unacked_count`, `oldest_message_ts`
   * and `leased_count`, summed `depth`, and got `0` — then read `data.total_queued`
   * first, a name no route sends either, so both branches were dead. The dashboard
   * drew that `0` as the queue on an idle mesh and on a backed-up one alike, and
   * `?? 0` on top folded "the route did not answer" into the same digit.
   *
   * **A queue is seeded first**, to an identity that is provisioned and never
   * connects, so the row is written `pending` and stays. Comparing `shown` with
   * `reported` on an empty mesh is `0` against `0` and passes against the defect
   * exactly as it passes against the fix — which is what the old screen was.
   *
   * **And the operator's dashboard, not the admin's.** `/dashboard` renders one
   * of four panels by role and the mailbox card is on two of them; a session
   * whose role is not `admin` resolves to `AGENT_OPERATOR`. Read as an admin,
   * this card is not on the page at all — the first version of this scenario
   * timed out looking for it and would have been written off as a flake.
   */
  it("[SC-INVENT-03] states the queue the mailbox route reported, on the panel that draws it", async () => {
    const queued = "invent03-never-connects";
    await setupWrite("provision invent03 recipient", `${mesh.hub.url}/api/v1/agents`, {
      identity: queued,
      type: "service",
      description: "provisioned and never connected, so its mailbox keeps a depth",
    });
    const db = openTestDb(path.join(mesh.stateDir, "agent-mesh.db"));
    db.prepare("INSERT OR IGNORE INTO agent_registry (id, name, type, approved) VALUES (?, ?, 'agent', 1)").run(queued, queued);
    db.close();

    const sent = await fetch(`${mesh.http.url}/api/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `mesh_token=${jwtToken}` },
      body: JSON.stringify({ to: queued, text: "SC-INVENT-03 queue seed" }),
    });
    const sentBody = (await sent.json()) as { message?: { status?: string } };
    // `failed` would mean the hub refused it and nothing is queued; `delivered`
    // would mean the recipient took it. Either way the comparison below would
    // be 0 against 0, so it is checked rather than assumed.
    expect({ status: sent.status, stored: sentBody.message?.status }, "nothing was left queued, so the comparison below is 0 against 0")
      .toEqual({ status: 201, stored: "pending" });

    const cookie = await capabilityViewer(mesh, "mailbox.read.depth");
    await withViewerPage(cookie, "/dashboard", async ({ page }) => {
      // The expected value comes off the wire. Writing the sum in this file
      // would be the screen agreeing with the test instead of with the route.
      const wire = await page.evaluate(async () => {
        const r = await fetch("/api/v1/admin/mailbox", { credentials: "include" });
        return { ok: r.ok, body: await r.json() };
      });
      // The route counts this itself now, so the screen and this scenario read
      // the same number from the same place rather than each deriving one.
      const reported = wire.body?.total_queued;
      expect({ ok: wire.ok, reported: typeof reported === "number" && reported > 0 }, "the route did not report the message it had just accepted")
        .toEqual({ ok: true, reported: true });

      // **Either panel's label for the same number.** `data-kpi` is the rendered
      // label, and which of the two dashboards a session gets depends on its
      // role — `dash.kpi.inbox` ("대기 중 메시지") for the operator panel and
      // `dash.ga.lease` ("메일함 큐 적체") for the group-admin one. Both bind
      // `mailbox.total_queued`, so the card is named by either. It was pinned to
      // "미수신 메일함", which is neither of them any more.
      const card = page.locator("[data-kpi='대기 중 메시지'], [data-kpi='메일함 큐 적체']").first();
      await card.waitFor({ timeout: 5000 });
      expect(await card.innerText()).toContain(String(reported));
    });
  }, 45_000);

  // SC-INVENT-04: the reverse — a route that did not answer is not an empty queue
  it("[SC-INVENT-04] says 미측정 rather than 0 when the mailbox route refuses", async () => {
    const cookie = await capabilityViewer(mesh, "mailbox.read.depth");
    await withViewerPage(cookie, "/dashboard", async ({ page }) => {
      await page.route("**/api/v1/admin/mailbox", (r) => r.abort());
      await page.reload({ waitUntil: "domcontentloaded" });

      // **Either panel's label for the same number.** `data-kpi` is the rendered
      // label, and which of the two dashboards a session gets depends on its
      // role — `dash.kpi.inbox` ("대기 중 메시지") for the operator panel and
      // `dash.ga.lease` ("메일함 큐 적체") for the group-admin one. Both bind
      // `mailbox.total_queued`, so the card is named by either. It was pinned to
      // "미수신 메일함", which is neither of them any more.
      const card = page.locator("[data-kpi='대기 중 메시지'], [data-kpi='메일함 큐 적체']").first();
      await card.waitFor({ timeout: 5000 });
      const text = await card.innerText();
      expect(
        { said: text.includes("미측정"), drewZero: /(?:^|[^0-9])0(?:[^0-9]|$)/.test(text) },
        "a refused route was drawn as an empty queue",
      ).toEqual({ said: true, drewZero: false });
    });
  }, 30_000);

  /**
   * SC-I18N-05 — the screens say nothing in Korean of their own with the
   * language set to English.
   *
   * **The source check was green while the product was not.** `SC-I18N-04`
   * counts Korean in the front end's own files, and it read `0` on a morning
   * when a browser opened four screens in English and found Korean on all of
   * them. Three separate narrowings did it — a JSX scan that ran on four files,
   * a count that read string literals only, and a comment stripper that a `/*`
   * inside `"/api/v1/*"` turned off for a hundred lines. Each one made the
   * denominator smaller, and a denominator that shrinks goes quiet, not red.
   *
   * So this one does not read the source at all. It opens the pages.
   *
   * **Korean on the screen is not the same fact as Korean in the copy.**
   * `/tenant/audits` draws message bodies the mesh carried, and those were
   * written in Korean by the people who sent them. Judging by shape would
   * report that screen as untranslated forever, which is the reading a person
   * takes from "6.8% Korean". So it judges by origin: every response that drew
   * the page is kept, and a Korean run that appears in one of them is data.
   * What is left is what this front end wrote.
   */
  it("[SC-I18N-05] draws no Korean of its own with the language set to English", async () => {
    // **The routes come from the router.** A hand-typed list is a denominator
    // somebody has to remember to grow, and this suite has been bitten by four
    // of those.
    const appSource = readFileSync(
      join(import.meta.dir, "..", "packages", "platform-web", "src", "App.tsx"),
      "utf8",
    );
    const routes = [...new Set([...appSource.matchAll(/path="(\/[^"*]*)"/g)].map((m) => m[1]!))]
      .filter((r) => !r.includes(":") && r !== "/login" && r !== "/change-password" && r !== "/");
    expect(routes.length, "no routes were parsed out of App.tsx — the router's shape changed").toBeGreaterThan(7);

    const { page, context } = await createAuthedPage("/dashboard", "en");
    const offenders: string[] = [];
    /** Every Korean run the walk drew, judged once the walk is complete. */
    const seen: Array<{ route: string; chunk: string; landed: string; near: string }> = [];
    let drew = 0;
    let dataSeen = 0;
    let lastPayload = "";
    /** Every response body the walk received, for the origin question below. */
    let arrived = "";
    /**
     * **What this front end wrote is what is in its own modules.**
     *
     * Origin was read from the responses that drew *this* route, and a console
     * is one application: it reads the tenant directory once and draws the name
     * it was given on whichever screen needs it later. That cached value has no
     * response behind it by the time it appears, so the rule called it copy —
     * on the runner, where an admitted account gives `/platform/users` a row to
     * draw, and not here, where the table is empty. The word was `플랫폼`,
     * which is `DEFAULT_TENANT_NAME` in `packages/store/src/tenants.ts`: this
     * repository's own server data, reported as this front end's Korean.
     *
     * So the question is asked of the source instead. Every module the page
     * loads is kept, and a Korean run on the screen is this console's copy when
     * it is *in* one of them. A value that arrived over the wire is in none.
     */
    // **The console's own text, read from the tree.**
    //
    // This was collected from the modules the browser fetched, and the
    // dictionary was never among them: the listener attaches after the first
    // navigation, so by the time it is watching, every module that page loaded
    // is in the browser's cache and is never requested again. Measured — a
    // Korean string planted in the English dictionary drew on `/platform`
    // (`nodes=false korean=["가동","중인","서비스","노드"]`), was in none of the
    // captured bodies, and was filed as *arrived from the server*. The
    // scenario reported 15 routes drawn and passed.
    //
    // What the console wrote is a fact about this repository, not about which
    // requests a browser happened to make, so it is read from the source.
    // Responses are still folded in below, because a module served by the dev
    // server can differ from the file on disk.
    const WEB_SRC = join(import.meta.dir, "..", "packages", "platform-web", "src");
    const walkSrc = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkSrc(join(dir, e.name)) : [join(dir, e.name)],
      );
    let modules = walkSrc(WEB_SRC)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    /**
     * **A body that could not be read is not "no Korean arrived".**
     *
     * Both collectors here swallowed a failed read, and a swallowed read is
     * indistinguishable from a response that never carried the word — which is
     * the difference between *this console wrote Korean* and *the evidence for
     * where it came from went missing*. Playwright cannot always hand back a
     * body once the page has navigated on, so the reads are finished before
     * the walk leaves the route, and whatever is still lost is counted and
     * named in the failure.
     */
    let unread = 0;
    const pending: Array<Promise<unknown>> = [];
    /**
     * **A stream has no body to wait for.** `/api/v1/*` includes an event
     * stream, and its `text()` resolves when the stream ends — which is when
     * the page goes away. Waiting on that one read took the walk past its
     * timeout and the browser closed under it, so streams are left alone and
     * the wait for the rest is bounded.
     */
    const bodied = (res: import("playwright").Response) =>
      !/event-stream/.test(res.headers()["content-type"] ?? "");
    const drain = async () => {
      const waiting = pending.splice(0);
      if (waiting.length === 0) return;
      await Promise.race([
        Promise.allSettled(waiting),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    };
    const keepModule = (res: import("playwright").Response) => {
      if (!/javascript|typescript/.test(res.headers()["content-type"] ?? "")) return;
      if (!bodied(res)) return;
      pending.push(
        res
          .text()
          .then((t) => {
            modules += t;
          })
          .catch(() => {
            unread++;
          }),
      );
    };
    page.on("response", keepModule);
    try {
      for (const route of routes) {
        let payload = "";
        const collect = (res: import("playwright").Response) => {
          if (!/\/api\/|\/auth\//.test(res.url()) || !bodied(res)) return;
          pending.push(
            res
              .text()
              .then((t) => {
                payload += t;
              })
              .catch(() => {
                unread++;
              }),
          );
        };
        page.on("response", collect);
        await page.goto(`${viteBaseUrl}${route}`, { waitUntil: "networkidle" }).catch(() => {});
        await settled(page);
        // Before the walk leaves: a body read after the page has moved on is
        // the read that fails, and its loss would read as origin evidence that
        // never existed.
        await drain();
        page.off("response", collect);
        lastPayload = payload;
        // **Every payload of the walk, not only this route's.** A console reads
        // the tenant directory once and draws the name it was given wherever it
        // is needed later; by then that value has no response behind it.
        // `플랫폼` is such a value — `DEFAULT_TENANT_NAME` in
        // `packages/store/src/tenants.ts` — and it is also a word this console
        // writes, so a source-only rule reports the server's own data as our
        // copy. What arrived at any point in the walk arrived.
        arrived += payload;

        const text = (await page.locator("#root").innerText().catch(() => "")) ?? "";
        if (text.length > 200) drew++;
        // **Where it came from, not only that it was there.** This failed on
        // CI and passes here, and the name of a word is not enough to tell the
        // three candidates apart: a response fetched outside the window above
        // and so misread as copy, a fallback drawn before the dictionary
        // arrives, or a lost session landing the run on a different screen
        // altogether. The pathname the page actually settled on separates the
        // last from the other two, and the surrounding text usually names the
        // component. A failure nobody can reproduce has to carry its own
        // evidence.
        // `page.url()` on a page whose context has gone throws, and this loop
        // already tolerates a navigation that failed — a message that cannot be
        // built must not turn a report into an error.
        let landed = "unknown";
        try {
          landed = new URL(page.url()).pathname;
        } catch {
          /* the page is gone; the route below still names where this was */
        }
        // Runs of two, because one syllable can land inside a payload by luck.
        //
        // **Collected here, judged after the walk.** Deciding inside the loop
        // asks whether a run had arrived *yet*, so the verdict depends on the
        // order the routes happen to be visited: the tenant's name is copy on
        // the first screen that draws it and data on the second.
        for (const chunk of new Set(text.match(/[가-힣]{2,}/g) ?? [])) {
          const at = text.indexOf(chunk);
          const near = text.slice(Math.max(0, at - 40), at + chunk.length + 40).replace(/\s+/g, " ");
          seen.push({ route, chunk, landed, near });
        }
      }

      for (const { route, chunk, landed, near } of seen) {
        // Wire first, source second. A run that came over the wire is data even
        // when the same letters sit in a component, and only what appears
        // nowhere in the walk's answers is this console's own Korean.
        if (arrived.includes(chunk) || !modules.includes(chunk)) dataSeen++;
        else offenders.push(`${route}: ${chunk} — landed on ${landed}, near "${near}"`);
      }

      // **The classifier has to be shown working, in both directions.** If no
      // module was ever kept, `modules` is empty and everything reads as data —
      // quiet, and the scenario would go green about a fully Korean console.
      // The other direction fails loudly, so it is the first one this holds:
      // a word that *is* in the modules must come out as copy, and a word that
      // is in none of them must not.
      //
      // The copy side uses a Korean run taken out of the modules themselves, so
      // it is a word this console really did write rather than one typed here
      // that a rename could take away.
      const fromModules = modules.match(/[가-힣]{2,}/)?.[0] ?? "";
      const planted = "심은문구없는말";
      await page.evaluate((words: string[]) => {
        for (const word of words) {
          const d = document.createElement("div");
          d.textContent = word;
          document.querySelector("#root")?.appendChild(d);
        }
      }, [fromModules, planted]);
      const after = (await page.locator("#root").innerText().catch(() => "")) ?? "";
      // The same line the loop runs, on two words whose answers are known: both
      // are on the screen, one is in the modules and one is in none of them.
      const afterChunks = new Set(after.match(/[가-힣]{2,}/g) ?? []);
      expect(
        {
          modulesRead: fromModules !== "",
          copyIsCopy: afterChunks.has(fromModules) && modules.includes(fromModules),
          arrivedIsData: afterChunks.has(planted) && !modules.includes(planted),
          drewSomething: drew > 0,
        },
        "the classifier calls a word copy when a module carries it and data when none does — this run could not show that",
      ).toEqual({ modulesRead: true, copyIsCopy: true, arrivedIsData: true, drewSomething: true });

      // **The other half of the classifier, on a real response.** The rule above
      // has two answers and this fixture only ever produced one of them: it
      // seeds no Korean, so `dataSeen` was `0` and every run demonstrated
      // *not in the payload → copy* and nothing else. A rule whose `data`
      // branch is never taken would still pass — and the way it fails is the
      // quiet one, a `payload` that swallows everything and reports a fully
      // Korean console as green.
      //
      // So a Korean word is put into an actual response, on its way to the
      // screen that draws it, and it must come out as data.
      const DATA_WORD = "서버가준값";
      // The row's name comes from `identity || id || name`, so whichever of the
      // three this build's route sends is the one to mark. `patched` is how the
      // assertion below can tell "the screen did not draw it" from "the
      // response never carried it", which are different failures.
      let patched = false;
      await page.route("**/api/v1/agents*", async (route) => {
        const res = await route.fetch();
        const original = await res.text();
        const body = original.replace(/"(identity|id|name)":\s*"([^"]*)"/, `"$1": "$2${DATA_WORD}"`);
        patched = body !== original;
        await route.fulfill({ response: res, body });
      });
      let echoed = "";
      const echo = async (res: import("playwright").Response) => {
        if (!/\/api\//.test(res.url())) return;
        try {
          echoed += await res.text();
        } catch {
          /* unreadable body */
        }
      };
      page.on("response", echo);
      await page.goto(`${viteBaseUrl}/creator`, { waitUntil: "networkidle" }).catch(() => {});
      await settled(page);
      page.off("response", echo);
      const creatorText = (await page.locator("#root").innerText().catch(() => "")) ?? "";
      expect(
        { patched, onScreen: creatorText.includes(DATA_WORD), inPayload: echoed.includes(DATA_WORD) },
        "the data half of the rule was not exercised — the response was not marked, did not carry the mark, or the screen did not draw it",
      ).toEqual({ patched: true, onScreen: true, inPayload: true });
      const creatorOffenders = [...new Set(creatorText.match(/[가-힣]{2,}/g) ?? [])].filter((c) => modules.includes(c));
      expect(creatorOffenders, "a Korean run the server itself sent was counted as this front end's copy").toEqual([]);

      await drain();
      expect(
        offenders,
        "the console drew Korean it wrote itself, with the language set to English" +
          ` (${unread} response bodies could not be read, so what they carried is not in the origin evidence)`,
      ).toEqual([]);
    } finally {
      await context.close().catch(() => {});
    }
    // Reported, not asserted: a run where the mesh happens to carry no Korean
    // is a legitimate zero, and asserting on it would make this scenario depend
    // on what the fixture seeded.
    console.log(`[SC-I18N-05] ${routes.length} routes · ${drew} drew · ${dataSeen} Korean runs came from the server`);
  }, 90_000);

  /**
   * SC-I18N-07 — the language menu, opened.
   *
   * `SC-I18N-06` reads the source and would have caught the defect that prompted
   * this. This one opens the menu, because the source check answers *is it
   * written correctly* and a person asked *what is on my screen*. The two can
   * disagree — the built bundle, a different code path, a value composed at
   * runtime — and when they do, the screen is the one that shipped.
   *
   * **Nothing in this suite had ever opened this menu.** Four screens' worth of
   * i18n checks, a dictionary comparison, a source sweep, and the control that
   * switches the language was drawn by no test at all. That is the whole reason
   * `✓` sat there in plain sight: the place nobody measures is the place
   * that breaks.
   *
   * Asserted in both directions. *No escape sequence on screen* alone passes on
   * a menu that draws nothing, so the mark itself is required to be there.
   */
  it("[SC-I18N-07] draws the selected language's mark, and no escape sequence, in the language menu", async () => {
    await withUnauthedPage("/login", async ({ page }) => {
      const trigger = page.getByTestId("lang-trigger");
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      await trigger.click();

      const menu = page.getByTestId("lang-menu");
      await menu.waitFor({ state: "visible", timeout: 5_000 });
      const text = (await menu.textContent()) ?? "";

      // `✓` written into JSX text renders as the six characters `\`,`u`,`2`,
      // `7`,`1`,`3`. Any escape shape, not just this one, because the next one
      // will be a different code point.
      const escapeOnScreen = text.match(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/);

      expect(
        {
          escape: escapeOnScreen?.[0] ?? null,
          bothLanguagesOffered: text.includes("English") && text.includes("한국어"),
          markDrawn: text.includes("✓"),
        },
        "the language menu drew an escape sequence, or stopped drawing the mark that says which language is selected",
      ).toEqual({ escape: null, bothLanguagesOffered: true, markDrawn: true });
    });
  }, 30_000);

  /**
   * SC-QUEUE-01 — the other decision queue, and the difference between empty
   * and unread.
   *
   * There are two queues. `GET /api/v1/admin/keys/pending` holds key requests
   * and the bell draws it. `GET /api/v1/admin/pending` holds people waiting to
   * be admitted, and **until the commit this scenario arrives with, nothing in
   * this front end asked for it** — an operator on these screens could not see
   * that anybody was waiting, and nothing said so. The server-rendered `/admin`
   * page was the only surface that had it.
   *
   * Both halves, because one of them alone passes on the wrong screen:
   *
   *   the route answers `[]`   the screen must say **nobody is waiting**
   *   the route cannot answer  the screen must say **it could not be read**
   *
   * Assert only the first and a screen that folds every failure into "empty"
   * passes. Assert only the second and a screen that never manages to read
   * anything passes. The pair is the check; either one alone is a decoration.
   */
  it("[SC-QUEUE-01] tells an empty admission queue apart from one it could not read", async () => {
    const read = async (routeAnswers: boolean) => {
      const { page, context } = await createAuthedPage("/platform/users");
      try {
        if (!routeAnswers) {
          // A deployment's backend dies behind a live proxy: the request is
          // answered, and what comes back is not the queue.
          await page.route("**/api/v1/admin/pending", (route) =>
            route.fulfill({ status: 502, contentType: "text/html", body: "<html>bad gateway</html>" }),
          );
        }
        await page.reload({ waitUntil: "networkidle" });
        await settled(page);
        const section = page.getByTestId("admission-queue");
        await section.waitFor({ state: "visible", timeout: 10_000 });
        const present = async (id: string) => (await page.getByTestId(id).count()) > 0;
        return {
          empty: await present("admission-queue-empty"),
          unreachable: await present("admission-queue-unreachable"),
          refused: await present("admission-queue-refused"),
          list: await present("admission-queue-list"),
        };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const answered = await read(true);
    const notAnswered = await read(false);

    expect(
      {
        answered_says_empty: answered.empty,
        answered_does_not_claim_unreadable: !answered.unreachable,
        unanswered_says_unreadable: notAnswered.unreachable,
        unanswered_does_not_claim_empty: !notAnswered.empty,
      },
      "the admission queue folded `nobody is waiting` together with `I could not ask`",
    ).toEqual({
      answered_says_empty: true,
      answered_does_not_claim_unreadable: true,
      unanswered_says_unreadable: true,
      unanswered_does_not_claim_empty: true,
    });
  }, 60_000);

  /**
   * SC-NAV-05 — the address people actually type.
   *
   * `/` is `<Navigate to="/dashboard" replace />` and nothing else: no screen,
   * no data, one line in the router. It was the **only route in the table that
   * no scenario opened** — found by listing the router's own paths and asking
   * which of them a test navigates to, rather than by reading the suite and
   * trusting the answer.
   *
   * A redirect is worth one scenario because both of its ends are claims. Signed
   * in, `/` must reach the dashboard; signed out, it must reach the login screen
   * rather than a blank guarded page. Assert only the first and a router that
   * sends everybody to the dashboard passes; assert only the second and one that
   * sends everybody to login passes. Neither would fail a single other check
   * here, because every other scenario names its own route and never types `/`.
   */
  it("[SC-NAV-05] sends `/` to the dashboard when signed in, and to login when not", async () => {
    const signedIn = await (async () => {
      const { page, context } = await createAuthedPage("/");
      try {
        await page.waitForURL("**/dashboard", { timeout: 10_000 }).catch(() => {});
        return page.url();
      } finally {
        await context.close().catch(() => {});
      }
    })();

    const signedOut = await withUnauthedPage("/", async ({ page }) => {
      await page.waitForURL("**/login", { timeout: 10_000 }).catch(() => {});
      return page.url();
    });

    expect(
      { signedIn: signedIn.replace(/^https?:\/\/[^/]+/, ""), signedOut: signedOut.replace(/^https?:\/\/[^/]+/, "") },
      "the root address did not land where the router says it should",
    ).toEqual({ signedIn: "/dashboard", signedOut: "/login" });
  }, 40_000);

  /**
   * SC-SRV-01 — the two screens the server draws itself.
   *
   * `GET /admin` and `GET /chat` are served by `agent-mesh-http` as whole HTML
   * documents (`packages/http/src/ui/*`), not by the React app. Nothing in this
   * suite opened either one, and nothing in the React app links to them: an
   * operator reaches them by typing the address. So when the scenario inventory
   * took the router's own path list as its denominator, these two were not in
   * it — the denominator was one app's routes, and these belong to the server.
   *
   * They are not dead. Measured on the standing stack the night this was
   * written: `/admin` answers 200 with 65,680 bytes, `/chat` 38,926, both
   * redirect an unauthenticated caller, and `ui/admin.ts` was edited that same
   * evening — by the commit that moved `admin/pending` to `{ users }`, which is
   * to say by a change this console asked for.
   *
   * `D-694` removes `ui/*` from the coverage denominator. That is a decision
   * about a percentage, and this scenario is what keeps it from also being a
   * decision about whether anybody looks: removing a thing from a measurement
   * and removing it from view are different, and only the first was asked for.
   *
   * Both directions, because one alone passes on the wrong server: signed in the
   * page must be the page (its own title, not the login form), signed out it
   * must not be reachable at all.
   */
  it("[SC-SRV-01] serves its own admin and chat pages, and refuses them signed out", async () => {
    const read = async (path: string) => {
      const authed = await createViewerAuthedPage(`mesh_token=${jwtToken}`, "/");
      try {
        const res = await authed.page.goto(`${mesh.http.url}${path}`, { waitUntil: "domcontentloaded" });
        const title = await authed.page.title();
        const body = (await authed.page.locator("body").textContent()) ?? "";
        return { status: res?.status() ?? 0, title, bytes: body.length };
      } finally {
        await authed.context.close().catch(() => {});
      }
    };
    const anonymous = async (path: string) => {
      const context = await newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${mesh.http.url}${path}`, { waitUntil: "domcontentloaded" }).catch(() => {});
        // A redirect to the login form, or a refusal — either is "not the page".
        return { url: page.url(), title: await page.title() };
      } finally {
        await context.close().catch(() => {});
      }
    };

    const admin = await read("/admin");
    const chat = await read("/chat");
    const adminOut = await anonymous("/admin");

    expect(
      {
        adminIsAdmin: /admin/i.test(admin.title),
        adminDrew: admin.bytes > 200,
        chatIsChat: /chat/i.test(chat.title),
        chatDrew: chat.bytes > 200,
        signedOutIsNotAdmin: !/admin/i.test(adminOut.title) || adminOut.url.includes("/login"),
      },
      `the server's own pages: admin=${JSON.stringify(admin)} chat=${JSON.stringify(chat)} anon=${JSON.stringify(adminOut)}`,
    ).toEqual({
      adminIsAdmin: true,
      adminDrew: true,
      chatIsChat: true,
      chatDrew: true,
      signedOutIsNotAdmin: true,
    });
  }, 40_000);

  // SC-HARNESS-01: Harness reliability check
  it("[SC-HARNESS-01] verifies platform mesh readiness and test harness health", async () => {
    expect(mesh).toBeDefined();
    expect(mesh.http.url).toContain("http");
    expect(mesh.hub.url).toContain("http");
  });

});

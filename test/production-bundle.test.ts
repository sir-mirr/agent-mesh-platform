/**
 * What the production build actually says, read out of the build.
 *
 * Three defects in one evening were invisible in the source and plain in the
 * artifact — the pairing screen's hardcoded address, this file's subject, and
 * `dist` requiring the root of its host. agent-mesh-local-pm found all three by
 * building and reading, which until then nobody had done.
 *
 * **The production path had never been executed.** `.env.development` is empty
 * and every test and every local run is a dev build, so
 * `.env.production` — a tracked file setting
 * `VITE_API_BASE_URL=https://api.mesh.enterprise.internal`, a host nobody owns —
 * reached nothing that checks. `import.meta.env` bakes it in at build time, so
 * every API call in a production build went to that host: the proxy was never
 * reached, and the symptom is this repository's oldest one, a screen that
 * renders while nothing behind it answers.
 *
 * A source check cannot see this. The one added the same evening looks for
 * `localhost` and the hub's port, and that address is neither — it asks *is this
 * a local address* when the question is *is this an address this deployment can
 * reach*. Only the artifact answers that.
 *
 * Built into a temporary directory rather than `dist`, so running the suite
 * does not leave the tree in a state another measurement has to reason about.
 */

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

import { freePort, startMesh, type Mesh } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "web-dist-"));
let mesh: Mesh | null = null;
let preview: ReturnType<typeof spawn> | null = null;
afterAll(() => {
  preview?.kill();
  mesh?.stop();
  rmSync(out, { recursive: true, force: true });
});

/** Build once; both tests read the same artifact. */
function build(): void {
  const run = Bun.spawnSync(["bun", "run", "build", "--outDir", out, "--emptyOutDir"], {
    cwd: join(REPO_ROOT, "packages", "platform-web"),
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const said = run.stdout.toString() + run.stderr.toString();
  expect({ code: run.exitCode, tail: said.slice(-400) }).toMatchObject({ code: 0 });
}

test("the production bundle asks the page's own origin for the API", async () => {
  build();

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const scripts = walk(out).filter((f) => f.endsWith(".js"));
  expect(scripts.length, "the build produced no javascript to read").toBeGreaterThan(0);

  // The value as the bundler writes it: `API_BASE_URL:"…"`, property names
  // intact because they are read from an object literal rather than mangled.
  const baked = scripts.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/API_BASE_URL\s*:\s*"([^"]*)"/g)].map((m) => m[1]!),
  );
  expect(baked.length, "API_BASE_URL is not in the bundle — the build's shape changed").toBeGreaterThan(0);

  // Empty is the whole assertion. Anything else is an absolute host baked in at
  // build time, and the browser will go there instead of through the proxy.
  expect(baked.filter((v) => v !== "")).toEqual([]);
}, 120_000);

/**
 * And the same question asked of a running browser, which is the only one that
 * answers it.
 *
 * Reading the bundle proves a string. It does not prove that the app, loaded
 * and executing, sends its requests anywhere reachable — and the defect above
 * lived exactly in that gap: the source was right, every test was green, and
 * the dev build worked. agent-mesh-local-pm built the missing layer as an audit
 * script and measured it in both directions: on the broken build, zero
 * same-origin requests, one to `api.mesh.enterprise.internal`, and **350
 * characters in `#root`** — the screen rendered and every call failed. It is
 * here rather than in a workspace because a measurement that lives beside the
 * code is the one still running next month.
 *
 * `vite preview` is used for the shape rather than as a recommendation — it
 * serves the built files and proxies `/api`, which is the deployment's topology.
 * `docs/running-locally.md` says plainly that it is not a production server.
 */
test("a loaded page sends its API calls to its own origin", async () => {
  build();
  mesh = await startMesh();

  const port = await freePort();
  const viteBin = resolve(import.meta.dir, "../packages/platform-web/node_modules/vite/bin/vite.js");
  preview = spawn(
    process.execPath,
    [viteBin, "preview", "--outDir", out, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: join(REPO_ROOT, "packages", "platform-web"),
      // The proxy the static host will provide, standing in for it here.
      // `preview` takes its proxy from `server.proxy` when `preview.proxy` is
      // unset, which is how `vite.config.ts` is written.
      env: { ...process.env, API_PROXY_TARGET: mesh.http.url },
      stdio: "pipe",
    },
  );

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`preview never answered on ${origin}`);
    await Bun.sleep(100);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const elsewhere: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return;
      elsewhere.push(url);
    });

    await page.goto(`${origin}/login`, { waitUntil: "networkidle" });

    // Fonts are a documented decision, not this test's subject.
    const offOrigin = elsewhere.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
    expect(offOrigin, "the page is calling a host it was not served from").toEqual([]);

    // Rendered, and rendered is not the assertion — the broken build rendered
    // too. This only says the page got far enough for the requests above to be
    // the ones it actually makes.
    const rendered = await page.evaluate(() => document.querySelector("#root")?.innerHTML.length ?? 0);
    expect({ rendered: rendered > 400 }).toEqual({ rendered: true });
  } finally {
    await browser.close();
  }
}, 180_000);

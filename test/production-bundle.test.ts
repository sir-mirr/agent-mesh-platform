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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "web-dist-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

test("the production bundle asks the page's own origin for the API", async () => {
  const build = Bun.spawnSync(["bun", "run", "build", "--outDir", out, "--emptyOutDir"], {
    cwd: join(REPO_ROOT, "packages", "platform-web"),
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const said = build.stdout.toString() + build.stderr.toString();
  expect({ code: build.exitCode, tail: said.slice(-400) }).toMatchObject({ code: 0 });

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

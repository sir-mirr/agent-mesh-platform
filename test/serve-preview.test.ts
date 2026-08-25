/**
 * The design-system preview server, which nothing was measuring.
 *
 * It is a development tool, and the reason it is worth a suite anyway is the
 * script it injects into every page it serves. That script lives in a template
 * literal — the same shape that carried a TypeScript annotation into the admin
 * console's browser JavaScript and killed every control on the page for four
 * months. A hot-reload client that will not parse fails the same quiet way:
 * pages still render, and the reloading simply stops, which reads as "nothing
 * changed on disk".
 *
 * Spawned rather than imported: the file has no exports and serves at the top
 * level. `PORT=0` asks the operating system for a free port, and the port it
 * chose is read back off the banner the server prints.
 */

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SERVER = resolve(import.meta.dir, "..", "scripts", "serve-preview.ts");
const PREVIEW_DIR = resolve(import.meta.dir, "..", "preview");

interface Preview {
  url: string;
  stop: () => void;
}

/** Starts the server on a port the kernel picks, and waits for its banner. */
async function preview(): Promise<Preview> {
  const proc = Bun.spawn(["bun", SERVER], {
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let banner = "";
  const deadline = Date.now() + 15_000;
  while (!/http:\/\/localhost:(\d+)/.test(banner)) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`the preview server printed no address in 15s: ${banner}`);
    }
    const { value, done } = await reader.read();
    if (done) {
      proc.kill();
      throw new Error(`the preview server exited before serving: ${banner}`);
    }
    banner += decoder.decode(value);
  }
  const port = banner.match(/http:\/\/localhost:(\d+)/)![1];
  reader.releaseLock();
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => proc.kill(),
  };
}

/** The one script this server adds to a page it did not write. */
function injected(html: string): string {
  const block = [...html.matchAll(/<script id="__hot_reload_script__">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  if (block.length !== 1) throw new Error(`expected one injected script, found ${block.length}`);
  return block[0]!;
}

describe("the preview server", () => {
  test("injects a hot-reload script a browser can parse", async () => {
    const server = await preview();
    try {
      const html = await (await fetch(`${server.url}/`)).text();
      // `new Function` is the parse a browser does. The script is written
      // inside a template literal, where nothing else in the build reads it as
      // code at all.
      expect(() => new Function(injected(html))).not.toThrow();
      expect(injected(html)).toContain("EventSource('/livereload')");
    } finally {
      server.stop();
    }
  }, 30_000);

  test("serves the page's own markup, not only the script it added", async () => {
    const server = await preview();
    try {
      const res = await fetch(`${server.url}/`);
      const html = await res.text();
      expect(res.headers.get("content-type")).toContain("text/html");
      // The injection goes before the closing tag rather than after the
      // document: a script appended past `</body>` is at the mercy of the
      // parser's error recovery.
      expect(html.indexOf("__hot_reload_script__")).toBeLessThan(html.lastIndexOf("</body>"));
    } finally {
      server.stop();
    }
  }, 30_000);

  test("the reload stream opens and says so", async () => {
    const server = await preview();
    try {
      const res = await fetch(`${server.url}/livereload`);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      // The opening comment is what tells a client the stream is live rather
      // than merely accepted.
      expect(new TextDecoder().decode(value)).toContain(": connected");
      await reader.cancel();
    } finally {
      server.stop();
    }
  }, 30_000);

  test("a change on disk reaches an open browser", async () => {
    const server = await preview();
    const scratch = join(PREVIEW_DIR, `probe-${process.pid}.html`);
    try {
      const res = await fetch(`${server.url}/livereload`);
      const reader = res.body!.getReader();
      await reader.read(); // the opening comment

      // Not a dotted name: the watcher skips those, so a probe file called
      // `.probe` would prove the test's own naming and nothing else.

      writeFileSync(scratch, "<!doctype html><body></body>");
      const said = await Promise.race([
        reader.read().then(({ value }) => new TextDecoder().decode(value ?? new Uint8Array())),
        new Promise<string>((r) => setTimeout(() => r("<nothing in 10s>"), 10_000)),
      ]);
      expect(said).toContain("data: reload");
      await reader.cancel();
    } finally {
      rmSync(scratch, { force: true });
      server.stop();
    }
  }, 30_000);

  test("a path that climbs out of the preview directory is not served", async () => {
    // The file is chosen by joining the request path onto a directory, so this
    // is the assertion that says which paths that can reach.
    const server = await preview();
    try {
      const climbs = await Promise.all(
        ["/%2e%2e/package.json", "/..%2fpackage.json", "/%2e%2e%2f%2e%2e%2fpackage.json"].map(
          async (path) => [path, (await fetch(`${server.url}${path}`)).status] as const,
        ),
      );
      expect(Object.fromEntries(climbs)).toEqual({
        "/%2e%2e/package.json": 404,
        "/..%2fpackage.json": 404,
        "/%2e%2e%2f%2e%2e%2fpackage.json": 404,
      });
    } finally {
      server.stop();
    }
  }, 30_000);

  test("a file it does not have is a 404, not an empty page", async () => {
    const server = await preview();
    try {
      const res = await fetch(`${server.url}/nothing-here.css`);
      expect({ status: res.status, body: await res.text() }).toEqual({ status: 404, body: "Not found" });
    } finally {
      server.stop();
    }
  }, 30_000);
});

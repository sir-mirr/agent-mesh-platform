#!/usr/bin/env bun
/**
 * Quick preview server for the Agent Mesh Design System preview.
 * Usage: bun scripts/serve-preview.ts [port]
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || process.argv[2] || 3005);
const HTML_PATH = join(import.meta.dir, "..", "preview", "index.html");

if (!existsSync(HTML_PATH)) {
  console.error("Error: preview/index.html not found.");
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(HTML_PATH, "utf8");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n============================================================`);
console.log(`🎨 Agent Mesh UI Preview Server running at:`);
console.log(`👉 http://localhost:${server.port}`);
console.log(`============================================================\n`);

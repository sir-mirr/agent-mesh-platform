#!/usr/bin/env bun
/**
 * LiveReload preview server for the Agent Mesh Design System preview.
 * Watches preview/ directory and automatically reloads connected browsers on changes.
 * Usage: bun scripts/serve-preview.ts [port]
 */

import { readFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || process.argv[2] || 3005);
const PREVIEW_DIR = join(import.meta.dir, "..", "preview");
const HTML_PATH = join(PREVIEW_DIR, "index.html");

if (!existsSync(HTML_PATH)) {
  console.error("Error: preview/index.html not found.");
  process.exit(1);
}

// Active SSE client connections
const subscribers = new Set<ReadableStreamDefaultController>();

// Watch directory for file changes
let reloadDebounce: Timer | null = null;
watch(PREVIEW_DIR, { recursive: true }, (event, filename) => {
  if (!filename || filename.startsWith(".")) return;
  if (reloadDebounce) clearTimeout(reloadDebounce);
  reloadDebounce = setTimeout(() => {
    console.log(`[HotReload] File changed: ${filename} -> Reloading browsers`);
    const payload = `data: reload\n\n`;
    for (const controller of subscribers) {
      try {
        controller.enqueue(new TextEncoder().encode(payload));
      } catch {
        subscribers.delete(controller);
      }
    }
  }, 60);
});

// Client Hot-Reload Script injected dynamically into HTML
const HOT_RELOAD_SCRIPT = `
  <!-- Instant Hot-Reloading Client Script -->
  <script id="__hot_reload_script__">
    (() => {
      let isReconnecting = false;
      function connectLiveReload() {
        const es = new EventSource('/livereload');
        es.onmessage = (e) => {
          if (e.data === 'reload') {
            console.log('%c[HotReload] Code changed, refreshing UI...', 'color:#2563EB; font-weight:bold;');
            window.location.reload();
          }
        };
        es.onerror = () => {
          es.close();
          if (!isReconnecting) {
            isReconnecting = true;
            setTimeout(() => {
              isReconnecting = false;
              connectLiveReload();
            }, 1000);
          }
        };
      }
      connectLiveReload();
    })();
  </script>
`;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  fetch(req) {
    const url = new URL(req.url);

    // 1. SSE LiveReload Event Stream
    if (url.pathname === "/livereload") {
      let clientController: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          subscribers.add(controller);
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
        cancel() {
          subscribers.delete(clientController);
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 2. Main HTML with injected Hot-Reload client script
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let html = readFileSync(HTML_PATH, "utf8");
      if (html.includes("</body>")) {
        html = html.replace("</body>", `${HOT_RELOAD_SCRIPT}</body>`);
      } else {
        html += HOT_RELOAD_SCRIPT;
      }

      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        },
      });
    }

    // 3. Static Assets (Images, Icons, Fonts)
    const filePath = join(PREVIEW_DIR, url.pathname);
    if (existsSync(filePath)) {
      const fileBytes = readFileSync(filePath);
      let contentType = "application/octet-stream";
      if (url.pathname.endsWith(".jpg") || url.pathname.endsWith(".jpeg")) contentType = "image/jpeg";
      else if (url.pathname.endsWith(".png")) contentType = "image/png";
      else if (url.pathname.endsWith(".svg")) contentType = "image/svg+xml";
      else if (url.pathname.endsWith(".css")) contentType = "text/css";
      else if (url.pathname.endsWith(".js")) contentType = "application/javascript";

      return new Response(fileBytes, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n============================================================`);
console.log(`⚡ Agent Mesh UI Preview Server (with Instant Hot-Reload)`);
console.log(`👉 http://localhost:${server.port}`);
console.log(`============================================================\n`);

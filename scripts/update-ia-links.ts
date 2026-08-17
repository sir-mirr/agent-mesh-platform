#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PREVIEW_DIR = join(import.meta.dir, "..", "preview");

function processDir(dir: string) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      processDir(fullPath);
    } else if (entry.endsWith(".html") && entry !== "ia.html") {
      let content = readFileSync(fullPath, "utf8");
      if (content.includes('class="preview-control-bar"')) {
        // Check if IA link is already there
        if (!content.includes('href="/ia.html"')) {
          content = content.replace(
            '<a href="/index.html" class="btn btn-secondary btn-sm">🗂 All-in-One Hub</a>',
            '<a href="/ia.html" class="btn btn-primary btn-sm" style="background:#2563EB; color:white;">🗺️ IA 정보구조도</a>\n      <a href="/index.html" class="btn btn-secondary btn-sm">🗂 All-in-One Hub</a>'
          );
          writeFileSync(fullPath, content);
          console.log(`Updated header link in: ${fullPath.replace(PREVIEW_DIR, "")}`);
        }
      }
    }
  }
}

processDir(PREVIEW_DIR);
console.log("Done updating IA header links across preview pages!");

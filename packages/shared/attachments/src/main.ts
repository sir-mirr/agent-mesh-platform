/**
 * Lane-side attachment fetcher (SPEC § 15.4 pull-on-demand cache helper).
 *
 * Responsibilities:
 *   1. Resolve a SPEC § 15.2 `AttachmentMeta` to a local file path.
 *   2. Use a content-addressed cache under `cacheDir/<id>` to avoid
 *      re-downloading the same blob.
 *   3. Stream the body to a tempfile and atomically rename into place so
 *      concurrent lane processes never observe a partial file.
 *   4. Verify sha256 when the metadata carries it; discard the cache entry
 *      and throw on mismatch.
 *
 * This module is *not* responsible for cache eviction — eviction is run
 * out-of-process via `ops/bin/lane-attachments-evict.sh` (see SPEC § 15.4).
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

/** SPEC § 15.2 attachment metadata schema (subset used by the fetcher).
 *
 * SPEC § 15.2 declares `name` as the authoritative display filename
 * (MUST). The pre-rename `filename` alias is retained for backward
 * compatibility with legacy single-host producers; new consumers MUST
 * read `name` and MAY fall back to `filename` only when `name` is
 * absent. Both are typed as optional here because the fetcher only
 * consumes `id` / `download_url` / `sha256` — display-name resolution
 * is a consumer concern.
 */
export interface AttachmentMeta {
  id: string;
  /** Original client-supplied filename (SPEC § 15.2 `name`, MUST). */
  name?: string;
  /** @deprecated Legacy alias of `name`. Producers SHOULD emit both for BC; new consumers SHOULD prefer `name`. */
  filename?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  download_url: string;
}

export interface FetchAttachmentOptions {
  /** Override fetch (testing). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Verify sha256 on cache hits as well. Default: stat-only on hit. */
  verifyOnHit?: boolean;
  /** Request signal for cancellation / timeout. */
  signal?: AbortSignal;
  /** Optional structured logger. */
  log?: (msg: string) => void;
}

export interface FetchAttachmentResult {
  path: string;
  cached: boolean;
}

const ID_SAFE_RE = /^[0-9a-zA-Z._-]+$/;

function assertSafeId(id: string): void {
  if (!id || id.length > 256 || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`attachment: unsafe id: ${id}`);
  }
  if (!ID_SAFE_RE.test(id)) {
    throw new Error(`attachment: id contains disallowed characters: ${id}`);
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("data", (chunk) => hash.update(chunk as Buffer));
    rs.on("error", reject);
    rs.on("end", () => resolve());
  });
  return hash.digest("hex");
}

/**
 * Resolve an attachment to a local cache path, downloading on miss.
 * See SPEC § 15.4 for the contract this implements.
 */
export async function fetchAttachment(
  meta: AttachmentMeta,
  cacheDir: string,
  opts: FetchAttachmentOptions = {},
): Promise<FetchAttachmentResult> {
  assertSafeId(meta.id);
  if (!meta.download_url) {
    throw new Error(`attachment: missing download_url for id=${meta.id}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, meta.id);

  // Cache hit fast path.
  if (existsSync(cachePath)) {
    const stat = statSync(cachePath);
    if (stat.isFile() && stat.size > 0) {
      if (opts.verifyOnHit && meta.sha256) {
        const digest = await sha256OfFile(cachePath);
        if (digest !== meta.sha256.toLowerCase()) {
          opts.log?.(`attachment: cache mismatch id=${meta.id}, re-downloading`);
          try { unlinkSync(cachePath); } catch {}
        } else {
          return { path: cachePath, cached: true };
        }
      } else {
        return { path: cachePath, cached: true };
      }
    }
  }

  // Cache miss: stream to tempfile, then atomic rename.
  const tempName = `.${meta.id}.${randomBytes(6).toString("hex")}.tmp`;
  const tempPath = join(cacheDir, tempName);
  const fetchImpl = opts.fetch ?? (globalThis as { fetch: typeof fetch }).fetch;
  if (!fetchImpl) {
    throw new Error("attachment: no fetch implementation available");
  }

  const res = await fetchImpl(meta.download_url, opts.signal ? { signal: opts.signal } : {});
  if (!res.ok) {
    throw new Error(`attachment: fetch failed id=${meta.id} status=${res.status}`);
  }
  if (!res.body) {
    throw new Error(`attachment: empty body id=${meta.id}`);
  }

  // Stream the Web ReadableStream to disk + compute sha256 on the fly.
  const hash = createHash("sha256");
  const ws = createWriteStream(tempPath);
  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        if (!ws.write(value)) {
          await new Promise<void>((resolve) => ws.once("drain", () => resolve()));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve());
      ws.on("error", reject);
    });
  } catch (err) {
    try { unlinkSync(tempPath); } catch {}
    throw err;
  }

  if (meta.sha256) {
    const digest = hash.digest("hex");
    if (digest !== meta.sha256.toLowerCase()) {
      try { unlinkSync(tempPath); } catch {}
      throw new Error(
        `attachment: sha256 mismatch id=${meta.id} expected=${meta.sha256} actual=${digest}`,
      );
    }
  }

  try {
    renameSync(tempPath, cachePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch {}
    throw err;
  }
  opts.log?.(`attachment: fetched id=${meta.id} bytes=${statSync(cachePath).size}`);
  return { path: cachePath, cached: false };
}

/**
 * Resolve the lane attachment cache dir from environment.
 * Default: `/var/lib/agent-mesh/lane/<id>/attachments-cache/` (SPEC § 15.4).
 */
export function resolveLaneAttachmentCacheDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.LANE_ATTACHMENT_CACHE_DIR;
  if (explicit && explicit.trim()) return explicit.trim();
  const laneId = env.LANE_ID || env.AGENT_MESH_LANE_ID || "default";
  return `/var/lib/agent-mesh/lane/${laneId}/attachments-cache`;
}

/**
 * Heuristic: detect a SPEC § 15.2 attachments array embedded in arbitrary
 * message body shapes. Returns `null` if no recognizable attachments array.
 *
 * Accepted inputs:
 *   - parsed object with `.attachments: AttachmentMeta[]`
 *   - JSON string containing the same
 */
export function extractAttachmentsMeta(body: unknown): AttachmentMeta[] | null {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try { parsed = JSON.parse(body); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const att = (parsed as { attachments?: unknown }).attachments;
  if (!Array.isArray(att)) return null;
  const out: AttachmentMeta[] = [];
  for (const item of att) {
    if (item && typeof item === "object"
        && typeof (item as AttachmentMeta).id === "string"
        && typeof (item as AttachmentMeta).download_url === "string") {
      out.push(item as AttachmentMeta);
    }
  }
  return out.length > 0 ? out : null;
}

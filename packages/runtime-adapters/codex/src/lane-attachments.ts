/**
 * Lane attachment fetcher wiring for the Codex runtime adapter.
 *
 * This is a thin re-export + convenience layer around
 * `@agent-mesh/shared-attachments` so that message handlers in the Codex
 * runtime can resolve SPEC § 15.2 attachment metadata to local paths via
 * a single import:
 *
 *   import { ensureAttachmentsLocal } from "./lane-attachments";
 *
 * The actual cache lives at `LANE_ATTACHMENT_CACHE_DIR` (default
 * `/var/lib/agent-mesh/lane/<id>/attachments-cache`, SPEC § 15.4).
 *
 * This module deliberately does NOT intercept the existing mesh-message
 * flow — callers opt in by invoking `ensureAttachmentsLocal` when they
 * discover attachment metadata on a message body.
 */

import {
  fetchAttachment,
  extractAttachmentsMeta,
  resolveLaneAttachmentCacheDir,
  type AttachmentMeta,
  type FetchAttachmentOptions,
  type FetchAttachmentResult,
} from "@agent-mesh/shared-attachments";

export {
  fetchAttachment,
  extractAttachmentsMeta,
  resolveLaneAttachmentCacheDir,
  type AttachmentMeta,
  type FetchAttachmentOptions,
  type FetchAttachmentResult,
};

/**
 * Resolve every attachment on a message body to a local cached path.
 * Returns an array of `{meta, path, cached}` plus a parallel `errors` array
 * so the caller can surface partial failures (SPEC § 15.5).
 */
export async function ensureAttachmentsLocal(
  body: unknown,
  opts: FetchAttachmentOptions & { cacheDir?: string } = {},
): Promise<{
  resolved: Array<{ meta: AttachmentMeta; path: string; cached: boolean }>;
  errors: Array<{ meta: AttachmentMeta; error: Error }>;
}> {
  const metas = extractAttachmentsMeta(body);
  if (!metas) return { resolved: [], errors: [] };
  const cacheDir = opts.cacheDir ?? resolveLaneAttachmentCacheDir();
  const resolved: Array<{ meta: AttachmentMeta; path: string; cached: boolean }> = [];
  const errors: Array<{ meta: AttachmentMeta; error: Error }> = [];
  for (const meta of metas) {
    try {
      const r: FetchAttachmentResult = await fetchAttachment(meta, cacheDir, opts);
      resolved.push({ meta, path: r.path, cached: r.cached });
    } catch (err) {
      errors.push({ meta, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { resolved, errors };
}

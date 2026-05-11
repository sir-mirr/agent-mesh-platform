/**
 * Lane attachment fetcher wiring for the Discord channel driver.
 *
 * Thin re-export of `@agent-mesh/shared-attachments` so that hub-to-driver
 * message handlers can resolve SPEC § 15.2 attachment metadata to a local
 * cache file before forwarding to Discord (e.g. when the body carries
 * `attachments[]` produced by `POST /api/v1/upload`).
 *
 * Does NOT alter the existing Discord-side attachment download path
 * (`./attachments.ts::downloadDiscordAttachments`), which captures
 * inbound Discord attachments. The two flows are independent.
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
 * Resolve every attachment on a hub-message body to a local cached path,
 * returning local file paths suitable for `files: [...]` in the Discord
 * reply tool. See SPEC § 15.4 for cache semantics.
 */
export async function ensureAttachmentsLocal(
  body: unknown,
  opts: FetchAttachmentOptions & { cacheDir?: string } = {},
): Promise<{
  paths: string[];
  errors: Array<{ meta: AttachmentMeta; error: Error }>;
}> {
  const metas = extractAttachmentsMeta(body);
  if (!metas) return { paths: [], errors: [] };
  const cacheDir = opts.cacheDir ?? resolveLaneAttachmentCacheDir();
  const paths: string[] = [];
  const errors: Array<{ meta: AttachmentMeta; error: Error }> = [];
  for (const meta of metas) {
    try {
      const r: FetchAttachmentResult = await fetchAttachment(meta, cacheDir, opts);
      paths.push(r.path);
    } catch (err) {
      errors.push({ meta, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { paths, errors };
}

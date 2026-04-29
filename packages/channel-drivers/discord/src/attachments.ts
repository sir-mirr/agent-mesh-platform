import { mkdirSync, realpathSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import type { Attachment, Message } from "discord.js";

import type {
  DiscordDownloadedAttachment,
  DiscordLogFn,
  DiscordRejectedAttachment,
} from "./types";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CODEX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_CODEX_IMAGE_DIM = 8000;

export interface DownloadAttachmentsResult {
  downloaded: DiscordDownloadedAttachment[];
  rejected: DiscordRejectedAttachment[];
}

export function sanitizeFilename(name: string): string {
  const onlyBase = basename(name);
  const cleaned = onlyBase
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, "_");
  const trimmed = cleaned.slice(0, 180);
  return trimmed || "file";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatAttachmentSummary(attachment: Attachment): string {
  const name = attachment.name ?? `attachment-${attachment.id}`;
  const type = attachment.contentType ?? "unknown";
  const size = typeof attachment.size === "number" ? formatBytes(attachment.size) : "?";
  return `${name} (${type}, ${size})`;
}

export function assertSendableFile(
  filePath: string,
  protectedStateDir: string,
  allowedDirs: string[] = [],
): void {
  let realFile: string;
  let realStateDir: string;
  try {
    realFile = realpathSync(filePath);
    realStateDir = realpathSync(protectedStateDir);
  } catch {
    return;
  }
  for (const allowedDir of allowedDirs) {
    try {
      const realAllowedDir = realpathSync(allowedDir);
      if (realFile.startsWith(realAllowedDir + sep)) {
        return;
      }
    } catch {}
  }
  if (realFile.startsWith(realStateDir + sep)) {
    throw new Error(`refusing to send protected driver state: ${filePath}`);
  }
}

export async function downloadDiscordAttachments(
  message: Message,
  attachmentsDir: string,
  logger?: DiscordLogFn,
): Promise<DownloadAttachmentsResult> {
  if (message.attachments.size === 0) {
    return { downloaded: [], rejected: [] };
  }

  const downloaded: DiscordDownloadedAttachment[] = [];
  const rejected: DiscordRejectedAttachment[] = [];
  const targetDir = join(attachmentsDir, String(message.id));
  mkdirSync(targetDir, { recursive: true });

  for (const attachment of message.attachments.values()) {
    try {
      const safeName = sanitizeFilename(attachment.name ?? `attachment-${attachment.id}`);
      const localPath = join(targetDir, safeName);
      const contentType = attachment.contentType ?? "";
      const isImage = contentType.startsWith("image/");
      const size = typeof attachment.size === "number" ? attachment.size : null;
      const width = typeof attachment.width === "number" ? attachment.width : null;
      const height = typeof attachment.height === "number" ? attachment.height : null;

      if (isImage) {
        if (size !== null && size > MAX_CODEX_IMAGE_BYTES) {
          rejected.push({
            name: attachment.name ?? safeName,
            contentType: contentType || null,
            size,
            width,
            height,
            reason: "image_too_large_bytes",
          });
          continue;
        }
        if (
          (width !== null && width > MAX_CODEX_IMAGE_DIM) ||
          (height !== null && height > MAX_CODEX_IMAGE_DIM)
        ) {
          rejected.push({
            name: attachment.name ?? safeName,
            contentType: contentType || null,
            size,
            width,
            height,
            reason: "image_too_large_dim",
          });
          continue;
        }
      }

      const response = await fetch(attachment.url);
      if (!response.ok) {
        logger?.(
          `attachment download failed msg=${message.id} att=${attachment.id} status=${response.status}`,
        );
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (isImage && bytes.byteLength > MAX_CODEX_IMAGE_BYTES) {
        rejected.push({
          name: attachment.name ?? safeName,
          contentType: contentType || null,
          size: bytes.byteLength,
          width,
          height,
          reason: "image_too_large_bytes",
        });
        continue;
      }

      await writeFile(localPath, bytes);
      downloaded.push({
        name: attachment.name ?? safeName,
        localPath,
        contentType: attachment.contentType ?? null,
        size: size ?? bytes.byteLength,
      });
    } catch (error) {
      logger?.(`attachment download error msg=${message.id} att=${attachment.id}: ${error}`);
    }
  }

  return { downloaded, rejected };
}

export function validateOutboundFiles(filePaths: string[]): void {
  if (filePaths.length > 10) {
    throw new Error("Discord allows max 10 attachments per message");
  }
  for (const filePath of filePaths) {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`not a file: ${filePath}`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `file too large: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`,
      );
    }
  }
}

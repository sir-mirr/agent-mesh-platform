import { formatChannelEnvelope, type ChannelEnvelope } from "@agent-mesh/core";
import type { Message } from "discord.js";

import {
  formatAttachmentSummary,
  formatBytes,
  MAX_CODEX_IMAGE_BYTES,
  MAX_CODEX_IMAGE_DIM,
} from "./attachments";
import type {
  DiscordDownloadedAttachment,
  DiscordRejectedAttachment,
} from "./types";

export function buildDiscordEnvelope(
  message: Message,
  downloaded: DiscordDownloadedAttachment[],
  rejected: DiscordRejectedAttachment[] = [],
): ChannelEnvelope {
  const attachmentCount = message.attachments.size;
  const attachmentSummary =
    attachmentCount > 0
      ? [...message.attachments.values()].map(formatAttachmentSummary).join("; ")
      : undefined;

  let text = message.content || (attachmentCount > 0 ? "(attachment)" : "");

  if (downloaded.length > 0) {
    text = `${text}\n\n첨부 파일:\n${downloaded.map((item) => `- ${item.localPath}`).join("\n")}`;
  }

  if (rejected.length > 0) {
    const limitMb = (MAX_CODEX_IMAGE_BYTES / (1024 * 1024)).toFixed(0);
    const lines = rejected.map((item) => {
      const sizeStr = typeof item.size === "number" ? formatBytes(item.size) : "size?";
      const dimStr =
        item.width != null && item.height != null ? `${item.width}x${item.height}` : "dim?";
      const reasonLabel =
        item.reason === "image_too_large_bytes" ? "파일 크기 초과" : "해상도 초과";
      return `- ${item.name} (${sizeStr}, ${dimStr}) — ${reasonLabel}`;
    });
    text =
      `${text}\n\n[첨부 가드] Codex vision API 한계를 초과한 이미지가 있어 로드하지 않았습니다 ` +
      `(한계: ${limitMb} MB / ${MAX_CODEX_IMAGE_DIM}px per side):\n${lines.join("\n")}\n` +
      `사용자에게 이미지를 축소·재전송해달라고 정중히 안내해 주세요.`;
  }

  return {
    source: "discord",
    chatId: message.channelId,
    messageId: message.id,
    text,
    user: message.author.username ?? message.author.id,
    userId: message.author.id,
    ts: new Date(message.createdTimestamp).toISOString(),
    ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
    ...(attachmentCount > 0 ? { attachmentCount } : {}),
    ...(attachmentSummary ? { attachments: attachmentSummary } : {}),
  };
}

export function wrapDiscordMessageAsXml(
  message: Message,
  downloaded: DiscordDownloadedAttachment[],
  rejected: DiscordRejectedAttachment[] = [],
): string {
  return formatChannelEnvelope(buildDiscordEnvelope(message, downloaded, rejected));
}

import { randomUUID } from "node:crypto";

import {
  formatChannelEnvelope,
  parseChannelEnvelope,
  type ChannelSource,
  type ReplyRoute,
} from "@agent-mesh/core";

import type { MeshMessage } from "./mesh-types";

export interface CodexInputItem {
  type: "text";
  text: string;
}

export type PrimarySource = "agent-mesh" | "channel" | "self-reminder";

export interface SourceMeta {
  primarySource: PrimarySource;
  channelSource?: ChannelSource;
  channelMessageId?: string;
  enqueuedAt: string;
  steerAppends: number;
  readyRetryCount?: number;
  hasAttachments?: boolean;
  forceSeparateTurn?: boolean;
  isRotation?: boolean;
  rotationStage?: "r1-handoff-request" | "r3-hint-injection";
}

export interface TurnEnvelope {
  turnId: string;
  inputItems: CodexInputItem[];
  replyRoute: ReplyRoute;
  sourceMeta: SourceMeta;
  steerBuffer?: CodexInputItem[];
}

export const CHANNEL_MERGE_WINDOW_MS = 60_000;

export interface SameReplyRouteContext {
  activeEnqueuedAt?: string;
  now?: number;
}

function newTurnId(): string {
  return `turn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function wrapMeshMessageAsChannelText(message: MeshMessage): string {
  return formatChannelEnvelope({
    source: "agent-mesh",
    chatId: message.from,
    messageId: message.id,
    text: message.content,
    user: message.from,
    userId: message.from,
    ts: message.ts,
    ...(message.reply_to ? { replyTo: message.reply_to } : {}),
  });
}

export function fromMeshMessage(message: MeshMessage): TurnEnvelope {
  return {
    turnId: newTurnId(),
    inputItems: [{ type: "text", text: wrapMeshMessageAsChannelText(message) }],
    replyRoute: {
      kind: "mesh",
      toAgent: message.from,
      replyToMessageId: message.id,
    },
    sourceMeta: {
      primarySource: "agent-mesh",
      enqueuedAt: new Date().toISOString(),
      steerAppends: 0,
    },
  };
}

export function fromChannelPayload(opts: {
  source: ChannelSource;
  inputText: string;
  chatId: string;
  replyToMessageId?: string;
  authorId?: string;
}): TurnEnvelope {
  const parsedEnvelope = parseChannelEnvelope(opts.inputText);
  const channelMessageId = parsedEnvelope?.messageId;
  const hasAttachments = (parsedEnvelope?.attachmentCount ?? 0) > 0;

  return {
    turnId: newTurnId(),
    inputItems: [{ type: "text", text: opts.inputText }],
    replyRoute: {
      kind: "channel",
      source: opts.source,
      chatId: opts.chatId,
      ...(opts.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : {}),
      ...(opts.authorId ? { authorId: opts.authorId } : {}),
    },
    sourceMeta: {
      primarySource: "channel",
      channelSource: opts.source,
      enqueuedAt: new Date().toISOString(),
      steerAppends: 0,
      ...(channelMessageId ? { channelMessageId } : {}),
      ...(hasAttachments ? { hasAttachments: true, forceSeparateTurn: true } : {}),
    },
  };
}

export function fromSelfReminder(message: MeshMessage): TurnEnvelope {
  return {
    turnId: newTurnId(),
    inputItems: [{ type: "text", text: wrapMeshMessageAsChannelText(message) }],
    replyRoute: { kind: "none" },
    sourceMeta: {
      primarySource: "self-reminder",
      enqueuedAt: new Date().toISOString(),
      steerAppends: 0,
    },
  };
}

export function isDiscordChannelRoute(
  route: ReplyRoute,
): route is ReplyRoute & { kind: "channel"; source: "discord" } {
  return route.kind === "channel" && route.source === "discord";
}

export function sameReplyRoute(
  a: ReplyRoute,
  b: ReplyRoute,
  ctx?: SameReplyRouteContext,
): boolean {
  if (a.kind === "none" || b.kind === "none") return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "mesh" && b.kind === "mesh") {
    return a.toAgent === b.toAgent;
  }
  if (a.kind === "channel" && b.kind === "channel") {
    if (a.source !== b.source) return false;
    if (a.chatId !== b.chatId) return false;
    if (!a.authorId || !b.authorId) return false;
    if (a.authorId !== b.authorId) return false;
    const activeAt = ctx?.activeEnqueuedAt;
    if (!activeAt) return false;
    const activeMs = Date.parse(activeAt);
    if (!Number.isFinite(activeMs)) return false;
    const nowMs = ctx?.now ?? Date.now();
    return Math.abs(nowMs - activeMs) < CHANNEL_MERGE_WINDOW_MS;
  }
  return false;
}

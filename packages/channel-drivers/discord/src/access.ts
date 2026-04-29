import { existsSync, readFileSync } from "node:fs";

import type {
  DiscordAccessFile,
  DiscordChannelAccessTarget,
  DiscordChunkMode,
  DiscordGroupPolicy,
  DiscordMentionMatchOptions,
  DiscordReplyToMode,
} from "./types";

function normalizeGroupPolicy(value: unknown): DiscordGroupPolicy {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const allowSource = Array.isArray(raw.allowFrom)
    ? raw.allowFrom
    : Array.isArray(raw.allow)
      ? raw.allow
      : [];
  const allowFrom = allowSource.map(String);
  return {
    ...(allowFrom.length > 0 ? { allowFrom } : {}),
    ...(typeof raw.requireMention === "boolean"
      ? { requireMention: raw.requireMention }
      : {}),
  };
}

export class AccessStore {
  private data: DiscordAccessFile = {
    dmPolicy: "pairing",
    allowFrom: [],
    groups: {},
  };

  constructor(private readonly path: string) {}

  load(): void {
    if (!existsSync(this.path)) {
      this.data = {
        dmPolicy: "pairing",
        allowFrom: [],
        groups: {},
      };
      return;
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DiscordAccessFile>;
    const groups = Object.fromEntries(
      Object.entries(parsed.groups ?? {}).map(([channelId, value]) => [
        channelId,
        normalizeGroupPolicy(value),
      ]),
    );
    this.data = {
      dmPolicy: parsed.dmPolicy ?? "pairing",
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom.map(String) : [],
      groups,
      ...(Array.isArray(parsed.mentionPatterns)
        ? { mentionPatterns: parsed.mentionPatterns.map(String) }
        : {}),
      ...(typeof parsed.ackReaction === "string" ? { ackReaction: parsed.ackReaction } : {}),
      ...(parsed.replyToMode ? { replyToMode: parsed.replyToMode } : {}),
      ...(typeof parsed.textChunkLimit === "number"
        ? { textChunkLimit: parsed.textChunkLimit }
        : {}),
      ...(parsed.chunkMode ? { chunkMode: parsed.chunkMode } : {}),
      ...(parsed.pending ? { pending: parsed.pending } : {}),
    };
  }

  isDmAllowed(userId: string): boolean {
    switch (this.data.dmPolicy) {
      case "open":
        return true;
      case "blocked":
      case "disabled":
        return false;
      case "pairing":
      case "allowlist":
      default:
        return this.data.allowFrom.includes(userId);
    }
  }

  matchesMentionText(content: string, opts: DiscordMentionMatchOptions): boolean {
    if (opts.repliedToBot) return true;
    if (opts.botId && opts.userMentions?.includes(opts.botId)) return true;
    for (const pattern of this.data.mentionPatterns ?? []) {
      if (!pattern) continue;
      try {
        if (new RegExp(pattern, "i").test(content)) return true;
      } catch {
        if (content.toLowerCase().includes(pattern.toLowerCase())) return true;
      }
    }
    return false;
  }

  shouldForwardGuildMessage(
    channelId: string,
    content: string,
    opts: DiscordMentionMatchOptions,
  ): boolean {
    const group = this.data.groups[channelId];
    if (group?.allowFrom?.includes(opts.authorId ?? "")) return true;
    if (group?.requireMention === false) return true;
    return this.matchesMentionText(content, opts);
  }

  isChannelAllowed(target: DiscordChannelAccessTarget): boolean {
    if (target.isDm) {
      return target.recipientId ? this.isDmAllowed(target.recipientId) : false;
    }
    const groupKey = target.parentChannelId ?? target.channelId;
    return groupKey in this.data.groups;
  }

  get policy(): DiscordAccessFile["dmPolicy"] {
    return this.data.dmPolicy;
  }

  get ackReaction(): string | undefined {
    return this.data.ackReaction || undefined;
  }

  get replyToMode(): DiscordReplyToMode {
    return this.data.replyToMode ?? "first";
  }

  get chunkMode(): DiscordChunkMode {
    return this.data.chunkMode ?? "length";
  }

  get textChunkLimit(): number {
    const raw = this.data.textChunkLimit ?? 2000;
    return Math.max(1, Math.min(raw, 2000));
  }

  get mentionPatternsView(): readonly string[] {
    return this.data.mentionPatterns ?? [];
  }

  get allowListSize(): number {
    return this.data.allowFrom.length;
  }

  get groupsSize(): number {
    return Object.keys(this.data.groups).length;
  }
}

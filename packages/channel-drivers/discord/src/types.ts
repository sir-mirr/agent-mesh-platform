import type {
  ChannelEnvelope,
  DownloadAttachmentToolInput,
  EditMessageToolInput,
  FetchMessagesToolInput,
  ReactToolInput,
  ReplyToolInput,
} from "@agent-mesh/core";

export type DiscordDmPolicy =
  | "pairing"
  | "allowlist"
  | "disabled"
  | "open"
  | "blocked";

export type DiscordChunkMode = "length" | "newline";
export type DiscordReplyToMode = "off" | "first" | "all";

export interface DiscordGroupPolicy {
  allowFrom?: string[];
  requireMention?: boolean;
}

export interface DiscordCrossBotTestMode {
  enabled?: boolean;
  allowFrom?: string[];
  maxRepliesPerThread?: number;
}

export interface DiscordAccessFile {
  dmPolicy: DiscordDmPolicy;
  allowFrom: string[];
  groups: Record<string, DiscordGroupPolicy>;
  mentionPatterns?: string[];
  ackReaction?: string;
  replyToMode?: DiscordReplyToMode;
  textChunkLimit?: number;
  chunkMode?: DiscordChunkMode;
  crossBotTestMode?: DiscordCrossBotTestMode;
  pending?: Record<string, unknown> | unknown[];
}

export interface DiscordDriverConfig {
  driverIdentity: string;
  discordBotToken: string;
  accessJsonPath: string;
  attachmentsDir: string;
  ingressForwardUrl?: string;
  ingressForwardToken?: string;
  httpPort: number;
  httpToken: string | null;
  hubForward?: {
    hubUrl: string;
    hubIdentity: string;
    targetAgent: string;
  };
}

export interface DiscordChannelAccessTarget {
  channelId: string;
  isDm: boolean;
  recipientId?: string;
  parentChannelId?: string;
}

export interface DiscordMentionMatchOptions {
  botId?: string;
  userMentions?: string[];
  authorId?: string;
  authorIsBot?: boolean;
  repliedToBot?: boolean;
}

export interface DiscordDownloadedAttachment {
  name: string;
  localPath: string;
  contentType: string | null;
  size: number | null;
}

export interface DiscordRejectedAttachment {
  name: string;
  contentType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  reason: "image_too_large_bytes" | "image_too_large_dim";
}

export interface DiscordInboundPayload {
  source: "discord";
  envelope: ChannelEnvelope;
  rawEnvelope: string;
  replyRoute: {
    kind: "discord";
    channelId: string;
    replyToMessageId: string;
    authorId: string;
  };
  attachments: DiscordDownloadedAttachment[];
  rejectedAttachments: DiscordRejectedAttachment[];
}

export interface DiscordFetchedMessage {
  id: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  content: string;
  attachmentCount: number;
  attachmentSummary: string[];
  replyTo?: string;
}

export interface DiscordReplyRequest extends ReplyToolInput {}
export interface DiscordReactRequest extends ReactToolInput {}
export interface DiscordEditRequest extends EditMessageToolInput {}
export interface DiscordDownloadRequest extends DownloadAttachmentToolInput {}
export interface DiscordFetchRequest extends FetchMessagesToolInput {}

export interface DiscordTypingRequest {
  chat_id: string;
  action: "start" | "stop";
}

export interface DiscordReplyResult {
  messageIds: string[];
}

export interface DiscordEditResult {
  messageId: string;
}

export interface DiscordToolService {
  reply(input: DiscordReplyRequest): Promise<DiscordReplyResult>;
  react(input: DiscordReactRequest): Promise<void>;
  editMessage(input: DiscordEditRequest): Promise<DiscordEditResult>;
  downloadAttachments(input: DiscordDownloadRequest): Promise<DiscordDownloadedAttachment[]>;
  fetchMessages(input: DiscordFetchRequest): Promise<DiscordFetchedMessage[]>;
  sendTyping(input: DiscordTypingRequest): Promise<void>;
}

export interface RecentSentTracker {
  has(messageId: string): boolean;
  note(messageId: string): void;
}

export type DiscordLogFn = (...args: unknown[]) => void;

export const CORE_PACKAGE_NAME = "@agent-mesh/core";

export type ChannelSource = "agent-mesh" | "discord" | "telegram";

export interface ChannelEnvelope {
  source: ChannelSource;
  chatId: string;
  messageId: string;
  user?: string;
  userId?: string;
  ts?: string;
  replyTo?: string;
  attachmentCount?: number;
  attachments?: string;
  text: string;
}

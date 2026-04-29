export const CHANNEL_ACTION_NAMES = [
  "reply",
  "react",
  "edit_message",
  "download_attachment",
  "fetch_messages",
] as const;

export type ChannelActionName = (typeof CHANNEL_ACTION_NAMES)[number];

export interface ReplyToolInput {
  chat_id: string;
  text: string;
  reply_to?: string;
  files?: string[];
}

export interface ReactToolInput {
  chat_id: string;
  message_id: string;
  emoji: string;
}

export interface EditMessageToolInput {
  chat_id: string;
  message_id: string;
  text: string;
}

export interface DownloadAttachmentToolInput {
  chat_id: string;
  message_id: string;
}

export interface FetchMessagesToolInput {
  chat_id: string;
  limit?: number;
  before_message_id?: string;
}

export interface ToolContractDescriptor {
  name: ChannelActionName;
  description: string;
  required: readonly string[];
}

export const CHANNEL_TOOL_CONTRACTS: Record<ChannelActionName, ToolContractDescriptor> = {
  reply: {
    name: "reply",
    description: "Send a reply into the current channel fabric source.",
    required: ["chat_id", "text"],
  },
  react: {
    name: "react",
    description: "Apply an emoji or equivalent reaction to a source message.",
    required: ["chat_id", "message_id", "emoji"],
  },
  edit_message: {
    name: "edit_message",
    description: "Edit a previously-sent message when the source supports edits.",
    required: ["chat_id", "message_id", "text"],
  },
  download_attachment: {
    name: "download_attachment",
    description: "Fetch message attachments into the local runtime when supported.",
    required: ["chat_id", "message_id"],
  },
  fetch_messages: {
    name: "fetch_messages",
    description: "Read recent normalized history for a source chat, with live fallback if available.",
    required: ["chat_id"],
  },
};

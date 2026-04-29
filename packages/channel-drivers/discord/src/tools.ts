import { dirname } from "node:path";

import type { Client } from "discord.js";

import { AccessStore } from "./access";
import {
  assertSendableFile,
  downloadDiscordAttachments,
  validateOutboundFiles,
} from "./attachments";
import { fetchAllowedChannel } from "./channels";
import { chunkDiscordText } from "./chunk";
import type {
  DiscordDriverConfig,
  DiscordFetchedMessage,
  DiscordToolService,
  RecentSentTracker,
} from "./types";

export interface CreateDiscordToolServiceOptions {
  client: Client;
  access: AccessStore;
  config: DiscordDriverConfig;
  recentSent: RecentSentTracker;
}

export function createDiscordToolService(
  options: CreateDiscordToolServiceOptions,
): DiscordToolService {
  const stateDir = dirname(options.config.accessJsonPath);

  return {
    async reply(input) {
      const channel = await fetchAllowedChannel(options.client, options.access, input.chat_id);
      const filePaths = input.files ?? [];
      for (const filePath of filePaths) {
        assertSendableFile(filePath, stateDir, [options.config.attachmentsDir]);
      }
      validateOutboundFiles(filePaths);
      const chunks = chunkDiscordText(
        input.text,
        options.access.textChunkLimit,
        options.access.chunkMode,
      );
      if (chunks.length === 0 && filePaths.length > 0) {
        chunks.push("");
      }

      const messageIds: string[] = [];
      const replyMode = options.access.replyToMode;
      for (let index = 0; index < chunks.length; index += 1) {
        const shouldReply =
          input.reply_to != null &&
          replyMode !== "off" &&
          (replyMode === "all" || index === 0);
        const sent = await channel.send?.({
          ...(chunks[index] ? { content: chunks[index] } : {}),
          ...(index === 0 && filePaths.length > 0 ? { files: filePaths } : {}),
          ...(shouldReply
            ? { reply: { messageReference: input.reply_to, failIfNotExists: false } }
            : {}),
        });
        if (!sent?.id) {
          throw new Error("discord send returned no message id");
        }
        options.recentSent.note(sent.id);
        messageIds.push(sent.id);
      }
      return { messageIds };
    },

    async react(input) {
      const channel = await fetchAllowedChannel(options.client, options.access, input.chat_id);
      const message = await channel.messages?.fetch(input.message_id);
      if (!message) throw new Error(`message ${input.message_id} not found`);
      await message.react(input.emoji);
    },

    async editMessage(input) {
      const channel = await fetchAllowedChannel(options.client, options.access, input.chat_id);
      const message = await channel.messages?.fetch(input.message_id);
      if (!message) throw new Error(`message ${input.message_id} not found`);
      const edited = await message.edit(input.text);
      return { messageId: edited.id };
    },

    async downloadAttachments(input) {
      const channel = await fetchAllowedChannel(options.client, options.access, input.chat_id);
      const message = await channel.messages?.fetch(input.message_id);
      if (!message) throw new Error(`message ${input.message_id} not found`);
      const result = await downloadDiscordAttachments(
        message,
        options.config.attachmentsDir,
      );
      return result.downloaded;
    },

    async fetchMessages(input) {
      const channel = await fetchAllowedChannel(options.client, options.access, input.chat_id);
      const limit = Math.min(input.limit ?? 20, 100);
      const messages = await channel.messages?.fetch({
        limit,
        ...(input.before_message_id ? { before: input.before_message_id } : {}),
      });
      const rows = [...(messages?.values() ?? [])].reverse();
      return rows.map<DiscordFetchedMessage>((message) => ({
        id: message.id,
        createdAt: message.createdAt.toISOString(),
        authorId: message.author.id,
        authorName:
          message.author.id === options.client.user?.id ? "me" : message.author.username,
        content: message.content.replace(/[\r\n]+/g, " ⏎ "),
        attachmentCount: message.attachments.size,
        attachmentSummary: [...message.attachments.values()].map((attachment) => {
          const name = attachment.name ?? `attachment-${attachment.id}`;
          return `${name}:${attachment.contentType ?? "unknown"}`;
        }),
        ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
      }));
    },

    async sendTyping(input) {
      if (input.action === "stop") return;
      const channel = await fetchAllowedChannel(options.client, options.access, input.chat_id);
      const anyChannel = channel as { sendTyping?: () => Promise<void> };
      if (typeof anyChannel.sendTyping !== "function") {
        throw new Error(`typing unsupported for channel ${input.chat_id}`);
      }
      await anyChannel.sendTyping();
    },
  };
}

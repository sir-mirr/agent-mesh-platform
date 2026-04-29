import type { Client } from "discord.js";

import { AccessStore } from "./access";

type TextChannelLike = {
  id: string;
  parentId?: string | null;
  recipientId?: string;
  isTextBased(): boolean;
  isDMBased?(): boolean;
  isThread?(): boolean;
  send?(options: unknown): Promise<{ id: string }>;
  messages?: {
    fetch(options: unknown): Promise<any>;
  };
};

export async function fetchTextBasedChannel(
  client: Client,
  channelId: string,
): Promise<TextChannelLike> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`channel ${channelId} not found or not text-based`);
  }
  return channel as unknown as TextChannelLike;
}

export async function fetchAllowedChannel(
  client: Client,
  access: AccessStore,
  channelId: string,
): Promise<TextChannelLike> {
  const channel = await fetchTextBasedChannel(client, channelId);
  const isDm = typeof channel.isDMBased === "function" ? channel.isDMBased() : false;
  const isThread = typeof channel.isThread === "function" ? channel.isThread() : false;
  const allowed = access.isChannelAllowed({
    channelId: channel.id,
    isDm,
    ...(channel.recipientId ? { recipientId: channel.recipientId } : {}),
    ...(isThread && channel.parentId ? { parentChannelId: channel.parentId } : {}),
  });
  if (!allowed) {
    throw new Error(`channel ${channelId} is not allowlisted`);
  }
  return channel;
}

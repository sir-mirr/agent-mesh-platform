export const CHANNEL_SOURCE_VALUES = ["agent-mesh", "discord", "telegram"] as const;

export type ChannelSource = (typeof CHANNEL_SOURCE_VALUES)[number];

export interface ChannelEnvelope {
  source: ChannelSource;
  chatId: string;
  messageId: string;
  text: string;
  user?: string;
  userId?: string;
  ts?: string;
  replyTo?: string;
  attachmentCount?: number;
  attachments?: string;
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeXmlAttr(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function formatChannelEnvelope(envelope: ChannelEnvelope): string {
  const attrs: Array<[string, string | number | undefined]> = [
    ["source", envelope.source],
    ["chat_id", envelope.chatId],
    ["message_id", envelope.messageId],
    ["user", envelope.user],
    ["user_id", envelope.userId],
    ["ts", envelope.ts],
    ["reply_to", envelope.replyTo],
    ["attachment_count", envelope.attachmentCount],
    ["attachments", envelope.attachments],
  ];
  const serializedAttrs = attrs
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${escapeXmlAttr(String(value))}"`)
    .join(" ");
  return `<channel ${serializedAttrs}>${envelope.text}</channel>`;
}

export function parseChannelEnvelope(input: string): ChannelEnvelope | null {
  const match = input.match(/^<channel\s+([^>]+)>([\s\S]*)<\/channel>$/);
  if (!match) return null;
  const rawAttrs = match[1];
  const text = match[2];
  if (rawAttrs === undefined || text === undefined) return null;
  const attrs: Record<string, string> = {};
  for (const attrMatch of rawAttrs.matchAll(/([a-z_]+)="([^"]*)"/g)) {
    const key = attrMatch[1];
    const value = attrMatch[2];
    if (key === undefined || value === undefined) continue;
    attrs[key] = decodeXmlAttr(value);
  }
  const source = attrs.source;
  if (!source || !CHANNEL_SOURCE_VALUES.includes(source as ChannelSource)) return null;
  const chatId = attrs.chat_id;
  const messageId = attrs.message_id;
  if (!chatId || !messageId) return null;
  const attachmentCount = attrs.attachment_count ? Number(attrs.attachment_count) : undefined;
  return {
    source: source as ChannelSource,
    chatId,
    messageId,
    text,
    ...(attrs.user ? { user: attrs.user } : {}),
    ...(attrs.user_id ? { userId: attrs.user_id } : {}),
    ...(attrs.ts ? { ts: attrs.ts } : {}),
    ...(attrs.reply_to ? { replyTo: attrs.reply_to } : {}),
    ...(attachmentCount !== undefined ? { attachmentCount } : {}),
    ...(attrs.attachments ? { attachments: attrs.attachments } : {}),
  };
}

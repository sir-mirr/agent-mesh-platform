import type { ChannelSource } from "./envelope";

export type ReplyRoute =
  | { kind: "mesh"; toAgent: string; replyToMessageId?: string }
  | {
      kind: "channel";
      source: ChannelSource;
      chatId: string;
      replyToMessageId?: string;
      authorId?: string;
    }
  | { kind: "none" };

export interface RouteAuditContext {
  turnId: string;
  primarySource: string;
  files?: string[];
}

export interface MeshDispatchRequest {
  toAgent: string;
  fromIdentity: string;
  text: string;
  replyToMessageId?: string | null;
}

export interface ChannelDispatchRequest {
  source: ChannelSource;
  chatId: string;
  text: string;
  replyToMessageId?: string;
  files?: string[];
}

export interface ChannelReactionRequest {
  source: ChannelSource;
  chatId: string;
  messageId: string;
  emoji: string;
}

export interface ChannelTypingRequest {
  source: ChannelSource;
  chatId: string;
  action: "start" | "stop";
}

export interface ActionProxy {
  sendMesh(request: MeshDispatchRequest): Promise<void>;
  sendChannel(request: ChannelDispatchRequest): Promise<void>;
  react(request: ChannelReactionRequest): Promise<void>;
  typing(request: ChannelTypingRequest): Promise<void>;
}

export function isChannelRoute(
  route: ReplyRoute,
): route is Extract<ReplyRoute, { kind: "channel" }> {
  return route.kind === "channel";
}

import type {
  ActionProxy,
  ChannelDispatchRequest,
  ChannelReactionRequest,
  ChannelSource,
  ChannelTypingRequest,
  MeshDispatchRequest,
} from "@agent-mesh/core";

import type { CodexAdapterChannelTarget } from "./config";
import type { HubClient } from "./hub-client";

export interface CreateHttpActionProxyOptions {
  hub: HubClient;
  channelTargets: Partial<Record<ChannelSource, CodexAdapterChannelTarget>>;
  logger?: (...args: unknown[]) => void;
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

async function postJson(
  target: CodexAdapterChannelTarget,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${normalizeBaseUrl(target.baseUrl)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `channel request failed path=${path} status=${response.status} detail=${detail.slice(0, 200)}`,
    );
  }
}

function resolveChannelTarget(
  source: ChannelSource,
  targets: Partial<Record<ChannelSource, CodexAdapterChannelTarget>>,
): CodexAdapterChannelTarget {
  const target = targets[source];
  if (!target) {
    throw new Error(`unsupported channel source: ${source}`);
  }
  return target;
}

async function sendChannel(
  target: CodexAdapterChannelTarget,
  request: ChannelDispatchRequest,
): Promise<void> {
  await postJson(target, "/send", {
    channelId: request.chatId,
    text: request.text,
    ...(request.replyToMessageId ? { replyToMsgId: request.replyToMessageId } : {}),
    ...(request.files?.length ? { files: request.files } : {}),
  });
}

async function reactToChannel(
  target: CodexAdapterChannelTarget,
  request: ChannelReactionRequest,
): Promise<void> {
  await postJson(target, "/react", {
    channelId: request.chatId,
    messageId: request.messageId,
    emoji: request.emoji,
  });
}

async function sendTypingToChannel(
  target: CodexAdapterChannelTarget,
  request: ChannelTypingRequest,
): Promise<void> {
  await postJson(target, "/typing", {
    channelId: request.chatId,
    action: request.action,
  });
}

export function createHttpActionProxy(options: CreateHttpActionProxyOptions): ActionProxy {
  return {
    async sendMesh(request: MeshDispatchRequest) {
      await options.hub.send({
        to: request.toAgent,
        from: request.fromIdentity,
        content: request.text,
        reply_to: request.replyToMessageId ?? null,
      });
    },

    async sendChannel(request: ChannelDispatchRequest) {
      const target = resolveChannelTarget(request.source, options.channelTargets);
      await sendChannel(target, request);
    },

    async react(request: ChannelReactionRequest) {
      const target = resolveChannelTarget(request.source, options.channelTargets);
      await reactToChannel(target, request);
    },

    async typing(request: ChannelTypingRequest) {
      const target = resolveChannelTarget(request.source, options.channelTargets);
      await sendTypingToChannel(target, request);
    },
  };
}

import {
  Client,
  GatewayIntentBits,
  Partials,
  type ClientEvents,
  type Message,
} from "discord.js";
import { mkdirSync } from "node:fs";

import { assertProxyRegistration, type OwnershipPolicy } from "@agent-mesh/core";

import { AccessStore } from "./access";
import { downloadDiscordAttachments } from "./attachments";
import { loadDiscordDriverConfig } from "./config";
import { startDiscordHubForwardBridge } from "./hub-forward";
import { startDiscordDriverHttpServer } from "./http";
import { RecentSentMessageTracker } from "./recent-sent";
import { createDiscordToolService } from "./tools";
import { buildDiscordEnvelope, wrapDiscordMessageAsXml } from "./envelope";
import type {
  DiscordDriverConfig,
  DiscordInboundPayload,
  DiscordLogFn,
  DiscordToolService,
} from "./types";

export interface StartDiscordDriverOptions {
  config?: DiscordDriverConfig;
  logger?: DiscordLogFn;
  onInbound?: (payload: DiscordInboundPayload) => Promise<void>;
  ownershipPolicy?: OwnershipPolicy;
  startHttpServer?: boolean;
}

export interface DiscordDriverRuntime {
  client: Client;
  access: AccessStore;
  tools: DiscordToolService;
  stop(): Promise<void>;
}

const CROSS_BOT_TEST_COUNTER_TTL_MS = 15 * 60 * 1000;

class CrossBotReplyLimiter {
  private readonly counters = new Map<string, { count: number; updatedAt: number }>();

  constructor(
    private readonly maxRepliesPerThread: number,
    private readonly ttlMs = CROSS_BOT_TEST_COUNTER_TTL_MS,
  ) {}

  reset(threadKey: string): void {
    this.counters.delete(threadKey);
  }

  noteBotReply(threadKey: string): { allowed: boolean; count: number; limit: number } {
    const now = Date.now();
    this.evictExpired(now);
    const current = this.counters.get(threadKey);
    const count = current?.count ?? 0;
    if (count >= this.maxRepliesPerThread) {
      this.counters.set(threadKey, {
        count,
        updatedAt: now,
      });
      return {
        allowed: false,
        count,
        limit: this.maxRepliesPerThread,
      };
    }
    const nextCount = count + 1;
    this.counters.set(threadKey, {
      count: nextCount,
      updatedAt: now,
    });
    return {
      allowed: true,
      count: nextCount,
      limit: this.maxRepliesPerThread,
    };
  }

  private evictExpired(now: number): void {
    for (const [threadKey, state] of this.counters.entries()) {
      if (now - state.updatedAt > this.ttlMs) {
        this.counters.delete(threadKey);
      }
    }
  }
}

async function isReplyToBotMessage(
  message: Message,
  botUserId: string | undefined,
  recentSent: RecentSentMessageTracker,
): Promise<boolean> {
  const referencedId = message.reference?.messageId;
  if (!referencedId) return false;
  if (recentSent.has(referencedId)) return true;
  try {
    const referenced = await message.fetchReference();
    return referenced.author.id === botUserId;
  } catch {
    return false;
  }
}

async function createDefaultForwarder(
  config: DiscordDriverConfig,
  payload: DiscordInboundPayload,
  logger: DiscordLogFn,
): Promise<void> {
  if (!config.ingressForwardUrl || !config.ingressForwardToken) {
    throw new Error("no onInbound handler and no forwarding URL/token configured");
  }
  const requestBody = JSON.stringify({
    source: payload.source,
    inputText: payload.rawEnvelope,
    envelope: payload.rawEnvelope,
    chatId: payload.replyRoute.channelId,
    replyToMessageId: payload.replyRoute.replyToMessageId,
    authorId: payload.replyRoute.authorId,
    replyRoute: {
      kind: payload.replyRoute.kind,
      channelId: payload.replyRoute.channelId,
      replyToMsgId: payload.replyRoute.replyToMessageId,
      authorId: payload.replyRoute.authorId,
    },
    attachments: payload.attachments,
    rejectedAttachments: payload.rejectedAttachments,
  });
  logger(
    `inbound forward route=ingress url=${config.ingressForwardUrl} ` +
      `author=${payload.replyRoute.authorId} chat=${payload.replyRoute.channelId} ` +
      `replyTo=${payload.replyRoute.replyToMessageId} bodyBytes=${requestBody.length}`,
  );
  let response: Response;
  try {
    response = await fetch(config.ingressForwardUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.ingressForwardToken}`,
      },
      body: requestBody,
    });
  } catch (error) {
    logger(
      `inbound forward route=ingress network-failed author=${payload.replyRoute.authorId} ` +
        `chat=${payload.replyRoute.channelId} err=${error}`,
    );
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logger(
      `inbound forward route=ingress rejected status=${response.status} ` +
        `author=${payload.replyRoute.authorId} chat=${payload.replyRoute.channelId} ` +
        `detail=${detail.slice(0, 200)}`,
    );
    throw new Error(`forward failed status=${response.status} detail=${detail.slice(0, 200)}`);
  }
  logger(
    `inbound forward route=ingress accepted status=${response.status} ` +
      `author=${payload.replyRoute.authorId} chat=${payload.replyRoute.channelId}`,
  );
}

async function handleInboundDiscordMessage(
  message: Message,
  client: Client,
  access: AccessStore,
  config: DiscordDriverConfig,
  logger: DiscordLogFn,
  recentSent: RecentSentMessageTracker,
  crossBotReplyLimiter: CrossBotReplyLimiter | null,
  forward: (payload: DiscordInboundPayload) => Promise<void>,
): Promise<void> {
  if (client.user && message.author.id === client.user.id) {
    logger(
      `inbound drop reason=self-author id=${message.id} channel=${message.channelId} author=${message.author.id}`,
    );
    return;
  }
  logger(
    `inbound received id=${message.id} channel=${message.channelId} guild=${message.guildId ?? "dm"} ` +
      `author=${message.author.id} bot=${message.author.bot} contentBytes=${message.content.length} ` +
      `attachments=${message.attachments.size}`,
  );
  // NOTE: legacy gateway dropped all other bots to prevent loops, but cross-bot
  // test scenarios (e.g., 4-bot lab in single channel) require bot-authored
  // messages to be delivered through normal access.json gates. Loop protection
  // moves to access.json allowFrom or bot-specific role policy.
  // (was: if (message.author.bot) return;)

  const isDm = message.guildId == null;
  if (isDm) {
    const dmAllowed = access.isDmAllowed(message.author.id);
    logger(
      `inbound dm-decision id=${message.id} author=${message.author.id} allowed=${dmAllowed}`,
    );
    if (!dmAllowed) return;
  } else {
    const repliedToBot = await isReplyToBotMessage(message, client.user?.id, recentSent);
    const groupKey =
      typeof (message.channel as { isThread?: () => boolean }).isThread === "function" &&
      (message.channel as { isThread: () => boolean }).isThread()
        ? ((message.channel as { parentId?: string | null }).parentId ?? message.channelId)
        : message.channelId;
    const mentionOpts = {
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      repliedToBot,
      ...(client.user?.id ? { botId: client.user.id } : {}),
      userMentions: [...message.mentions.users.keys()],
    };
    const decision = access.explainGuildForwardDecision(groupKey, message.content ?? "", mentionOpts);
    logger(
      `inbound guild-decision id=${message.id} group=${groupKey} matched=${decision.matched} ` +
        `groupExists=${decision.groupExists} allowFrom=${decision.authorAllowFrom} ` +
        `requireMention=${decision.requireMention} mentionMatched=${decision.mentionMatched} ` +
        `crossBotAllow=${decision.crossBotAllowFrom} repliedToBot=${repliedToBot} ` +
        `mentions=${message.mentions.users.size}`,
    );
    if (!decision.matched) return;
    if (crossBotReplyLimiter) {
      const threadKey = `${message.guildId ?? "dm"}:${message.channelId}`;
      if (message.author.bot) {
        const limiterState = crossBotReplyLimiter.noteBotReply(threadKey);
        if (!limiterState.allowed) {
          logger(
            `cross-bot test drop: channel=${message.channelId} author=${message.author.id} ` +
              `count=${limiterState.count} limit=${limiterState.limit}`,
          );
          return;
        }
      } else {
        crossBotReplyLimiter.reset(threadKey);
      }
    }
  }

  const typingChannel = message.channel as { sendTyping?: () => Promise<void> };
  if (typeof typingChannel.sendTyping === "function") {
    void typingChannel.sendTyping().catch(() => {});
  }
  if (access.ackReaction) {
    void message.react(access.ackReaction).catch(() => {});
  }

  const { downloaded, rejected } = await downloadDiscordAttachments(
    message,
    config.attachmentsDir,
    logger,
  );
  const envelope = buildDiscordEnvelope(message, downloaded, rejected);
  const payload: DiscordInboundPayload = {
    source: "discord",
    envelope,
    rawEnvelope: wrapDiscordMessageAsXml(message, downloaded, rejected),
    replyRoute: {
      kind: "discord",
      channelId: message.channelId,
      replyToMessageId: message.id,
      authorId: message.author.id,
    },
    attachments: downloaded,
    rejectedAttachments: rejected,
  };
  logger(
    `inbound payload-built id=${message.id} author=${message.author.id} bot=${message.author.bot} ` +
      `downloaded=${downloaded.length} rejected=${rejected.length}`,
  );
  await forward(payload);
  logger(`inbound forward-complete id=${message.id} author=${message.author.id}`);
}

export async function startDiscordDriver(
  options: StartDiscordDriverOptions = {},
): Promise<DiscordDriverRuntime> {
  const config = options.config ?? loadDiscordDriverConfig();
  const logger = options.logger ?? ((...args: unknown[]) => console.log("[discord-driver]", ...args));
  await assertProxyRegistration(
    options.ownershipPolicy,
    config.driverIdentity,
    config.driverIdentity,
  );

  mkdirSync(config.attachmentsDir, { recursive: true });
  const access = new AccessStore(config.accessJsonPath);
  access.load();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  const recentSent = new RecentSentMessageTracker();
  const tools = createDiscordToolService({
    client,
    access,
    config,
    recentSent,
  });
  const crossBotReplyLimiter = access.crossBotTestMode
    ? new CrossBotReplyLimiter(Math.max(1, access.crossBotTestMode.maxRepliesPerThread ?? 3))
    : null;
  const hubForward = options.onInbound || !config.hubForward
    ? null
    : await startDiscordHubForwardBridge({
        config: config as DiscordDriverConfig & {
          hubForward: NonNullable<DiscordDriverConfig["hubForward"]>;
        },
        tools,
        logger,
      });

  logger(
    `driver config identity=${config.driverIdentity} access=${config.accessJsonPath} ` +
      `forwardMode=${hubForward ? "hub-forward" : config.ingressForwardUrl ? "ingress" : "none"} ` +
      `ingressUrl=${config.ingressForwardUrl ?? "-"} ingressToken=${config.ingressForwardToken ? "set" : "unset"} ` +
      `hubForwardTarget=${config.hubForward?.targetAgent ?? "-"}`,
  );

  const forward =
    options.onInbound ??
    (async (payload: DiscordInboundPayload) => {
      if (hubForward) {
        logger(
          `inbound forward route=hub-forward author=${payload.replyRoute.authorId} ` +
            `chat=${payload.replyRoute.channelId} target=${config.hubForward?.targetAgent ?? "-"}`,
        );
        await hubForward.forwardInbound(payload);
        logger(
          `inbound forward route=hub-forward accepted author=${payload.replyRoute.authorId} ` +
            `chat=${payload.replyRoute.channelId}`,
        );
        return;
      }
      await createDefaultForwarder(config, payload, logger);
    });

  client.once("ready", () => {
    logger(`discord ready: ${client.user?.tag ?? "unknown"} id=${client.user?.id ?? "?"}`);
  });
  client.on("error", (error: ClientEvents["error"][0]) => logger(`discord error: ${error}`));
  client.on("warn", (warning: ClientEvents["warn"][0]) => logger(`discord warn: ${warning}`));
  client.on("messageCreate", async (message) => {
    try {
      await handleInboundDiscordMessage(
        message,
        client,
        access,
        config,
        logger,
        recentSent,
        crossBotReplyLimiter,
        forward,
      );
    } catch (error) {
      logger(`messageCreate handler failed: ${error}`);
    }
  });

  const httpServer = options.startHttpServer === false
    ? null
    : startDiscordDriverHttpServer({
        port: config.httpPort,
        token: config.httpToken,
        tools,
        logger,
      });

  await client.login(config.discordBotToken);

  return {
    client,
    access,
    tools,
    async stop() {
      httpServer?.stop();
      hubForward?.stop();
      client.destroy();
    },
  };
}

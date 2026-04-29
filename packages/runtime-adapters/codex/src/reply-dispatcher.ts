import {
  type ActionProxy,
  type ChannelSource,
  type ReplyRoute,
} from "@agent-mesh/core";

export interface ReplyDispatcherOptions {
  actionProxy: ActionProxy;
  fromIdentity: string;
}

export class ReplyDispatcher {
  constructor(private readonly opts: ReplyDispatcherOptions) {}

  async route(
    route: ReplyRoute,
    content: string,
    auditCtx: {
      turnId: string;
      primarySource: string;
      files?: string[];
    },
  ): Promise<void> {
    const hasFiles = Array.isArray(auditCtx.files) && auditCtx.files.length > 0;
    if (!content && !hasFiles) return;

    switch (route.kind) {
      case "none":
        return;
      case "mesh":
        await this.opts.actionProxy.sendMesh({
          toAgent: route.toAgent,
          fromIdentity: this.opts.fromIdentity,
          text: content,
          replyToMessageId: route.replyToMessageId ?? null,
        });
        return;
      case "channel":
        await this.opts.actionProxy.sendChannel({
          source: route.source,
          chatId: route.chatId,
          text: content,
          ...(route.replyToMessageId ? { replyToMessageId: route.replyToMessageId } : {}),
          ...(hasFiles ? { files: auditCtx.files } : {}),
        });
        return;
      default:
        return;
    }
  }

  async sendReaction(
    source: ChannelSource,
    chatId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    await this.opts.actionProxy.react({ source, chatId, messageId, emoji });
  }

  async sendTyping(
    source: ChannelSource,
    chatId: string,
    action: "start" | "stop",
  ): Promise<void> {
    await this.opts.actionProxy.typing({ source, chatId, action });
  }

  async sendMeshAdhoc(toAgent: string, text: string): Promise<void> {
    if (!text) return;
    await this.opts.actionProxy.sendMesh({
      toAgent,
      fromIdentity: this.opts.fromIdentity,
      text,
      replyToMessageId: null,
    });
  }

  async sendChannelAdhoc(
    source: ChannelSource,
    chatId: string,
    text: string,
  ): Promise<void> {
    if (!text) return;
    await this.opts.actionProxy.sendChannel({ source, chatId, text });
  }

  async routeError(
    route: ReplyRoute,
    errorText: string,
    auditCtx: { turnId: string; primarySource: string },
  ): Promise<void> {
    if (route.kind === "none") return;
    if (route.kind === "channel" && shouldSuppressChannelError(errorText)) {
      log(
        `suppressed channel error outbound turn=${auditCtx.turnId} source=${auditCtx.primarySource} err=${errorText}`,
      );
      return;
    }
    await this.route(route, `[runtime-codex error] ${errorText}`, auditCtx);
  }
}

function shouldSuppressChannelError(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes("[dispatch-prep]") ||
    normalized.includes("invalid request: invalid type: null") ||
    normalized.includes("expected a string") ||
    normalized.includes("admin reset: rotation") ||
    normalized.includes("codex disconnected mid-turn")
  );
}

function log(...args: unknown[]) {
  console.log("[runtime-codex] [router]", ...args);
}

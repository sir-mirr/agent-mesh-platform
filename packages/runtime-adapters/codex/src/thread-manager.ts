import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { ReplyRoute } from "@agent-mesh/core";

import type { CodexClient } from "./codex-client";
import type { MeshMessage } from "./mesh-types";
import type { TurnQueue } from "./queue";
import type { ReplyDispatcher } from "./reply-dispatcher";
import { RotationPolicy, buildR1Envelope, buildR3Envelope } from "./rotation-policy";
import type { CodexInputItem, TurnEnvelope } from "./turn-envelope";
import {
  fromMeshMessage,
  fromSelfReminder,
  isDiscordChannelRoute,
} from "./turn-envelope";

const SR_DB_PATH =
  process.env.SELF_REMINDER_DB ??
  "/home/ubuntu/ai/channels/agent-mesh/self-reminder.db";
const SENTINEL_RE = /\[\[SELF-REMINDER\]\]\s*([\s\S]*?)\s*\[\[\/SELF-REMINDER\]\]/g;
const DISCORD_REACT_RE = /\[\[DISCORD-REACT\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-REACT\]\]/g;
const DISCORD_TYPING_RE = /\[\[DISCORD-TYPING\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-TYPING\]\]/g;
const MESH_SEND_RE = /\[\[MESH-SEND\]\]\s*([\s\S]*?)\s*\[\[\/MESH-SEND\]\]/g;
const DISCORD_SEND_RE = /\[\[DISCORD-SEND\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-SEND\]\]/g;
const DISCORD_ATTACH_RE = /\[\[DISCORD-ATTACH\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-ATTACH\]\]/g;
const TYPING_KEEPALIVE_MS = 9000;
const ATTACHMENT_TURN_START_TIMEOUT_MS = parsePositiveInt(
  process.env.CODEX_ATTACHMENT_TURN_START_TIMEOUT_MS,
) ?? 90_000;

let _srDb: Database | null = null;

function srDb(): Database {
  if (!_srDb) _srDb = new Database(SR_DB_PATH);
  return _srDb;
}

function parseRelativeSchedule(spec: any): string | null {
  if (typeof spec?.in !== "string") return null;
  const match = spec.in.match(/^\+?(\d+)([smhd])$/);
  if (!match) return null;
  const units: Record<string, string> = {
    s: "seconds",
    m: "minutes",
    h: "hours",
    d: "days",
  };
  const unit = units[match[2]];
  if (!unit) return null;
  return `+${Number(match[1])} ${unit}`;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function requiredMatchGroup(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`missing regex capture group ${index}`);
  }
  return value;
}

class RetryableTurnDispatchError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "RetryableTurnDispatchError";
  }
}

function classifyRetryableCodexError(error: unknown): RetryableTurnDispatchError | null {
  const message = String((error as { message?: unknown })?.message ?? error);
  const normalized = message.toLowerCase();
  if (normalized.includes("codex rpc timeout: turn/start")) {
    return new RetryableTurnDispatchError(
      "turn-start-timeout",
      "[dispatch-prep] turn/start timed out; retrying after queue replay",
    );
  }
  if (normalized.includes("no rollout found")) {
    return new RetryableTurnDispatchError(
      "stale-thread-rollout",
      "[dispatch-prep] stale rollout state detected; retrying after queue replay",
    );
  }
  return null;
}

type State = "idle" | "running";

export interface ThreadManagerOptions {
  codex: CodexClient;
  router: ReplyDispatcher;
  fromIdentity: string;
  cwd: string;
  developerInstructions: string;
  initialThreadId?: string | null;
  initialTurnCount?: number | null;
  onThreadIdChange?: (threadId: string) => void;
  onTurnCountChange?: (turnCount: number) => void;
  rotation?: {
    enabled: boolean;
    turnThreshold: number;
    handoffDir: string;
  };
}

export class ThreadManager {
  private state: State = "idle";
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private activeEnvelope: TurnEnvelope | null = null;
  private turnCompletion:
    | { resolve: () => void; reject: (error: Error) => void }
    | null = null;
  private agentMessages = new Map<string, Map<string, string>>();
  private lastUnauthorizedAlertAt = 0;
  private streamBuffers = new Map<string, string>();
  private typingKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private typingChannelId: string | null = null;
  private pendingDiscordFiles: string[] = [];
  private pendingStreamSideEffects: Promise<void> = Promise.resolve();
  private queue: TurnQueue | null = null;
  private rotation: RotationPolicy;

  constructor(private readonly opts: ThreadManagerOptions) {
    if (opts.initialThreadId) this.threadId = opts.initialThreadId;
    this.rotation = new RotationPolicy({
      enabled: opts.rotation?.enabled ?? false,
      turnThreshold: opts.rotation?.turnThreshold ?? 25,
      handoffDir:
        opts.rotation?.handoffDir ?? "/home/ubuntu/ai/workspaces/kongming/handoffs",
      persistTurnCount: (turnCount) => this.opts.onTurnCountChange?.(turnCount),
    });
    if (opts.initialTurnCount !== undefined && opts.initialTurnCount !== null) {
      this.rotation.setInitialTurnCount(opts.initialTurnCount);
    }
  }

  attachQueue(queue: TurnQueue): void {
    this.queue = queue;
  }

  codexIsReady(): boolean {
    return this.opts.codex.isReady();
  }

  async ensureThread(): Promise<string> {
    const existingThreadId = this.threadId;
    if (existingThreadId) {
      try {
        await this.opts.codex.threadResume(existingThreadId);
        if (this.threadId === existingThreadId) {
          return existingThreadId;
        }
        if (typeof this.threadId === "string" && this.threadId) {
          return this.threadId;
        }
        throw new RetryableTurnDispatchError(
          "rotation-thread-resume-race",
          "[dispatch-prep] thread changed while resuming; retrying after queue replay",
        );
      } catch (error) {
        if (error instanceof RetryableTurnDispatchError) {
          throw error;
        }
        log(`thread/resume failed (${error}), starting new thread`);
        this.threadId = null;
      }
    }
    const result = await this.opts.codex.threadStart({
      developerInstructions: this.opts.developerInstructions,
      cwd: this.opts.cwd,
    });
    this.threadId = result.threadId;
    this.rotation.resetOnThreadChange();
    this.opts.onThreadIdChange?.(this.threadId);
    if (typeof this.threadId !== "string" || !this.threadId) {
      throw new RetryableTurnDispatchError(
        "missing-thread-id-after-start",
        "[dispatch-prep] thread/start returned no usable thread id",
      );
    }
    return this.threadId;
  }

  resetForReconnect(): void {
    if (this.turnCompletion) {
      this.turnCompletion.reject(new Error("codex disconnected mid-turn"));
      this.turnCompletion = null;
    }
    this.stopTypingKeepAlive("?", "reset-for-reconnect");
    this.streamBuffers.clear();
    this.pendingDiscordFiles = [];
    this.activeEnvelope = null;
    this.currentTurnId = null;
    this.agentMessages.clear();
    this.state = "idle";
    this.queue?.resumeDispatch("reset-for-reconnect");
    this.queue?.clearActive();
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  adminReset(reason: string): { oldThreadId: string | null; hadActive: boolean } {
    const oldThreadId = this.threadId;
    const hadActive = this.activeEnvelope !== null;
    if (this.activeEnvelope) {
      this.activeEnvelope = {
        ...this.activeEnvelope,
        replyRoute: { kind: "none" },
      };
    }
    if (this.turnCompletion) {
      this.turnCompletion.reject(new Error(`admin reset: ${reason}`));
      this.turnCompletion = null;
    }
    this.stopTypingKeepAlive(this.activeEnvelope?.turnId ?? "?", "admin-reset");
    this.streamBuffers.clear();
    this.pendingDiscordFiles = [];
    this.currentTurnId = null;
    this.agentMessages.clear();
    this.state = "idle";
    this.threadId = null;
    return { oldThreadId, hadActive };
  }

  async startFreshThread(): Promise<string> {
    const result = await this.opts.codex.threadStart({
      developerInstructions: this.opts.developerInstructions,
      cwd: this.opts.cwd,
    });
    this.threadId = result.threadId;
    this.rotation.resetOnThreadChange();
    this.opts.onThreadIdChange?.(this.threadId);
    return this.threadId;
  }

  isSelfReminder(message: MeshMessage): boolean {
    return (
      message.from === this.opts.fromIdentity &&
      message.to === this.opts.fromIdentity &&
      (message.content ?? "").startsWith("[SELF-REMINDER ")
    );
  }

  async onMeshMessage(message: MeshMessage): Promise<void> {
    if (!this.queue) {
      log(`queue not attached, dropping mesh.message id=${message.id}`);
      return;
    }
    const envelope = this.isSelfReminder(message)
      ? fromSelfReminder(message)
      : fromMeshMessage(message);
    await this.queue.enqueue(envelope);
  }

  async runEnvelope(env: TurnEnvelope): Promise<void> {
    if (!this.opts.codex.isReady()) {
      if (this.queue) {
        this.queue.requeueFront(env, "codex-not-ready");
      }
      return;
    }

    this.activeEnvelope = env;
    this.state = "running";

    try {
      const threadId = await this.ensureThread();
      if (typeof threadId !== "string" || !threadId) {
        throw new RetryableTurnDispatchError(
          "missing-thread-id-before-turn-start",
          "[dispatch-prep] thread id unavailable before turn/start",
        );
      }
      const codexInput = asCodexInput(env.inputItems);
      const turnStartTimeoutMs = env.sourceMeta.hasAttachments
        ? ATTACHMENT_TURN_START_TIMEOUT_MS
        : undefined;
      log(
        `turn/start dispatch turn=${env.turnId} thread=${threadId} ` +
          `items=${env.inputItems.length} attachments=${env.sourceMeta.hasAttachments ? "yes" : "no"} ` +
          `timeoutMs=${turnStartTimeoutMs ?? 30_000}`,
      );
      const completion = new Promise<void>((resolve, reject) => {
        this.turnCompletion = { resolve, reject };
      });

      const result = await this.opts.codex.turnStart({
        threadId,
        input: codexInput,
        cwd: this.opts.cwd,
        ...(turnStartTimeoutMs ? { timeoutMs: turnStartTimeoutMs } : {}),
      });
      const codexTurnId = (result as any)?.turn?.id ?? (result as any)?.turnId;
      if (codexTurnId) this.currentTurnId = codexTurnId;
      log(
        `turn/start ok turn=${env.turnId} codexTurnId=${this.currentTurnId ?? "-"} ` +
          `attachments=${env.sourceMeta.hasAttachments ? "yes" : "no"}`,
      );
      await completion;
    } catch (error: any) {
      const retryable = error instanceof RetryableTurnDispatchError
        ? error
        : classifyRetryableCodexError(error);
      if (retryable) {
        if (
          retryable.reason === "turn-start-timeout" ||
          retryable.reason === "stale-thread-rollout"
        ) {
          this.threadId = null;
          this.currentTurnId = null;
        }
        const outcome = this.queue?.requeueFront(env, retryable.reason) ?? "dropped";
        log(
          `retryable dispatch error turn=${env.turnId} reason=${retryable.reason} ` +
            `outcome=${outcome} err=${retryable.message}`,
        );
        return;
      }
      if (env.replyRoute.kind === "none") {
        log(
          `kind=none turn failure suppressed turn=${env.turnId} err=${String(error?.message ?? error)}`,
        );
      } else {
        try {
          await this.opts.router.routeError(env.replyRoute, String(error?.message ?? error), {
            turnId: env.turnId,
            primarySource: env.sourceMeta.primarySource,
          });
        } catch (routeError) {
          log(`routeError failed: ${routeError}`);
        }
      }
    } finally {
      this.stopTypingKeepAlive(env.turnId, "runEnvelope-finally");
      this.streamBuffers.clear();
      this.pendingDiscordFiles = [];
      this.pendingStreamSideEffects = Promise.resolve();
      this.state = "idle";
      this.currentTurnId = null;
      this.activeEnvelope = null;
      this.turnCompletion = null;
      this.queue?.clearActive();
    }
  }

  async steerActive(newItems: CodexInputItem[]): Promise<void> {
    if (!this.activeEnvelope) {
      throw new Error("steerActive called with no active envelope");
    }
    if (!this.threadId || !this.currentTurnId) {
      throw new Error("steerActive called before turn/started received");
    }
    await this.opts.codex.turnSteer({
      threadId: this.threadId,
      input: asCodexInput(newItems),
      expectedTurnId: this.currentTurnId,
    });
  }

  onCodexNotification(method: string, params: any): void {
    switch (method) {
      case "thread/started": {
        const newThreadId: string | undefined = params?.thread?.id ?? params?.threadId;
        if (newThreadId && newThreadId !== this.threadId) {
          this.threadId = newThreadId;
          this.rotation.resetOnThreadChange();
          this.opts.onThreadIdChange?.(this.threadId);
        }
        break;
      }
      case "turn/started": {
        const newTurnId: string | undefined = params?.turn?.id ?? params?.turnId;
        this.currentTurnId = newTurnId ?? null;
        break;
      }
      case "item/agentMessage/delta":
        this.handleAgentDelta(params);
        break;
      case "turn/completed":
        void this.handleTurnCompleted(params);
        break;
      case "turn/failed":
        this.stopTypingKeepAlive(this.activeEnvelope?.turnId ?? "?", "turn/failed");
        if (this.turnCompletion) {
          this.turnCompletion.reject(new Error(params?.error?.message ?? "turn/failed"));
          this.turnCompletion = null;
        }
        break;
      case "error":
        this.maybeAlertUnauthorized(params);
        break;
      default:
        break;
    }
  }

  private maybeAlertUnauthorized(params: any): void {
    const errInfo = params?.error?.codexErrorInfo;
    const errMsg = String(params?.error?.message ?? "");
    const isUnauthorized =
      errInfo === "unauthorized" ||
      /refresh token|access token|sign in again|unauthorized/i.test(errMsg);
    if (!isUnauthorized) return;
    const now = Date.now();
    if (now - this.lastUnauthorizedAlertAt < 5 * 60 * 1000) return;
    this.lastUnauthorizedAlertAt = now;
    const turnId = this.activeEnvelope?.turnId ?? "(no-turn)";
    const text =
      `🚨 [runtime-codex] Codex unauthorized 감지 — \`codex login\` 재실행이 필요할 수 있습니다.\n` +
      `error: ${errMsg || "(no message)"}\n` +
      `codexErrorInfo: ${errInfo ?? "(none)"}\n` +
      `turnId: ${turnId}`;
    void this.opts.router.sendMeshAdhoc("arumi", text).catch((error) => {
      log(`unauthorized alert send failed: ${error}`);
    });
  }

  private handleAgentDelta(params: any): void {
    const turnId: string | undefined = params?.turnId;
    const itemId: string | undefined = params?.itemId;
    const delta: string = params?.delta ?? "";
    if (!turnId || !itemId) return;
    let perTurn = this.agentMessages.get(turnId);
    if (!perTurn) {
      perTurn = new Map();
      this.agentMessages.set(turnId, perTurn);
    }
    perTurn.set(itemId, (perTurn.get(itemId) ?? "") + delta);

    const env = this.activeEnvelope;
    if (!env) return;
    const previous = this.streamBuffers.get(itemId) ?? "";
    const combined = previous + delta;
    this.streamBuffers.set(itemId, this.scanAndProcessStreamSentinels(combined, env));
  }

  private scanAndProcessStreamSentinels(text: string, env: TurnEnvelope): string {
    let out = text;

    for (;;) {
      const openIndex = out.indexOf("[[DISCORD-REACT]]");
      if (openIndex < 0) break;
      const closeToken = "[[/DISCORD-REACT]]";
      const closeIndex = out.indexOf(closeToken, openIndex + "[[DISCORD-REACT]]".length);
      if (closeIndex < 0) break;
      const inner = out
        .slice(openIndex + "[[DISCORD-REACT]]".length, closeIndex)
        .trim();
      const after = closeIndex + closeToken.length;
      if (isDiscordChannelRoute(env.replyRoute)) {
        try {
          const spec = JSON.parse(inner);
          const messageId: string | undefined = spec.message_id;
          const emoji: string | undefined = spec.emoji;
          const chatId =
            typeof spec.channel_id === "string" && spec.channel_id
              ? spec.channel_id
              : env.replyRoute.chatId;
          if (typeof messageId !== "string" || !messageId) {
            throw new Error("missing or invalid message_id");
          }
          if (typeof emoji !== "string" || !emoji) {
            throw new Error("missing or invalid emoji");
          }
          this.enqueueStreamSideEffect(() =>
            this.opts.router.sendReaction("discord", chatId, messageId, emoji),
          );
        } catch (error: any) {
          log(`stream discord-react parse/send failed: ${error?.message ?? error}`);
        }
      }
      out = out.slice(0, openIndex) + out.slice(after);
    }

    for (;;) {
      const openIndex = out.indexOf("[[DISCORD-TYPING]]");
      if (openIndex < 0) break;
      const closeToken = "[[/DISCORD-TYPING]]";
      const closeIndex = out.indexOf(closeToken, openIndex + "[[DISCORD-TYPING]]".length);
      if (closeIndex < 0) break;
      const inner = out
        .slice(openIndex + "[[DISCORD-TYPING]]".length, closeIndex)
        .trim();
      const after = closeIndex + closeToken.length;
      if (isDiscordChannelRoute(env.replyRoute)) {
        const action = inner.toLowerCase();
        if (action === "start") {
          this.ensureTypingKeepAlive(env.replyRoute.chatId);
        } else if (action === "stop") {
          this.stopTypingKeepAlive(env.turnId, "sentinel-stop");
        }
      }
      out = out.slice(0, openIndex) + out.slice(after);
    }

    for (;;) {
      const openIndex = out.indexOf("[[MESH-SEND]]");
      if (openIndex < 0) break;
      const closeToken = "[[/MESH-SEND]]";
      const closeIndex = out.indexOf(closeToken, openIndex + "[[MESH-SEND]]".length);
      if (closeIndex < 0) break;
      const inner = out.slice(openIndex + "[[MESH-SEND]]".length, closeIndex).trim();
      const after = closeIndex + closeToken.length;
      try {
        const spec = JSON.parse(inner);
        const to: string | undefined = spec.to;
        const text: string | undefined = spec.text;
        if (typeof to !== "string" || !to) throw new Error("missing or invalid 'to'");
        if (typeof text !== "string" || !text) throw new Error("missing or invalid 'text'");
        this.enqueueStreamSideEffect(() => this.opts.router.sendMeshAdhoc(to, text));
      } catch (error: any) {
        log(`stream MESH-SEND parse/send failed: ${error?.message ?? error}`);
      }
      out = out.slice(0, openIndex) + out.slice(after);
    }

    for (;;) {
      const openIndex = out.indexOf("[[DISCORD-SEND]]");
      if (openIndex < 0) break;
      const closeToken = "[[/DISCORD-SEND]]";
      const closeIndex = out.indexOf(closeToken, openIndex + "[[DISCORD-SEND]]".length);
      if (closeIndex < 0) break;
      const inner = out
        .slice(openIndex + "[[DISCORD-SEND]]".length, closeIndex)
        .trim();
      const after = closeIndex + closeToken.length;
      try {
        const spec = JSON.parse(inner);
        const chatId: string | undefined = spec.channelId;
        const text: string | undefined = spec.text;
        if (typeof chatId !== "string" || !chatId) {
          throw new Error("missing or invalid 'channelId'");
        }
        if (typeof text !== "string" || !text) {
          throw new Error("missing or invalid 'text'");
        }
        this.enqueueStreamSideEffect(() =>
          this.opts.router.sendChannelAdhoc("discord", chatId, text),
        );
      } catch (error: any) {
        log(`stream DISCORD-SEND parse/send failed: ${error?.message ?? error}`);
      }
      out = out.slice(0, openIndex) + out.slice(after);
    }

    out = this.processDiscordAttachStream(out, env);
    return out;
  }

  private enqueueStreamSideEffect(operation: () => Promise<void>): void {
    this.pendingStreamSideEffects = this.pendingStreamSideEffects
      .then(() => operation())
      .catch((error) => {
        log(`stream side-effect failed: ${error?.message ?? error}`);
      });
  }

  private processDiscordAttachStream(text: string, env: TurnEnvelope): string {
    let out = text;
    for (;;) {
      const openIndex = out.indexOf("[[DISCORD-ATTACH]]");
      if (openIndex < 0) break;
      const closeToken = "[[/DISCORD-ATTACH]]";
      const closeIndex = out.indexOf(closeToken, openIndex + "[[DISCORD-ATTACH]]".length);
      if (closeIndex < 0) break;
      const inner = out
        .slice(openIndex + "[[DISCORD-ATTACH]]".length, closeIndex)
        .trim();
      const after = closeIndex + closeToken.length;

      if (isDiscordChannelRoute(env.replyRoute)) {
        try {
          const spec = JSON.parse(inner);
          const files = spec?.files;
          if (!Array.isArray(files) || files.length === 0) {
            throw new Error("missing or empty 'files' array");
          }
          if (files.length > 10) {
            throw new Error(`too many files: ${files.length} (max 10)`);
          }
          const valid: string[] = [];
          for (const file of files) {
            if (typeof file !== "string" || !file) {
              throw new Error("file entry must be non-empty string");
            }
            if (!file.startsWith("/")) {
              throw new Error(`file path must be absolute: ${file}`);
            }
            valid.push(file);
          }
          const remaining = 10 - this.pendingDiscordFiles.length;
          if (remaining > 0) {
            this.pendingDiscordFiles.push(...valid.slice(0, remaining));
          }
        } catch (error: any) {
          log(`stream DISCORD-ATTACH parse failed: ${error?.message ?? error}`);
        }
      }
      out = out.slice(0, openIndex) + out.slice(after);
    }
    return out;
  }

  private ensureTypingKeepAlive(chatId: string): void {
    if (this.typingKeepAliveTimer && this.typingChannelId === chatId) {
      return;
    }
    if (this.typingKeepAliveTimer) {
      this.stopTypingKeepAlive(this.activeEnvelope?.turnId ?? "?", "channel-switch");
    }
    this.typingChannelId = chatId;
    void this.opts.router.sendTyping("discord", chatId, "start");
    this.typingKeepAliveTimer = setInterval(() => {
      if (!this.activeEnvelope) {
        this.stopTypingKeepAlive("?", "no-active-envelope");
        return;
      }
      void this.opts.router.sendTyping("discord", chatId, "start");
    }, TYPING_KEEPALIVE_MS);
  }

  private stopTypingKeepAlive(turnId: string, reason: string): void {
    if (!this.typingKeepAliveTimer) return;
    clearInterval(this.typingKeepAliveTimer);
    this.typingKeepAliveTimer = null;
    this.typingChannelId = null;
    log(`typing keep-alive stopped turn=${turnId} reason=${reason}`);
  }

  private async handleTurnCompleted(params: any): Promise<void> {
    const codexTurnId: string | undefined = params?.turn?.id ?? params?.turnId;
    this.stopTypingKeepAlive(this.activeEnvelope?.turnId ?? "?", "turn/completed");

    const perTurn = codexTurnId ? this.agentMessages.get(codexTurnId) : undefined;
    const env = this.activeEnvelope;
    let outgoing = "";
    if (perTurn) {
      const parts: string[] = [];
      for (const [itemId, original] of perTurn.entries()) {
        parts.push(this.streamBuffers.get(itemId) ?? original);
      }
      outgoing = parts.join("\n").trim();
    }
    if (codexTurnId) this.agentMessages.delete(codexTurnId);
    this.streamBuffers.clear();

    const isRotationEnv = !!env?.sourceMeta.isRotation;
    if (!isRotationEnv && outgoing) {
      this.processSelfReminderSentinels(outgoing);
      if (env) {
        outgoing = await this.processDiscordReactSentinels(outgoing, env);
        outgoing = this.stripDiscordTypingSentinels(outgoing, env);
        outgoing = await this.processMeshSendSentinels(outgoing, env);
        outgoing = await this.processDiscordSendSentinels(outgoing, env);
        outgoing = this.processDiscordAttachFinalSweep(outgoing, env);
      }
    }

    if (!isRotationEnv) {
      try {
        await this.pendingStreamSideEffects;
      } catch (error) {
        log(`pendingStreamSideEffects await failed: ${error}`);
      }
    }

    if (env && !isRotationEnv) {
      const filesForChannel =
        isDiscordChannelRoute(env.replyRoute) && this.pendingDiscordFiles.length > 0
          ? [...this.pendingDiscordFiles]
          : undefined;
      try {
        await this.opts.router.route(env.replyRoute, outgoing, {
          turnId: env.turnId,
          primarySource: env.sourceMeta.primarySource,
          ...(filesForChannel ? { files: filesForChannel } : {}),
        });
      } catch (error) {
        log(`router.route threw: ${error}`);
      }
    }

    const rotationStage = env?.sourceMeta.rotationStage;
    const turnIdForLog = env?.turnId ?? "?";
    const handoffBody = outgoing;

    if (isRotationEnv && rotationStage === "r1-handoff-request") {
      this.queue?.pauseDispatch("rotation-r1-completed");
    }

    if (this.turnCompletion) {
      this.turnCompletion.resolve();
      this.turnCompletion = null;
    }

    if (isRotationEnv && rotationStage === "r1-handoff-request") {
      setImmediate(() => {
        void this.continueRotationAfterR1(handoffBody, turnIdForLog);
      });
    } else if (isRotationEnv && rotationStage === "r3-hint-injection") {
      this.rotation.markRotationEnd();
    } else if (env && !isRotationEnv) {
      this.rotation.incrementTurn();
      if (this.rotation.shouldTriggerRotation()) {
        this.rotation.markRotationStart();
        setImmediate(() => this.triggerR1());
      }
    }
  }

  private async continueRotationAfterR1(
    handoffBody: string,
    turnIdForLog: string,
  ): Promise<void> {
    const turnCountAtRotation = this.rotation.getTurnCount();
    const oldThreadId = this.threadId;
    const saved = this.rotation.saveHandoff({
      oldThreadId,
      body: handoffBody,
      turnCountAtRotation,
    });

    try {
      this.adminReset(`rotation (turnCount=${turnCountAtRotation})`);
    } catch (error) {
      log(`rotation adminReset threw (ignored): ${error}`);
    }
    try {
      await this.startFreshThread();
    } catch (error) {
      log(`rotation startFreshThread failed: ${error}`);
      this.rotation.markRotationEnd();
      this.queue?.resumeDispatch("rotation-start-fresh-thread-failed");
      return;
    }

    const r3 = buildR3Envelope(saved ? { handoffPath: saved.path, handoffBody: saved.body } : {});
    if (!this.queue) {
      this.rotation.markRotationEnd();
      return;
    }
    try {
      this.queue.enqueueFront(r3);
      this.queue.resumeDispatch("rotation-r3-enqueued");
    } catch (error) {
      log(`rotation R3 enqueueFront threw (turn=${turnIdForLog}): ${error}`);
      this.rotation.markRotationEnd();
      this.queue.resumeDispatch("rotation-r3-enqueue-failed");
    }
  }

  private triggerR1(): void {
    if (!this.queue) {
      this.rotation.markRotationEnd();
      return;
    }
    try {
      this.queue.enqueueFront(buildR1Envelope());
    } catch (error) {
      log(`rotation R1 enqueueFront threw: ${error}`);
      this.rotation.markRotationEnd();
    }
  }

  private processSelfReminderSentinels(text: string): void {
    const matches = [...text.matchAll(SENTINEL_RE)];
    if (matches.length === 0) return;
    const agentId = this.opts.fromIdentity;
    for (const match of matches) {
      try {
        const spec = JSON.parse(requiredMatchGroup(match, 1).trim());
        const type: string = spec.type ?? "once";
        if (type !== "once" && type !== "cron") {
          throw new Error(`unsupported type for sentinel: ${type}`);
        }
        const schedule = spec.schedule ?? {};
        const payload: string = spec.payload ?? "";
        const taskId: string | undefined =
          typeof spec.task_id === "string" ? spec.task_id : undefined;

        let context: string | null;
        if (spec.context === undefined || spec.context === null) {
          context = taskId ? JSON.stringify({ task_id: taskId }) : null;
        } else if (taskId === undefined) {
          context =
            typeof spec.context === "string"
              ? spec.context
              : JSON.stringify(spec.context);
        } else if (typeof spec.context === "string") {
          try {
            const parsed = JSON.parse(spec.context);
            context =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? JSON.stringify({ task_id: taskId, ...parsed })
                : JSON.stringify({ task_id: taskId, context: spec.context });
          } catch {
            context = JSON.stringify({ task_id: taskId, context: spec.context });
          }
        } else if (typeof spec.context === "object" && !Array.isArray(spec.context)) {
          context = JSON.stringify({ task_id: taskId, ...spec.context });
        } else {
          context = JSON.stringify({ task_id: taskId, context: spec.context });
        }

        const idempotencyKey: string | null = spec.idempotency_key ?? null;
        const reminderId = `rem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        let nextFireSql: string;
        let nextFireParam: string | null = null;
        if (type === "once") {
          const relative = parseRelativeSchedule(schedule);
          if (relative) {
            nextFireSql = `datetime('now', ?)`;
            nextFireParam = relative;
          } else if (typeof schedule.at === "string") {
            nextFireSql = `?`;
            nextFireParam = schedule.at.replace("T", " ").slice(0, 19);
          } else {
            throw new Error("once schedule needs in or at");
          }
        } else {
          if (typeof schedule.at !== "string") {
            throw new Error("cron sentinel needs initial schedule.at");
          }
          nextFireSql = `?`;
          nextFireParam = schedule.at.replace("T", " ").slice(0, 19);
        }

        const statement = srDb().prepare(
          `INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, idempotency_key, status, next_fire_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ${nextFireSql}, ?)`,
        );
        statement.run(
          reminderId,
          agentId,
          type,
          JSON.stringify(schedule),
          payload,
          context,
          idempotencyKey,
          nextFireParam,
          `runtime-codex:${agentId}`,
        );
      } catch (error: any) {
        log(`sentinel parse/insert failed: ${error?.message ?? error}`);
      }
    }
  }

  private async processDiscordReactSentinels(
    text: string,
    env: TurnEnvelope,
  ): Promise<string> {
    const matches = [...text.matchAll(DISCORD_REACT_RE)];
    if (matches.length === 0) return text;

    if (!isDiscordChannelRoute(env.replyRoute)) {
      return text.replace(DISCORD_REACT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
    }

    const defaultChatId = env.replyRoute.chatId;
    for (const match of matches) {
      try {
        const spec = JSON.parse(requiredMatchGroup(match, 1).trim());
        const messageId: string | undefined = spec.message_id;
        const emoji: string | undefined = spec.emoji;
        const chatId: string =
          typeof spec.channel_id === "string" && spec.channel_id
            ? spec.channel_id
            : defaultChatId;
        if (typeof messageId !== "string" || !messageId) {
          throw new Error("missing or invalid message_id");
        }
        if (typeof emoji !== "string" || !emoji) {
          throw new Error("missing or invalid emoji");
        }
        await this.opts.router.sendReaction("discord", chatId, messageId, emoji);
      } catch (error: any) {
        log(`discord-react sentinel parse/send failed: ${error?.message ?? error}`);
      }
    }
    return text.replace(DISCORD_REACT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  private async processMeshSendSentinels(
    text: string,
    _env: TurnEnvelope,
  ): Promise<string> {
    const matches = [...text.matchAll(MESH_SEND_RE)];
    if (matches.length === 0) return text;
    for (const match of matches) {
      try {
        const spec = JSON.parse(requiredMatchGroup(match, 1).trim());
        const to: string | undefined = spec.to;
        const body: string | undefined = spec.text;
        if (typeof to !== "string" || !to) throw new Error("missing or invalid 'to'");
        if (typeof body !== "string" || !body) throw new Error("missing or invalid 'text'");
        await this.opts.router.sendMeshAdhoc(to, body);
      } catch (error: any) {
        log(`final-sweep MESH-SEND parse/send failed: ${error?.message ?? error}`);
      }
    }
    return text.replace(MESH_SEND_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  private async processDiscordSendSentinels(
    text: string,
    _env: TurnEnvelope,
  ): Promise<string> {
    const matches = [...text.matchAll(DISCORD_SEND_RE)];
    if (matches.length === 0) return text;
    for (const match of matches) {
      try {
        const spec = JSON.parse(requiredMatchGroup(match, 1).trim());
        const chatId: string | undefined = spec.channelId;
        const body: string | undefined = spec.text;
        if (typeof chatId !== "string" || !chatId) {
          throw new Error("missing or invalid 'channelId'");
        }
        if (typeof body !== "string" || !body) {
          throw new Error("missing or invalid 'text'");
        }
        await this.opts.router.sendChannelAdhoc("discord", chatId, body);
      } catch (error: any) {
        log(`final-sweep DISCORD-SEND parse/send failed: ${error?.message ?? error}`);
      }
    }
    return text.replace(DISCORD_SEND_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  private processDiscordAttachFinalSweep(text: string, env: TurnEnvelope): string {
    if (!DISCORD_ATTACH_RE.test(text)) return text;
    const fresh = /\[\[DISCORD-ATTACH\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-ATTACH\]\]/g;
    const matches = [...text.matchAll(fresh)];
    for (const match of matches) {
      if (!isDiscordChannelRoute(env.replyRoute)) continue;
      try {
        const spec = JSON.parse(requiredMatchGroup(match, 1).trim());
        const files = spec?.files;
        if (!Array.isArray(files) || files.length === 0) {
          throw new Error("missing or empty 'files' array");
        }
        if (files.length > 10) {
          throw new Error(`too many files: ${files.length} (max 10)`);
        }
        const valid: string[] = [];
        for (const file of files) {
          if (typeof file !== "string" || !file) {
            throw new Error("file entry must be non-empty string");
          }
          if (!file.startsWith("/")) {
            throw new Error(`file path must be absolute: ${file}`);
          }
          valid.push(file);
        }
        const remaining = 10 - this.pendingDiscordFiles.length;
        if (remaining > 0) {
          this.pendingDiscordFiles.push(...valid.slice(0, remaining));
        }
      } catch (error: any) {
        log(`final-sweep DISCORD-ATTACH parse failed: ${error?.message ?? error}`);
      }
    }
    const strip = /\[\[DISCORD-ATTACH\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-ATTACH\]\]/g;
    return text.replace(strip, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  private stripDiscordTypingSentinels(text: string, _env: TurnEnvelope): string {
    if (!DISCORD_TYPING_RE.test(text)) return text;
    const fresh = /\[\[DISCORD-TYPING\]\]\s*([\s\S]*?)\s*\[\[\/DISCORD-TYPING\]\]/g;
    return text.replace(fresh, "").replace(/\n{3,}/g, "\n\n").trim();
  }
}

function asCodexInput(
  items: CodexInputItem[],
): Array<{ type: "text"; text: string; text_elements: unknown[] }> {
  return items.map((item, index) => {
    if (!item || item.type !== "text") {
      throw new RetryableTurnDispatchError(
        "invalid-input-item-type",
        `[dispatch-prep] invalid input item at index ${index}`,
      );
    }
    if (typeof item.text !== "string") {
      throw new RetryableTurnDispatchError(
        "invalid-input-item-text",
        `[dispatch-prep] input item ${index} text must be string`,
      );
    }
    return {
      type: "text",
      text: item.text,
      text_elements: [],
    };
  });
}

function log(...args: unknown[]) {
  console.log("[runtime-codex] [thread]", ...args);
}

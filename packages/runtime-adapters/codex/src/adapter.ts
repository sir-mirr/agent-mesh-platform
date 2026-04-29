import {
  type ActionProxy,
  type ChannelSource,
} from "@agent-mesh/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CodexClient } from "./codex-client";
import { loadCodexAdapterConfig, type CodexAdapterConfig } from "./config";
import { HubClient } from "./hub-client";
import type { MeshMessage } from "./mesh-types";
import { TurnQueue } from "./queue";
import { ReplyDispatcher } from "./reply-dispatcher";
import { ThreadManager } from "./thread-manager";
import { fromChannelPayload, type TurnEnvelope } from "./turn-envelope";

const OPT_OUT_NOTIFICATIONS = [
  "item/reasoning/textDelta",
  "item/reasoning/summaryDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/created",
  "item/fileChange/modified",
  "item/fileChange/deleted",
  "turn/diff/updated",
  "turn/plan/updated",
];

interface PersistState {
  threadId?: string;
  turnCount?: number;
}

function loadState(path: string): PersistState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PersistState;
    return typeof raw === "object" && raw ? raw : {};
  } catch {
    return {};
  }
}

function saveState(path: string, state: PersistState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

export interface CodexRuntimeAdapterOptions {
  actionProxy: ActionProxy;
  config?: CodexAdapterConfig;
}

export class CodexRuntimeAdapter {
  readonly config: CodexAdapterConfig;
  readonly codex: CodexClient;
  readonly hub: HubClient;
  readonly dispatcher: ReplyDispatcher;
  readonly manager: ThreadManager;
  readonly queue: TurnQueue;

  private readonly runtimeState: PersistState;

  constructor(options: CodexRuntimeAdapterOptions) {
    this.config = options.config ?? loadCodexAdapterConfig();
    const persisted = loadState(this.config.statePath);
    this.runtimeState = {
      turnCount: persisted.turnCount ?? 0,
      ...(persisted.threadId ? { threadId: persisted.threadId } : {}),
    };

    this.dispatcher = new ReplyDispatcher({
      actionProxy: options.actionProxy,
      fromIdentity: this.config.targetAgent,
    });

    this.codex = new CodexClient({
      url: this.config.codexUrl,
      authToken: this.config.codexAuthToken,
      optOutNotificationMethods: OPT_OUT_NOTIFICATIONS,
      clientInfo: {
        name: "agent-mesh-runtime-codex",
        title: "Agent Mesh Codex Runtime Adapter",
        version: "0.1.0",
      },
      onNotification: (method, params) => this.manager.onCodexNotification(method, params),
      onReady: () => {
        this.manager.ensureThread().catch((error) => {
          console.log("[runtime-codex] ensureThread failed:", error);
        });
        this.queue.wake();
      },
      onDisconnect: () => this.manager.resetForReconnect(),
    });

    this.manager = new ThreadManager({
      codex: this.codex,
      router: this.dispatcher,
      fromIdentity: this.config.targetAgent,
      cwd: this.config.codexCwd,
      developerInstructions: this.config.instructionsText,
      initialThreadId: persisted.threadId ?? null,
      initialTurnCount: persisted.turnCount ?? 0,
      onThreadIdChange: (threadId) => {
        this.runtimeState.threadId = threadId;
        saveState(this.config.statePath, this.runtimeState);
      },
      onTurnCountChange: (turnCount) => {
        this.runtimeState.turnCount = turnCount;
        saveState(this.config.statePath, this.runtimeState);
      },
      rotation: {
        enabled: this.config.rotationEnabled,
        turnThreshold: this.config.rotationTurnThreshold,
        handoffDir: this.config.handoffDir,
      },
    });

    this.queue = new TurnQueue({ manager: this.manager });
    this.manager.attachQueue(this.queue);

    this.hub = new HubClient({
      url: this.config.hubUrl,
      identity: this.config.adapterIdentity,
      description: `Codex runtime adapter for ${this.config.targetAgent}`,
      proxyFor: this.config.proxyFor,
      onMessage: (message) => {
        if (message.to !== this.config.targetAgent) return;
        void this.manager.onMeshMessage(message);
      },
    });
  }

  start(): void {
    this.codex.start();
    this.hub.start();
    this.queue.start();
  }

  stop(): void {
    this.queue.stop();
    this.hub.stop();
    this.codex.stop();
  }

  async onMeshMessage(message: MeshMessage): Promise<void> {
    await this.manager.onMeshMessage(message);
  }

  async enqueueEnvelope(envelope: TurnEnvelope): Promise<void> {
    await this.queue.enqueue(envelope);
  }

  async enqueueChannelPayload(opts: {
    source: ChannelSource;
    inputText: string;
    chatId: string;
    replyToMessageId?: string;
    authorId?: string;
  }): Promise<void> {
    await this.queue.enqueue(
      fromChannelPayload({
        source: opts.source,
        inputText: opts.inputText,
        chatId: opts.chatId,
        ...(opts.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : {}),
        ...(opts.authorId ? { authorId: opts.authorId } : {}),
      }),
    );
  }
}

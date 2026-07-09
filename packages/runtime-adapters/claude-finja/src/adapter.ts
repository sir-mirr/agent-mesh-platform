import type { ClaudeAdapterConfig } from "./config";
import { HubClient } from "./hub-client";
import type { MeshMessage } from "./mesh-types";

export interface ClaudeRuntimeAdapterOptions {
  config: ClaudeAdapterConfig;
}

/**
 * Claude runtime adapter (skeleton).
 *
 * Unlike the Codex lane (which embeds the LLM client in-process via
 * `CodexClient`), the Claude lane talks to an *external* Claude Code MCP
 * server. The adapter's responsibility is therefore narrower:
 *
 *   1. Stay connected to the hub as `LANE_IDENTITY` (heartbeat + reconnect).
 *   2. Receive `mesh.message` envelopes addressed to this lane.
 *   3. Forward them to the external Claude Code MCP at `CLAUDE_MCP_ENDPOINT`
 *      using the `HUB_FORWARD_IDENTITY` pattern so replies are correctly
 *      attributed when Claude Code sends back via the hub.
 *
 * Step (3) is intentionally a TODO stub for v0.1 — the real MCP wiring lands
 * in v0.2 once the external Claude Code MCP integration contract is locked
 * in. The current implementation logs inbound traffic and acknowledges hub
 * connectivity so end-to-end lane plumbing (systemd, ENV, register) can be
 * validated independently of the MCP transport.
 */
export class ClaudeRuntimeAdapter {
  readonly config: ClaudeAdapterConfig;
  private readonly hub: HubClient;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(opts: ClaudeRuntimeAdapterOptions) {
    this.config = opts.config;
    this.hub = new HubClient({
      url: this.config.hubUrl,
      identity: this.config.laneIdentity,
      description: this.config.description,
      proxyFor: this.config.proxyFor,
      reconnectDelayMs: this.config.reconnectDelayMs,
      onMessage: (message) => this.handleMeshMessage(message),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    log(
      `start lane="${this.config.laneIdentity}" forward_identity="${this.config.hubForwardIdentity}" mcp="${this.config.claudeMcpEndpoint ?? "<unset>"}"`,
    );
    this.hub.start();
    this.heartbeatTimer = setInterval(() => {
      if (this.hub.isConnected()) {
        log("heartbeat ok");
      } else {
        log("heartbeat: hub disconnected, awaiting reconnect");
      }
    }, this.config.heartbeatIntervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.hub.stop();
    log("stopped");
  }

  private handleMeshMessage(message: MeshMessage): void {
    log(
      `inbound from=${message.from} to=${message.to} id=${message.id} reply_to=${message.reply_to ?? "<none>"}`,
    );
    // TODO(v0.2): wire to Claude Code MCP.
    //   - Open / reuse a session at this.config.claudeMcpEndpoint
    //   - Forward `message.content` (plus envelope metadata) as an MCP request
    //   - When Claude Code MCP produces a response, it forwards it back to
    //     the hub itself using HUB_FORWARD_IDENTITY (= this.config.hubForwardIdentity).
    //     The adapter therefore does NOT call hub.send() for replies in the
    //     baseline path — it only does so for adapter-level system messages
    //     (e.g. transport errors, lifecycle notices).
  }
}

function log(...args: unknown[]) {
  console.error("[runtime-claude-finja] [adapter]", ...args);
}

import { existsSync, readFileSync } from "node:fs";

import type { ChannelSource } from "@agent-mesh/core";

export interface CodexAdapterChannelTarget {
  baseUrl: string;
  token: string | null;
}

export interface CodexAdapterConfig {
  hubUrl: string;
  codexUrl: string;
  adapterIdentity: string;
  proxyFor: string[];
  targetAgent: string;
  /** Identity notified about auth failures and stuck turns. Null disables routing. */
  operatorIdentity: string | null;
  instructionsText: string;
  instructionsPath: string;
  statePath: string;
  codexAuthToken: string | null;
  codexCwd: string;
  rotationEnabled: boolean;
  rotationTurnThreshold: number;
  handoffDir: string;
  httpPort: number;
  httpToken: string | null;
  channelTargets: Partial<Record<ChannelSource, CodexAdapterChannelTarget>>;
}

function defaultInstructionsPath(): string {
  return new URL("./default-instructions.txt", import.meta.url).pathname;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    return fallback;
  }
  return value;
}

function normalizeOptionalString(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function loadCodexAdapterConfig(): CodexAdapterConfig {
  const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:3100/ws";
  const codexUrl = process.env.CODEX_URL ?? "ws://127.0.0.1:4500";
  const adapterIdentity =
    process.env.CODEX_ADAPTER_IDENTITY ??
    process.env.BRIDGE_IDENTITY ??
    "codex-adapter";
  const proxyFor = (
    process.env.CODEX_PROXY_FOR ??
    process.env.BRIDGE_PROXY_FOR ??
    ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // With no proxy configured the adapter speaks only as itself.
  const targetAgent =
    process.env.CODEX_TARGET_AGENT ??
    process.env.BRIDGE_TARGET_AGENT ??
    proxyFor[0] ??
    adapterIdentity;

  const instructionsPath =
    process.env.RUNTIME_INSTRUCTIONS_PATH ??
    process.env.CODEX_INSTRUCTIONS_PATH ??
    defaultInstructionsPath();
  let instructionsText = "";
  try {
    instructionsText = readFileSync(instructionsPath, "utf8").trim();
  } catch (error) {
    console.warn(`[runtime-codex] failed to load instructions from ${instructionsPath}:`, error);
  }

  // SPEC § 14.8 — per-lane mutable state lives under /var/lib/agent-mesh/lane/<lane-id>/.
  const statePath =
    process.env.CODEX_ADAPTER_STATE_PATH ??
    process.env.BRIDGE_STATE_PATH ??
    `/var/lib/agent-mesh/lane/${targetAgent}/codex-state.json`;

  const tokenFile = process.env.CODEX_TOKEN_FILE ?? null;
  let codexAuthToken: string | null = null;
  if (tokenFile && existsSync(tokenFile)) {
    try {
      codexAuthToken = readFileSync(tokenFile, "utf8").trim();
    } catch (error) {
      console.warn(`[runtime-codex] failed to read codex token file ${tokenFile}:`, error);
    }
  } else if (process.env.CODEX_AUTH_TOKEN) {
    codexAuthToken = process.env.CODEX_AUTH_TOKEN;
  }

  const discordDriverUrl =
    normalizeOptionalString(process.env.CHANNEL_DISCORD_URL) ??
    normalizeOptionalString(process.env.DISCORD_DRIVER_URL);
  const discordDriverToken =
    normalizeOptionalString(process.env.CHANNEL_DISCORD_TOKEN) ??
    normalizeOptionalString(process.env.DISCORD_DRIVER_TOKEN);

  return {
    hubUrl,
    codexUrl,
    adapterIdentity,
    proxyFor,
    targetAgent,
    operatorIdentity: normalizeOptionalString(process.env.RUNTIME_OPERATOR_IDENTITY),
    instructionsText,
    instructionsPath,
    statePath,
    codexAuthToken,
    codexCwd: process.env.CODEX_CWD ?? process.cwd(),
    rotationEnabled: parseBool(process.env.RUNTIME_ROTATION_ENABLED, true),
    rotationTurnThreshold:
      parsePositiveInt(process.env.RUNTIME_ROTATION_TURN_THRESHOLD) ?? 25,
    handoffDir:
      process.env.RUNTIME_HANDOFF_DIR ??
      `/var/lib/agent-mesh/lane/${targetAgent}/handoffs`,
    httpPort: parsePort(
      process.env.CODEX_ADAPTER_HTTP_PORT ?? process.env.BRIDGE_HTTP_PORT,
      4600,
    ),
    httpToken:
      normalizeOptionalString(process.env.CODEX_ADAPTER_HTTP_TOKEN) ??
      normalizeOptionalString(process.env.BRIDGE_HTTP_TOKEN),
    channelTargets: {
      ...(discordDriverUrl
        ? {
            discord: {
              baseUrl: discordDriverUrl,
              token: discordDriverToken,
            },
          }
        : {}),
    },
  };
}

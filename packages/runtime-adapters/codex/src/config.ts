import { existsSync, readFileSync } from "node:fs";

export interface CodexAdapterConfig {
  hubUrl: string;
  codexUrl: string;
  adapterIdentity: string;
  proxyFor: string[];
  targetAgent: string;
  instructionsText: string;
  instructionsPath: string;
  statePath: string;
  codexAuthToken: string | null;
  codexCwd: string;
  rotationEnabled: boolean;
  rotationTurnThreshold: number;
  handoffDir: string;
}

function defaultInstructionsPath(): string {
  return new URL("./kongming-instructions.txt", import.meta.url).pathname;
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

export function loadCodexAdapterConfig(): CodexAdapterConfig {
  const hubUrl = process.env.HUB_URL ?? "ws://arumhub:3100/ws";
  const codexUrl = process.env.CODEX_URL ?? "ws://127.0.0.1:4500";
  const adapterIdentity =
    process.env.CODEX_ADAPTER_IDENTITY ??
    process.env.BRIDGE_IDENTITY ??
    "codex-adapter";
  const proxyFor = (
    process.env.CODEX_PROXY_FOR ??
    process.env.BRIDGE_PROXY_FOR ??
    "kongming"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const targetAgent =
    process.env.CODEX_TARGET_AGENT ??
    process.env.BRIDGE_TARGET_AGENT ??
    proxyFor[0] ??
    "kongming";

  const instructionsPath =
    process.env.KONGMING_INSTRUCTIONS_PATH ??
    process.env.CODEX_INSTRUCTIONS_PATH ??
    defaultInstructionsPath();
  let instructionsText = "";
  try {
    instructionsText = readFileSync(instructionsPath, "utf8").trim();
  } catch (error) {
    console.warn(`[runtime-codex] failed to load instructions from ${instructionsPath}:`, error);
  }

  const statePath =
    process.env.CODEX_ADAPTER_STATE_PATH ??
    process.env.BRIDGE_STATE_PATH ??
    "/home/ubuntu/ai/channels/agent-mesh-codex-bridge/state.json";

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

  return {
    hubUrl,
    codexUrl,
    adapterIdentity,
    proxyFor,
    targetAgent,
    instructionsText,
    instructionsPath,
    statePath,
    codexAuthToken,
    codexCwd: process.env.CODEX_CWD ?? process.cwd(),
    rotationEnabled: parseBool(process.env.KONGMING_ROTATION_ENABLED, true),
    rotationTurnThreshold:
      parsePositiveInt(process.env.KONGMING_ROTATION_TURN_THRESHOLD) ?? 25,
    handoffDir:
      process.env.KONGMING_HANDOFF_DIR ??
      "/home/ubuntu/ai/workspaces/kongming/handoffs",
  };
}

export interface ClaudeAdapterConfig {
  hubUrl: string;
  laneIdentity: string;
  hubForwardIdentity: string;
  description: string | null;
  proxyFor: string[];
  reconnectDelayMs: number;
  heartbeatIntervalMs: number;
}

function normalizeOptionalString(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `[runtime-claude] missing required env: ${name}`,
    );
  }
  return value;
}

export function loadClaudeAdapterConfig(): ClaudeAdapterConfig {
  const hubUrl = requireEnv("HUB_URL");
  const laneIdentity = requireEnv("LANE_IDENTITY");
  // HUB_FORWARD_IDENTITY is retained for compatibility with the v0.1 adapter
  // config. The v0.2 MCP channel sends replies as LANE_IDENTITY by default.
  const hubForwardIdentity =
    normalizeOptionalString(process.env.HUB_FORWARD_IDENTITY) ?? laneIdentity;
  const description =
    normalizeOptionalString(process.env.LANE_DESCRIPTION) ??
    "Claude Code MCP channel server for Agent-Mesh";
  const proxyFor = (process.env.LANE_PROXY_FOR ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    hubUrl,
    laneIdentity,
    hubForwardIdentity,
    description,
    proxyFor,
    reconnectDelayMs: parsePositiveInt(
      process.env.HUB_RECONNECT_DELAY_MS,
      5_000,
    ),
    heartbeatIntervalMs: parsePositiveInt(
      process.env.HUB_HEARTBEAT_INTERVAL_MS,
      30_000,
    ),
  };
}

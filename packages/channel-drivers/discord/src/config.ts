import { join } from "node:path";

import type { DiscordDriverConfig } from "./types";

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  return fallback;
}

function sanitizeIdentity(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "discord-driver";
}

export function loadDiscordDriverConfig(): DiscordDriverConfig {
  const driverIdentity = sanitizeIdentity(
    (
      process.env.DISCORD_DRIVER_IDENTITY ??
      process.env.GATEWAY_AGENT_IDENTITY ??
      "discord-driver"
    ).trim(),
  );
  const platformHome = process.env.AGENT_MESH_PLATFORM_HOME ?? "/srv/agent-mesh-platform";
  const discordBotToken = (process.env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }
  const accessJsonPath =
    process.env.ACCESS_JSON_PATH ??
    join(platformHome, "discord", driverIdentity, "access.json");
  const attachmentsDir =
    process.env.ATTACHMENTS_DIR ??
    join(platformHome, "attachments", driverIdentity);

  const ingressForwardUrl = (
    process.env.CHANNEL_INGRESS_URL ??
    process.env.BRIDGE_URL ??
    ""
  ).trim();
  const ingressForwardToken = (
    process.env.CHANNEL_INGRESS_TOKEN ??
    process.env.BRIDGE_INGRESS_TOKEN ??
    ""
  ).trim();

  return {
    driverIdentity,
    discordBotToken,
    accessJsonPath,
    attachmentsDir,
    ...(ingressForwardUrl ? { ingressForwardUrl } : {}),
    ...(ingressForwardToken ? { ingressForwardToken } : {}),
    httpPort: parsePort(
      process.env.DISCORD_DRIVER_HTTP_PORT ?? process.env.GATEWAY_HTTP_PORT,
      4610,
    ),
    httpToken:
      (process.env.DISCORD_DRIVER_HTTP_TOKEN ?? process.env.GATEWAY_TOKEN ?? "").trim() ||
      null,
  };
}

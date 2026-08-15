#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadCodexAdapterConfig } from "./config";
import { HttpMeshToolsHub } from "./http-mesh-tools-proxy";
import {
  MESH_TOOL_DEFINITIONS,
  dispatchMeshTool,
  type MeshToolsHub,
} from "./mesh-tools";

function log(...args: unknown[]): void {
  console.error("[runtime-codex] [mesh-tools]", ...args);
}

export function createCodexMeshToolsServer(options: {
  hub: MeshToolsHub;
  laneIdentity: string;
}): Server {
  const mcp = new Server(
    { name: "agent-mesh-codex-tools", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Use these Agent-Mesh tools to communicate and manage self-reminders for this Codex lane.",
        "create_reminder, list_reminders, and cancel_reminder operate only as the configured lane identity.",
      ].join("\n"),
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MESH_TOOL_DEFINITIONS,
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchMeshTool(
      options,
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    ));
  return mcp;
}

async function main(): Promise<void> {
  const config = loadCodexAdapterConfig();
  const hub = new HttpMeshToolsHub({
    baseUrl: `http://127.0.0.1:${config.httpPort}`,
    token: config.httpToken,
  });
  const mcp = createCodexMeshToolsServer({ hub, laneIdentity: config.targetAgent });

  await mcp.connect(new StdioServerTransport());
  log(`started target=${config.targetAgent} adapter_http=127.0.0.1:${config.httpPort}`);
}

if (import.meta.main) {
  void main().catch((error) => {
    log("fatal:", error);
    process.exit(1);
  });
}

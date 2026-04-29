import { CodexRuntimeAdapter } from "./adapter";
import { createHttpActionProxy } from "./http-action-proxy";
import { startCodexAdapterHttpServer } from "./http-server";
import { loadCodexAdapterConfig } from "./config";

async function main(): Promise<void> {
  const config = loadCodexAdapterConfig();
  const adapter = new CodexRuntimeAdapter({
    config,
    createActionProxy: ({ hub, config: loaded }) =>
      createHttpActionProxy({
        hub,
        channelTargets: loaded.channelTargets,
      }),
  });
  const httpServer = startCodexAdapterHttpServer({
    adapter,
    port: config.httpPort,
    token: config.httpToken,
    logger: (...args) => console.log("[runtime-codex] [http]", ...args),
  });

  adapter.start();

  const shutdown = async (signal: string) => {
    console.log(`[runtime-codex] shutdown requested via ${signal}`);
    try {
      httpServer.stop();
      adapter.stop();
    } finally {
      process.exit(0);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await new Promise<void>(() => {});
}

void main().catch((error) => {
  console.error("[runtime-codex] fatal:", error);
  process.exit(1);
});

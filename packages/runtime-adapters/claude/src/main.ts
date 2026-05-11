import { ClaudeRuntimeAdapter } from "./adapter";
import { loadClaudeAdapterConfig } from "./config";

async function main(): Promise<void> {
  const config = loadClaudeAdapterConfig();
  const adapter = new ClaudeRuntimeAdapter({ config });

  adapter.start();

  const shutdown = async (signal: string) => {
    console.log(`[runtime-claude] shutdown requested via ${signal}`);
    try {
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
  console.error("[runtime-claude] fatal:", error);
  process.exit(1);
});

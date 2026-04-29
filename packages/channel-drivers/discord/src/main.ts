import { startDiscordDriver } from "./runtime";

async function main(): Promise<void> {
  const runtime = await startDiscordDriver();
  const shutdown = async (signal: string) => {
    console.log(`[channel-discord] shutdown requested via ${signal}`);
    try {
      await runtime.stop();
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
  console.error("[channel-discord] fatal:", error);
  process.exit(1);
});

import { FixedArgvGateRunner, type OutboundNotifier, openAutonomyStore } from "./autonomy";
import { startAutonomyDaemon } from "./daemon";
import { AUTONOMY_HUB_URL_ENV, AUTONOMY_IDENTITY_ENV, OutboundPmNotifier, readOutboundNotifierConfig, type RuntimeEnvironment } from "./notifier";
import { SOCKET_PARENT } from "./policy";

const PRODUCTION_STATE_ROOT = "/var/lib/synapse-pm-autonomy";
const PRODUCTION_MANIFESTS_ROOT = "/var/lib/synapse-pm-autonomy/manifests";
const PRODUCTION_ARTIFACTS_ROOT = "/var/lib/synapse-pm-autonomy/artifacts";
/** One minute is bounded and comfortably below the fixed 15-minute heartbeat threshold. */
export const WATCHDOG_INTERVAL_MS = 60_000;

/** Fixed-route outbound mesh notifier. It does not receive or act on mesh events. */
export class FixedPmNotifier implements OutboundNotifier {
  private readonly environment: RuntimeEnvironment;

  constructor(environment?: RuntimeEnvironment) {
    this.environment = environment ?? {
      [AUTONOMY_HUB_URL_ENV]: process.env[AUTONOMY_HUB_URL_ENV],
      [AUTONOMY_IDENTITY_ENV]: process.env[AUTONOMY_IDENTITY_ENV],
    };
  }

  async send(message: { from: "synapse-pm-autonomy"; to: "synapse-pm"; content: string }): Promise<void> {
    const config = readOutboundNotifierConfig(this.environment);
    await new OutboundPmNotifier(config).send(message);
  }
}

export interface AutonomyDaemonCompositionOptions {
  stateRoot: string;
  manifestsRoot: string;
  artifactsRoot: string;
  socketPath: string;
  daemonUid: number;
  clock?: () => Date;
  environment?: RuntimeEnvironment;
  /** Fixture-only path validator; production always uses the exact /run policy. */
  socketPathValidator?: (socketPath: string) => string;
  scheduler?: WatchdogScheduler;
}

export interface WatchdogScheduler {
  setInterval: (callback: () => Promise<void>, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface WatchdogLifecycle {
  close: () => void;
}

const processScheduler: WatchdogScheduler = {
  setInterval: (callback, intervalMs) => setInterval(() => { void callback(); }, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A single fail-closed watchdog loop; repeated timer ticks never overlap. */
export function startRecurringWatchdog(runWatchdog: () => Promise<unknown>, scheduler: WatchdogScheduler = processScheduler): WatchdogLifecycle {
  let closed = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (closed || running) return;
    running = true;
    try { await runWatchdog(); }
    catch { /* The store commits only after outbound delivery; scheduled failures stay fail-closed. */ }
    finally { running = false; }
  };
  const handle = scheduler.setInterval(tick, WATCHDOG_INTERVAL_MS);
  return {
    close: () => { if (!closed) { closed = true; scheduler.clearInterval(handle); } },
  };
}

/**
 * Composition is explicit so fixtures can use temporary state roots. Production
 * always calls this with the fixed roots below and does not inject peer identity.
 */
export function composeAutonomyDaemon(options: AutonomyDaemonCompositionOptions) {
  const store = openAutonomyStore(options.stateRoot, options.clock);
  const notifier = new FixedPmNotifier(options.environment);
  const gateRunner = new FixedArgvGateRunner(options.manifestsRoot, options.artifactsRoot);
  return {
    store,
    notifier,
    gateRunner,
    runWatchdog: () => store.watchdog(notifier),
    startRecurringWatchdog: () => startRecurringWatchdog(() => store.watchdog(notifier), options.scheduler),
    start: () => startAutonomyDaemon({
      socketPath: options.socketPath,
      daemonUid: options.daemonUid,
      store,
      manifestsRoot: options.manifestsRoot,
      gateRunner,
      ...(options.socketPathValidator ? { socketPathValidator: options.socketPathValidator } : {}),
    }),
  };
}

export interface AutonomyRuntime<Server = ReturnType<typeof startAutonomyDaemon>> {
  start: () => Server;
  runWatchdog: () => Promise<{ heartbeat: number; nudge: number; escalate: number }>;
  startRecurringWatchdog?: () => WatchdogLifecycle;
}

const runtimeStarts = new WeakMap<object, Promise<unknown>>();

function bindLifecycleToServer(server: unknown, lifecycle: WatchdogLifecycle | undefined): void {
  const closeEmitter = server as { once?: (event: string, callback: () => void) => void };
  if (lifecycle && typeof closeEmitter?.once === "function") closeEmitter.once("close", lifecycle.close);
}

/** Start the local UDS daemon, perform the initial check, then keep one recurring watchdog alive. */
export async function startAutonomyRuntime<Server>(runtime: AutonomyRuntime<Server>): Promise<Server> {
  const prior = runtimeStarts.get(runtime);
  if (prior) return prior as Promise<Server>;
  const start = (async () => {
    const server = runtime.start();
    await runtime.runWatchdog();
    bindLifecycleToServer(server, runtime.startRecurringWatchdog?.());
    return server;
  })();
  runtimeStarts.set(runtime, start);
  try { return await start as Server; }
  catch (error) { runtimeStarts.delete(runtime); throw error; }
}

/** Production entrypoint: local UDS in a verified service-owned runtime directory only. */
export async function startProductionAutonomyDaemon() {
  const daemonUid = process.getuid?.();
  if (typeof daemonUid !== "number" || !Number.isInteger(daemonUid)) throw new Error("OS uid is required for the local autonomy daemon");
  const runtime = composeAutonomyDaemon({
    stateRoot: PRODUCTION_STATE_ROOT,
    manifestsRoot: PRODUCTION_MANIFESTS_ROOT,
    artifactsRoot: PRODUCTION_ARTIFACTS_ROOT,
    socketPath: `${SOCKET_PARENT}/control.sock`,
    daemonUid,
  });
  return startAutonomyRuntime(runtime);
}

if (import.meta.main) startProductionAutonomyDaemon();

/** PM-only local autonomy exports. This package deliberately does not import self-reminder. */
export * from "./autonomy";
export * from "./client";
export * from "./daemon";
export * from "./deployment-contract";
export * from "./policy";
export * from "./source-gate";
export * from "./notifier";

import { FixedArgvGateRunner, type OutboundNotifier, openAutonomyStore } from "./autonomy";
import { startAutonomyDaemon } from "./daemon";
import { AUTONOMY_HUB_URL_ENV, AUTONOMY_IDENTITY_ENV, OutboundPmNotifier, readOutboundNotifierConfig, type RuntimeEnvironment } from "./notifier";
import { SOCKET_PARENT } from "./policy";

const PRODUCTION_STATE_ROOT = "/var/lib/synapse-pm-autonomy";
const PRODUCTION_MANIFESTS_ROOT = "/var/lib/synapse-pm-autonomy/manifests";
const PRODUCTION_ARTIFACTS_ROOT = "/var/lib/synapse-pm-autonomy/artifacts";

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
    start: () => startAutonomyDaemon({
      socketPath: options.socketPath,
      daemonUid: options.daemonUid,
      store,
      manifestsRoot: options.manifestsRoot,
      gateRunner,
    }),
  };
}

export interface AutonomyRuntime<Server = ReturnType<typeof startAutonomyDaemon>> {
  start: () => Server;
  runWatchdog: () => Promise<{ heartbeat: number; nudge: number; escalate: number }>;
}

/** Start the local UDS daemon, then run the fixed outbound watchdog workflow. */
export async function startAutonomyRuntime<Server>(runtime: AutonomyRuntime<Server>): Promise<Server> {
  const server = runtime.start();
  await runtime.runWatchdog();
  return server;
}

/** Production entrypoint: local UDS only, real OS peer credentials, no service management. */
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
export * from "./policy";
export * from "./source-gate";
export * from "./notifier";

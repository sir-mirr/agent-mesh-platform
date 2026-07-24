import { FixedArgvGateRunner, type OutboundNotifier, openAutonomyStore } from "./autonomy";
import { startAutonomyDaemon } from "./daemon";
import { SOCKET_PARENT } from "./policy";

const PRODUCTION_STATE_ROOT = "/var/lib/synapse-pm-autonomy";
const PRODUCTION_MANIFESTS_ROOT = "/var/lib/synapse-pm-autonomy/manifests";
const PRODUCTION_ARTIFACTS_ROOT = "/var/lib/synapse-pm-autonomy/artifacts";

/** A fixed PM-directed local notifier; mesh delivery remains outside this A-lane package. */
export class FixedPmNotifier implements OutboundNotifier {
  async send(message: { from: "synapse-pm-autonomy"; to: "synapse-pm"; content: string }): Promise<void> {
    if (message.from !== "synapse-pm-autonomy" || message.to !== "synapse-pm") throw new Error("fixed PM notifier rejected a non-PM route");
    process.stderr.write(`${JSON.stringify(message)}\n`);
  }
}

export interface AutonomyDaemonCompositionOptions {
  stateRoot: string;
  manifestsRoot: string;
  artifactsRoot: string;
  socketPath: string;
  daemonUid: number;
}

/**
 * Composition is explicit so fixtures can use temporary state roots. Production
 * always calls this with the fixed roots below and does not inject peer identity.
 */
export function composeAutonomyDaemon(options: AutonomyDaemonCompositionOptions) {
  const store = openAutonomyStore(options.stateRoot);
  const notifier = new FixedPmNotifier();
  const gateRunner = new FixedArgvGateRunner(options.manifestsRoot, options.artifactsRoot);
  return {
    store,
    notifier,
    gateRunner,
    start: () => startAutonomyDaemon({
      socketPath: options.socketPath,
      daemonUid: options.daemonUid,
      store,
      manifestsRoot: options.manifestsRoot,
      gateRunner,
    }),
  };
}

/** Production entrypoint: local UDS only, real OS peer credentials, no service management. */
export function startProductionAutonomyDaemon() {
  const daemonUid = process.getuid?.();
  if (typeof daemonUid !== "number" || !Number.isInteger(daemonUid)) throw new Error("OS uid is required for the local autonomy daemon");
  return composeAutonomyDaemon({
    stateRoot: PRODUCTION_STATE_ROOT,
    manifestsRoot: PRODUCTION_MANIFESTS_ROOT,
    artifactsRoot: PRODUCTION_ARTIFACTS_ROOT,
    socketPath: `${SOCKET_PARENT}/control.sock`,
    daemonUid,
  }).start();
}

if (import.meta.main) startProductionAutonomyDaemon();

/** PM-only local autonomy exports. This package deliberately does not import self-reminder. */
export * from "./autonomy";
export * from "./client";
export * from "./daemon";
export * from "./policy";
export * from "./source-gate";

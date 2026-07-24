import { Database } from "bun:sqlite";

import { SynapsePmTaskController } from "./controller";
import { LocalControlPlane, startLocalControlServer } from "./control";
import { FixedKmsGateRunner } from "./kms-gate-runner";
import { SynapsePmOutboundMeshNotifier } from "./outbound-mesh";
import { SynapsePmAutonomyStore } from "./store";
import { SynapsePmAutonomyWatchdog } from "./watchdog";
import { autonomyDbPath } from "./config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const dbPath = required("SYNAPSE_PM_AUTONOMY_DB");
const socketPath = required("SYNAPSE_PM_AUTONOMY_SOCKET");
const kmsRoot = required("SYNAPSE_PM_AUTONOMY_KMS_ROOT");
const kmsPython = required("SYNAPSE_PM_AUTONOMY_KMS_PYTHON");
const hubUrl = required("SYNAPSE_PM_AUTONOMY_HUB_URL");
if (process.env.SYNAPSE_PM_AUTONOMY_IDENTITY && process.env.SYNAPSE_PM_AUTONOMY_IDENTITY !== "synapse-pm-autonomy") throw new Error("SYNAPSE_PM_AUTONOMY_IDENTITY must be synapse-pm-autonomy");
const normalizedDbPath = await autonomyDbPath(dbPath);

const db = new Database(normalizedDbPath, { create: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
const store = new SynapsePmAutonomyStore(db);
const controller = new SynapsePmTaskController(store, new FixedKmsGateRunner({ kmsRoot, python: kmsPython }));
const notifier = new SynapsePmOutboundMeshNotifier({ hubUrl, identity: "synapse-pm-autonomy" });
const watchdog = new SynapsePmAutonomyWatchdog(store, notifier);
const server = await startLocalControlServer(socketPath, new LocalControlPlane(controller));
const timer = setInterval(() => void watchdog.tick().catch(() => undefined), 60_000);

function shutdown(): void {
  clearInterval(timer);
  notifier.stop();
  server.close();
  db.close();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

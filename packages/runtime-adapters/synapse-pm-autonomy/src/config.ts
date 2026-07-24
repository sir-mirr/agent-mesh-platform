import { basename, dirname, resolve } from "node:path";

/** Fail closed rather than accidentally opening the live self-reminder store. */
export function autonomyDbPath(value: string): string {
  const normalized = resolve(value);
  if (basename(normalized) !== "autonomy.db" || basename(dirname(normalized)) !== "synapse-pm-autonomy") {
    throw new Error("SYNAPSE_PM_AUTONOMY_DB must be the dedicated synapse-pm-autonomy/autonomy.db store");
  }
  return normalized;
}

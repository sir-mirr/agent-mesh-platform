import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/** Fail closed rather than accidentally opening the live self-reminder store. */
export async function autonomyDbPath(value: string): Promise<string> {
  const normalized = resolve(value);
  if (basename(normalized) !== "autonomy.db" || basename(dirname(normalized)) !== "synapse-pm-autonomy") {
    throw new Error("SYNAPSE_PM_AUTONOMY_DB must be the dedicated synapse-pm-autonomy/autonomy.db store");
  }
  if (await realpath(dirname(normalized)) !== dirname(normalized)) throw new Error("SYNAPSE_PM_AUTONOMY_DB parent must not be a symlink");
  try {
    if ((await lstat(normalized)).isSymbolicLink()) throw new Error("SYNAPSE_PM_AUTONOMY_DB must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return normalized;
}

import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const AUTONOMY_STATE_DIR = "/var/lib/synapse-pm-autonomy";
const AUTONOMY_DB_PATH = `${AUTONOMY_STATE_DIR}/autonomy.db`;

/** Fail closed rather than accidentally opening the live self-reminder store. */
export async function autonomyDbPath(value: string): Promise<string> {
  const normalized = resolve(value);
  if (normalized !== AUTONOMY_DB_PATH || basename(normalized) !== "autonomy.db" || dirname(normalized) !== AUTONOMY_STATE_DIR) {
    throw new Error(`SYNAPSE_PM_AUTONOMY_DB must be ${AUTONOMY_DB_PATH}`);
  }
  if (await realpath(AUTONOMY_STATE_DIR) !== AUTONOMY_STATE_DIR) throw new Error("SYNAPSE_PM_AUTONOMY_DB parent must not be a symlink");
  try {
    if ((await lstat(normalized)).isSymbolicLink()) throw new Error("SYNAPSE_PM_AUTONOMY_DB must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return normalized;
}

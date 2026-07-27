import { lstatSync } from "node:fs";

export const ROOT_MANAGED_BUN = "/usr/bin/bun";
export const DEPLOYMENT_ROOT = "/opt/agent-mesh-platform";
export const AUTONOMY_ENTRYPOINT = `${DEPLOYMENT_ROOT}/packages/shared/synapse-pm-autonomy/src/main.ts`;
export const AUTONOMY_UNIT_EXEC_START = `${ROOT_MANAGED_BUN} ${AUTONOMY_ENTRYPOINT}`;
export const DEPLOYMENT_DIRECTORIES = [
  "/opt",
  DEPLOYMENT_ROOT,
  `${DEPLOYMENT_ROOT}/packages`,
  `${DEPLOYMENT_ROOT}/packages/shared`,
  `${DEPLOYMENT_ROOT}/packages/shared/synapse-pm-autonomy`,
  `${DEPLOYMENT_ROOT}/packages/shared/synapse-pm-autonomy/src`,
] as const;

export type DeploymentNode = { kind: "missing" | "file" | "directory" | "symlink" | "other"; uid: number; mode: number };
export type DeploymentInspector = (path: string) => DeploymentNode;

function rejected(message: string): never { throw new Error(`DEPLOYMENT_PRECHECK_REJECTED: ${message}`); }

function inspectFilesystem(path: string): DeploymentNode {
  try {
    const node = lstatSync(path);
    return {
      kind: node.isSymbolicLink() ? "symlink" : node.isFile() ? "file" : node.isDirectory() ? "directory" : "other",
      uid: node.uid,
      mode: node.mode & 0o777,
    };
  } catch { return { kind: "missing", uid: -1, mode: 0 }; }
}

function requireRootOwned(node: DeploymentNode, path: string): void {
  if (node.kind === "missing") rejected(`${path} is absent`);
  if (node.kind === "symlink") rejected(`${path} must not be a symlink`);
  if (node.uid !== 0) rejected(`${path} must be root-owned`);
}

function requireDirectory(node: DeploymentNode, path: string): void {
  requireRootOwned(node, path);
  if (node.kind !== "directory") rejected(`${path} must be a directory`);
  if ((node.mode & 0o001) === 0) rejected(`${path} lacks traversal mode for the dedicated service user`);
}

/**
 * Read-only C-lane preflight. It never creates, changes, or starts anything.
 * The dedicated service runs as neither root nor the deployment owner, so the
 * root-owned tree must be traversable and the entrypoint readable.
 */
export function verifyRootManagedDeployment(inspect: DeploymentInspector = inspectFilesystem): void {
  const bun = inspect(ROOT_MANAGED_BUN);
  requireRootOwned(bun, ROOT_MANAGED_BUN);
  if (bun.kind !== "file") rejected(`${ROOT_MANAGED_BUN} must be a regular executable file`);
  if ((bun.mode & 0o001) === 0) rejected(`${ROOT_MANAGED_BUN} lacks executable mode for the dedicated service user`);
  for (const directory of DEPLOYMENT_DIRECTORIES) requireDirectory(inspect(directory), directory);
  const entrypoint = inspect(AUTONOMY_ENTRYPOINT);
  requireRootOwned(entrypoint, AUTONOMY_ENTRYPOINT);
  if (entrypoint.kind !== "file") rejected(`${AUTONOMY_ENTRYPOINT} must be a regular file`);
  if ((entrypoint.mode & 0o004) === 0) rejected(`${AUTONOMY_ENTRYPOINT} lacks read mode for the dedicated service user`);
}

/** Static source verification: a changed unit executable or working tree fails before install. */
export function verifyAutonomyUnitContract(unitSource: string): void {
  for (const line of [
    "User=synapse-pm-autonomy",
    "Group=synapse-pm-autonomy",
    `WorkingDirectory=${DEPLOYMENT_ROOT}`,
    "EnvironmentFile=/etc/synapse-pm-autonomy/autonomy.env",
    `ExecStart=${AUTONOMY_UNIT_EXEC_START}`,
    "RuntimeDirectory=synapse-pm-autonomy",
    "StateDirectory=synapse-pm-autonomy",
    "UMask=0077",
    "ProtectHome=true",
    "Restart=no",
    "No self-reminder dependency",
  ]) if (!unitSource.includes(line)) rejected(`unit is missing ${line}`);
  for (const forbidden of ["~/.bun", "/home/", "ExecStart=/bin/sh", "ExecStart=/usr/bin/env", "$PATH"]) {
    if (unitSource.includes(forbidden)) rejected(`unit contains forbidden ${forbidden}`);
  }
}

if (import.meta.main) verifyRootManagedDeployment();

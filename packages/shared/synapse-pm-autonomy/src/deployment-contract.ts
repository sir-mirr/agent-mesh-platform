import { lstatSync } from "node:fs";
import { SOURCE_VERIFIED_DONE_SCHEMA, type SourceVerifiedDoneArtifact } from "./source-gate";

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
export type GeneratedArtifactFile = { kind: DeploymentNode["kind"]; mode: number; contents: string };

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

type UnitSections = Map<string, Map<string, string>>;
const EXPECTED_UNIT: Record<string, Record<string, string>> = {
  Unit: {
    Description: "Synapse PM autonomy outbound daemon (source contract)",
    After: "network-online.target",
    Wants: "network-online.target",
  },
  Service: {
    Type: "simple",
    User: "synapse-pm-autonomy",
    Group: "synapse-pm-autonomy",
    WorkingDirectory: DEPLOYMENT_ROOT,
    EnvironmentFile: "/etc/synapse-pm-autonomy/autonomy.env",
    ExecStart: AUTONOMY_UNIT_EXEC_START,
    RuntimeDirectory: "synapse-pm-autonomy",
    RuntimeDirectoryMode: "0700",
    StateDirectory: "synapse-pm-autonomy",
    StateDirectoryMode: "0700",
    UMask: "0077",
    NoNewPrivileges: "true",
    PrivateTmp: "true",
    ProtectHome: "true",
    ProtectSystem: "strict",
    Restart: "no",
  },
};

function parseUnit(unitSource: string): UnitSections {
  const sections: UnitSections = new Map();
  let active: Map<string, string> | undefined;
  for (const rawLine of unitSource.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (section) {
      if (sections.has(section[1]!)) rejected(`unit duplicates [${section[1]}] section`);
      active = new Map(); sections.set(section[1]!, active); continue;
    }
    const directive = /^([A-Za-z][A-Za-z0-9]*)(?:=)(.*)$/.exec(line);
    if (!active || !directive) rejected(`unit contains malformed active directive: ${line}`);
    const [key, value] = [directive[1]!, directive[2]!];
    if (active.has(key)) rejected(`unit duplicates ${key}`);
    active.set(key, value);
  }
  return sections;
}

/** Structural source verification: active unit directives must be exact and unique. */
export function verifyAutonomyUnitContract(unitSource: string): void {
  const sections = parseUnit(unitSource);
  if (sections.size !== Object.keys(EXPECTED_UNIT).length) rejected("unit has an unknown or conflicting section");
  for (const [section, expectedDirectives] of Object.entries(EXPECTED_UNIT)) {
    const directives = sections.get(section);
    if (!directives || directives.size !== Object.keys(expectedDirectives).length) rejected(`unit ${section} directives are not exact`);
    for (const [key, expected] of Object.entries(expectedDirectives)) {
      if (directives.get(key) !== expected) rejected(`unit ${section}.${key} is not the fixed value`);
    }
  }
  for (const directives of sections.values()) for (const [key, value] of directives) {
    if (key === "Environment" || /self-reminder|~|\/home\/|\$PATH/i.test(value)) {
      rejected(`unit contains forbidden active directive ${key}`);
    }
  }
}

function parseVerifiedDoneArtifact(contents: string): SourceVerifiedDoneArtifact {
  let value: unknown;
  try { value = JSON.parse(contents); } catch { return rejected("verified_done artifact is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return rejected("verified_done artifact must be an object");
  const record = value as Record<string, unknown>;
  const keys = ["schema", "status", "source_revision", "source_manifest_sha256", "checked_files_sha256", "command"];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) rejected("verified_done artifact has unknown or missing keys");
  if (record.schema !== SOURCE_VERIFIED_DONE_SCHEMA || record.status !== "verified_done") rejected("verified_done artifact schema/status is invalid");
  for (const key of ["source_revision", "source_manifest_sha256", "checked_files_sha256", "command"] as const) if (typeof record[key] !== "string") rejected(`verified_done artifact ${key} is invalid`);
  if (!/^[a-f0-9]{40}$/.test(record.source_revision as string) || !/^[a-f0-9]{64}$/.test(record.source_manifest_sha256 as string) || !/^[a-f0-9]{64}$/.test(record.checked_files_sha256 as string)) {
    rejected("verified_done artifact hashes are invalid");
  }
  return record as unknown as SourceVerifiedDoneArtifact;
}

/** Bind the deployed /opt Git HEAD to a generated, private source-verified-done artifact. */
export function verifyDeploymentReleaseBinding(input: { artifact: GeneratedArtifactFile; deployedGitHead: string }): SourceVerifiedDoneArtifact {
  if (input.artifact.kind !== "file") rejected("verified_done artifact must be a non-symlink regular file");
  if ((input.artifact.mode & 0o777) !== 0o600) rejected("verified_done artifact must have mode 0600");
  const artifact = parseVerifiedDoneArtifact(input.artifact.contents);
  if (!/^[a-f0-9]{40}$/.test(input.deployedGitHead) || input.deployedGitHead !== artifact.source_revision) {
    rejected("deployed /opt Git HEAD does not equal verified_done source_revision");
  }
  return artifact;
}

if (import.meta.main) verifyRootManagedDeployment();

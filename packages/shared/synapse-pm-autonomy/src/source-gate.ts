import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { BoundaryError, assertSafeFileUnderRoot, ensurePhysicalDirectory } from "./policy";

/** Deliberately absolute: this is the only git executable the source gate invokes. */
export const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
export const SOURCE_MANIFEST_SCHEMA = "synapse-pm-autonomy/source-manifest/v1";
export const SOURCE_VERIFIED_DONE_SCHEMA = "synapse-pm-autonomy/source-verified-done/v1";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../../..");
const DEFAULT_SOURCE_MANIFEST = path.join(PACKAGE_ROOT, "source-manifest.json");
const DEFAULT_ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, "tmp", "synapse-pm-autonomy", "source-verified-done");

interface SourceManifest {
  schema: typeof SOURCE_MANIFEST_SCHEMA;
  source_files: string[];
}
export interface SourceVerifiedDoneArtifact {
  schema: typeof SOURCE_VERIFIED_DONE_SCHEMA;
  status: "verified_done";
  source_revision: string;
  source_manifest_sha256: string;
  checked_files_sha256: string;
  command: string;
}
export interface SourceGateFixtureOptions {
  repositoryRoot: string;
  sourceManifestPath: string;
  artifactRoot: string;
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function exact(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
    throw new BoundaryError("SOURCE_MANIFEST_REJECTED", "source manifest has unknown or missing keys");
  }
}
function parseSourceManifest(raw: string): SourceManifest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new BoundaryError("SOURCE_MANIFEST_REJECTED", "source manifest is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundaryError("SOURCE_MANIFEST_REJECTED", "source manifest must be an object");
  const record = value as Record<string, unknown>;
  exact(record, ["schema", "source_files"]);
  if (record.schema !== SOURCE_MANIFEST_SCHEMA || !Array.isArray(record.source_files) || record.source_files.length === 0) {
    throw new BoundaryError("SOURCE_MANIFEST_REJECTED", "source manifest schema is invalid");
  }
  const sourceFiles = record.source_files;
  if (sourceFiles.some((entry) => typeof entry !== "string" || !entry || path.isAbsolute(entry) || entry.includes("\0")) || new Set(sourceFiles).size !== sourceFiles.length) {
    throw new BoundaryError("SOURCE_MANIFEST_REJECTED", "source manifest file list is invalid");
  }
  return { schema: SOURCE_MANIFEST_SCHEMA, source_files: sourceFiles as string[] };
}
function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && key !== "PATH" && value !== undefined) environment[key] = value;
  return environment;
}
function trustedGit(repositoryRoot: string, args: readonly string[]): string {
  const result = spawnSync(TRUSTED_GIT_EXECUTABLE, args, { cwd: repositoryRoot, env: sanitizedGitEnvironment(), encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) throw new BoundaryError("SOURCE_GATE_REJECTED", `trusted git check failed: ${args.join(" ")}`);
  return result.stdout.trim();
}
function cleanRevision(repositoryRoot: string): string {
  const revision = trustedGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new BoundaryError("SOURCE_GATE_REJECTED", "trusted git returned an invalid revision");
  if (trustedGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new BoundaryError("SOURCE_GATE_REJECTED", "source revision is not clean");
  }
  return revision;
}
function writeExclusiveArtifact(artifactRoot: string, revision: string, body: string): string {
  const physicalRoot = ensurePhysicalDirectory(artifactRoot);
  const token = randomBytes(16).toString("hex");
  const temporary = path.join(physicalRoot, `.source-verified-done-${token}.tmp`);
  const finalPath = path.join(physicalRoot, `source-verified-done-${revision.slice(0, 12)}-${token}.json`);
  if (path.dirname(temporary) !== physicalRoot || path.dirname(finalPath) !== physicalRoot) throw new BoundaryError("SOURCE_GATE_REJECTED", "artifact path escaped its root");
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, body, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, finalPath); } finally { unlinkSync(temporary); }
  if (lstatSync(finalPath).isSymbolicLink()) throw new BoundaryError("SYMLINK_REJECTED", "source artifact became a symlink");
  return finalPath;
}

/** Fixture-only parameterization; the public CLI below accepts no arguments. */
export function produceSourceVerifiedDoneForFixture(options: SourceGateFixtureOptions): { artifactPath: string; artifact: SourceVerifiedDoneArtifact } {
  const repositoryRoot = ensurePhysicalDirectory(options.repositoryRoot);
  const manifestPath = assertSafeFileUnderRoot(repositoryRoot, path.relative(repositoryRoot, path.resolve(options.sourceManifestPath)));
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseSourceManifest(manifestBytes.toString("utf8"));
  const before = cleanRevision(repositoryRoot);
  const hashes = manifest.source_files.map((entry) => `${entry}:${sha256(readFileSync(assertSafeFileUnderRoot(repositoryRoot, entry)))}`).join("\n");
  const after = cleanRevision(repositoryRoot);
  if (before !== after) throw new BoundaryError("SOURCE_GATE_REJECTED", "source revision changed during verification");
  const artifact: SourceVerifiedDoneArtifact = {
    schema: SOURCE_VERIFIED_DONE_SCHEMA,
    status: "verified_done",
    source_revision: before,
    source_manifest_sha256: sha256(manifestBytes),
    checked_files_sha256: sha256(hashes),
    command: `${TRUSTED_GIT_EXECUTABLE} rev-parse --verify HEAD && ${TRUSTED_GIT_EXECUTABLE} status --porcelain=v1 --untracked-files=all`,
  };
  return { artifactPath: writeExclusiveArtifact(options.artifactRoot, before, `${JSON.stringify(artifact)}\n`), artifact };
}

/** Closed source gate: exactly zero user arguments and fixed source-controlled locations. */
export function runClosedSourceVerifiedDoneGate(): { artifactPath: string; artifact: SourceVerifiedDoneArtifact } {
  return produceSourceVerifiedDoneForFixture({ repositoryRoot: REPOSITORY_ROOT, sourceManifestPath: DEFAULT_SOURCE_MANIFEST, artifactRoot: DEFAULT_ARTIFACT_ROOT });
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new BoundaryError("SOURCE_GATE_REJECTED", "source gate accepts no arguments");
  process.stdout.write(`${JSON.stringify(runClosedSourceVerifiedDoneGate())}\n`);
}

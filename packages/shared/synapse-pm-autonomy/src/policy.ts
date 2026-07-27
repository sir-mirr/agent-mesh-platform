import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const SOCKET_PARENT = "/run/synapse-pm-autonomy";
export const AUTONOMY_DB_BASENAME = "autonomy.db";

export class BoundaryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function requireNoSymlink(existingPath: string): void {
  try {
    if (lstatSync(existingPath).isSymbolicLink()) {
      throw new BoundaryError("SYMLINK_REJECTED", `symlink is not allowed: ${existingPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function requireExistingParentsNotSymlinks(candidate: string): void {
  let current = path.parse(path.resolve(candidate)).root;
  for (const part of path.resolve(candidate).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    requireNoSymlink(current);
  }
}

function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** The production socket is deliberately one flat, local-only namespace. */
export function assertSocketPath(socketPath: string): string {
  if (typeof socketPath !== "string" || socketPath.includes("\0")) {
    throw new BoundaryError("SOCKET_PATH_REJECTED", "socket path must be a string without NUL");
  }
  const normalized = path.normalize(socketPath);
  if (normalized !== socketPath || path.dirname(normalized) !== SOCKET_PARENT || !path.basename(normalized).endsWith(".sock")) {
    throw new BoundaryError("SOCKET_PATH_REJECTED", "socket must be a flat .sock under the exact autonomy runtime parent");
  }
  return normalized;
}

/**
 * The UDS namespace is the local-control boundary when the pinned runtime has
 * no supported accepted-socket peer-credential API. Check it immediately
 * before bind: systemd creates this exact service-owned 0700 directory.
 */
export function assertServiceOwnedSocketParent(socketPath: string, daemonUid: number): string {
  if (typeof socketPath !== "string" || socketPath.includes("\0") || !Number.isInteger(daemonUid)) {
    throw new BoundaryError("RUNTIME_DIRECTORY_REJECTED", "socket parent or service uid is invalid");
  }
  const parent = path.dirname(path.resolve(socketPath));
  let node: ReturnType<typeof lstatSync>;
  try { node = lstatSync(parent); }
  catch { throw new BoundaryError("RUNTIME_DIRECTORY_REJECTED", "socket parent must already exist"); }
  if (node.isSymbolicLink()) throw new BoundaryError("SYMLINK_REJECTED", "socket parent must not be a symlink");
  if (!node.isDirectory()) throw new BoundaryError("RUNTIME_DIRECTORY_REJECTED", "socket parent must be a directory");
  if (node.uid !== daemonUid) throw new BoundaryError("RUNTIME_DIRECTORY_REJECTED", "socket parent must be owned by the service uid");
  if ((node.mode & 0o7777) !== 0o700) {
    throw new BoundaryError("RUNTIME_DIRECTORY_REJECTED", "socket parent must have exact mode 0700");
  }
  let physical: string;
  try { physical = realpathSync(parent); }
  catch { throw new BoundaryError("RUNTIME_DIRECTORY_REJECTED", "socket parent must resolve physically"); }
  if (physical !== parent) throw new BoundaryError("SYMLINK_REJECTED", "socket parent must not resolve through a symlink");
  return physical;
}

/** Reject lexical escapes, then lstat and realpath before an allowlisted read. */
export function assertSafeFileUnderRoot(root: string, reference: string): string {
  if (typeof reference !== "string" || !reference || path.isAbsolute(reference) || reference.includes("\0")) {
    throw new BoundaryError("PATH_REJECTED", "reference must be a non-empty relative path");
  }
  const rootReal = realpathSync(root);
  const candidate = path.resolve(rootReal, reference);
  if (!isUnder(rootReal, candidate)) throw new BoundaryError("PATH_REJECTED", "reference escapes its allowlist root");
  requireExistingParentsNotSymlinks(candidate);
  const candidateReal = realpathSync(candidate);
  if (!isUnder(rootReal, candidateReal)) throw new BoundaryError("PATH_REJECTED", "resolved reference escapes its allowlist root");
  return candidateReal;
}

/** Dedicated state only: <state-root>/synapse-pm-autonomy/autonomy.db. */
export function assertAutonomyDatabasePath(stateRoot: string, dbPath: string): string {
  const normalizedRoot = path.resolve(stateRoot);
  const dedicatedRoot = path.basename(normalizedRoot) === "synapse-pm-autonomy" ? normalizedRoot : path.join(normalizedRoot, "synapse-pm-autonomy");
  const expected = path.join(dedicatedRoot, AUTONOMY_DB_BASENAME);
  if (path.resolve(dbPath) !== expected) {
    throw new BoundaryError("DATABASE_PATH_REJECTED", "database must use the dedicated synapse-pm-autonomy/autonomy.db path");
  }
  requireExistingParentsNotSymlinks(expected);
  return expected;
}

/** Create or reopen a state directory only after both lexical and physical checks. */
export function ensurePhysicalDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  requireExistingParentsNotSymlinks(absolute);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  requireExistingParentsNotSymlinks(absolute);
  const physical = realpathSync(absolute);
  if (physical !== absolute) throw new BoundaryError("SYMLINK_REJECTED", "state directory must not resolve through a symlink");
  return physical;
}

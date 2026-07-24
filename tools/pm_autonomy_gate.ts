#!/usr/bin/env bun
/**
 * Fixed source-only gate for the PM autonomy daemon's own A-lane build.
 * It accepts no profile, command, success override, artifact path, or force
 * argument. Runtime deployment remains a separately approved C-lane action.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TASK_ID = "synapse-pm-autonomy-daemon-001";
const MANIFEST = resolve(ROOT, ".synapse/autonomy/synapse-pm-autonomy-daemon-001.json");
const ARTIFACT_ROOT = resolve(ROOT, ".synapse/artifacts", TASK_ID);
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(name))) as Record<string, string>;
const GIT_BIN = "/usr/bin/git";

interface Manifest {
  task_id: string;
  autonomy: { lane: string; owner: string; approval_ref: string; existing_capabilities: string[] };
  verification: { target_ref: string; required_profiles: string[]; canary_required: boolean };
  rollback: { profile: string };
}

async function run(argv: string[]): Promise<{ status: "PASS"; checks: Array<{ name: string; status: "passed"; detail: string }> }> {
  const child = Bun.spawn(argv, { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`fixed profile failed: ${argv[1] ?? argv[0]}`);
  return { status: "PASS", checks: [{ name: "exit_status", status: "passed", detail: "fixed profile exited 0" }] };
}

async function revision(): Promise<string> {
  const child = Bun.spawn([GIT_BIN, "rev-parse", "HEAD"], { cwd: ROOT, env: GIT_ENV, stdout: "pipe", stderr: "ignore" });
  const value = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0 || !/^[a-f0-9]{40}$/.test(value)) throw new Error("unable to identify source revision");
  return value;
}

async function requireTrackedClean(): Promise<void> {
  for (const args of [["diff", "--quiet"], ["diff", "--cached", "--quiet"]]) {
    const child = Bun.spawn([GIT_BIN, ...args], { cwd: ROOT, env: GIT_ENV, stdout: "ignore", stderr: "ignore" });
    if (await child.exited !== 0) throw new Error("source tree has tracked changes");
  }
}

function assertManifest(raw: unknown): asserts raw is Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid manifest");
  const value = raw as Manifest;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["autonomy", "rollback", "task_id", "verification"])) throw new Error("invalid manifest fields");
  if (!value.autonomy || JSON.stringify(Object.keys(value.autonomy).sort()) !== JSON.stringify(["approval_ref", "existing_capabilities", "lane", "owner"])) throw new Error("invalid autonomy manifest fields");
  if (!value.verification || JSON.stringify(Object.keys(value.verification).sort()) !== JSON.stringify(["canary_required", "required_profiles", "target_ref"])) throw new Error("invalid verification manifest fields");
  if (!value.rollback || JSON.stringify(Object.keys(value.rollback).sort()) !== JSON.stringify(["profile"])) throw new Error("invalid rollback manifest fields");
  if (
    value.task_id !== TASK_ID || value.autonomy?.lane !== "A" || value.autonomy?.owner !== "synapse-pm"
    || value.autonomy?.approval_ref !== "team-lead-20260724-separate-pm-daemon" || JSON.stringify(value.autonomy?.existing_capabilities) !== "[]"
    || value.verification?.target_ref !== "main" || value.verification?.canary_required !== false
    || JSON.stringify(value.verification?.required_profiles) !== JSON.stringify(["unit", "contract"])
    || value.rollback?.profile !== "source_only"
  ) throw new Error("manifest requests an unsupported autonomy gate");
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("pm autonomy gate accepts no arguments");
  const manifestBytes = await readFile(MANIFEST);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  assertManifest(manifest);
  await requireTrackedClean();
  const sourceRevision = await revision();
  const profiles = [
    { profile: "unit", ...(await run([process.execPath, "test", "packages/runtime-adapters/synapse-pm-autonomy/src"])) },
    { profile: "contract", ...(await run([process.execPath, "--bun", "./node_modules/typescript/bin/tsc", "-p", "packages/runtime-adapters/synapse-pm-autonomy/tsconfig.json", "--pretty", "false"])) },
  ];
  await requireTrackedClean();
  if (await revision() !== sourceRevision) throw new Error("source revision changed while gate was running");
  const artifact = {
    schema: "synapse/verified-done/v1",
    task_id: TASK_ID,
    lane: "A",
    owner: "synapse-pm",
    approval_ref: manifest.autonomy.approval_ref,
    target_ref: "main",
    source_revision: sourceRevision,
    manifest_sha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    rollback_profile: "source_only",
    status: "verified_done",
    verified_at: new Date().toISOString(),
    profiles,
  };
  await mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  if (await realpath(ARTIFACT_ROOT) !== ARTIFACT_ROOT) throw new Error("artifact root must not be a symlink");
  const destination = resolve(ARTIFACT_ROOT, `${sourceRevision}.json`);
  const temporary = resolve(ARTIFACT_ROOT, `.${sourceRevision}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(artifact, null, 2) + "\n"); }
  finally { await handle.close(); }
  await rename(temporary, destination);
  process.stdout.write(JSON.stringify({ status: "verified_done", artifact: destination }) + "\n");
}

await main();

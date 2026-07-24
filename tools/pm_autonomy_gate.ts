#!/usr/bin/env bun
/**
 * Fixed source-only gate for the PM autonomy daemon's own A-lane build.
 * It accepts no profile, command, success override, artifact path, or force
 * argument. Runtime deployment remains a separately approved C-lane action.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TASK_ID = "synapse-pm-autonomy-daemon-001";
const MANIFEST = resolve(ROOT, ".synapse/autonomy/synapse-pm-autonomy-daemon-001.json");
const ARTIFACT_ROOT = resolve(ROOT, ".synapse/artifacts", TASK_ID);

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
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  const value = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0 || !/^[a-f0-9]{40}$/.test(value)) throw new Error("unable to identify source revision");
  return value;
}

function assertManifest(raw: unknown): asserts raw is Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid manifest");
  const value = raw as Manifest;
  if (
    value.task_id !== TASK_ID || value.autonomy?.lane !== "A" || value.autonomy?.owner !== "synapse-pm"
    || value.verification?.target_ref !== "main" || value.verification?.canary_required !== false
    || JSON.stringify(value.verification?.required_profiles) !== JSON.stringify(["unit", "contract"])
    || value.rollback?.profile !== "source_only"
  ) throw new Error("manifest requests an unsupported autonomy gate");
}

async function main(): Promise<void> {
  const manifestBytes = await readFile(MANIFEST);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  assertManifest(manifest);
  const profiles = [
    { profile: "unit", ...(await run([process.execPath, "test", "packages/runtime-adapters/synapse-pm-autonomy/src"])) },
    { profile: "contract", ...(await run([process.execPath, "--bun", "./node_modules/typescript/bin/tsc", "-p", "packages/runtime-adapters/synapse-pm-autonomy/tsconfig.json", "--pretty", "false"])) },
  ];
  const sourceRevision = await revision();
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
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  const destination = resolve(ARTIFACT_ROOT, `${sourceRevision}.json`);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, destination);
  process.stdout.write(JSON.stringify({ status: "verified_done", artifact: destination }) + "\n");
}

await main();

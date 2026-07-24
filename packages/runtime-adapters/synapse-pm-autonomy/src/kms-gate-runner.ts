import { resolve, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";

import type { GateArtifact, GateRunner } from "./controller";

interface GateOutput { status?: unknown; artifact?: unknown; }

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`);
}

/**
 * Closed runner: neither command text nor profile result is supplied by the
 * caller. The daemon invokes exactly the reviewed KMS gate entrypoint.
 */
export class FixedKmsGateRunner implements GateRunner {
  private readonly manifestRoot: string;
  private readonly artifactRoot: string;

  constructor(private readonly options: { kmsRoot: string; python: string }) {
    const root = resolve(options.kmsRoot);
    this.manifestRoot = resolve(root, ".synapse", "autonomy");
    this.artifactRoot = resolve(root, ".synapse", "artifacts");
  }

  async run(manifestRef: string): Promise<{ artifact: GateArtifact; rawArtifact: Uint8Array }> {
    const manifest = resolve(this.options.kmsRoot, manifestRef);
    if (!inside(this.manifestRoot, manifest) || !manifest.endsWith(".json")) throw new Error("manifest ref escaped allowlist");
    const process = Bun.spawn([
      this.options.python,
      "ops/autonomy_gate.py",
      "--manifest", manifest,
      "--artifact-root", ".synapse/artifacts",
    ], { cwd: this.options.kmsRoot, stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(process.stdout).text();
    if (await process.exited !== 0) throw new Error("gate runner failed");
    let output: GateOutput;
    try { output = JSON.parse(stdout) as GateOutput; } catch { throw new Error("gate runner emitted invalid output"); }
    if (output.status !== "verified_done" || typeof output.artifact !== "string") throw new Error("gate runner did not verify task");
    const artifactPath = resolve(this.options.kmsRoot, output.artifact);
    if (!inside(this.artifactRoot, artifactPath) || !artifactPath.endsWith(".json")) throw new Error("gate artifact escaped allowlist");
    const rawArtifact = await readFile(artifactPath);
    let artifact: GateArtifact;
    try { artifact = JSON.parse(new TextDecoder().decode(rawArtifact)) as GateArtifact; } catch { throw new Error("gate artifact is invalid JSON"); }
    return { artifact, rawArtifact };
  }
}

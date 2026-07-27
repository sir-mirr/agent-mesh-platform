import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AUTONOMY_ENTRYPOINT, DEPLOYMENT_DIRECTORIES, ROOT_MANAGED_BUN, verifyAutonomyUnitContract, verifyDeploymentReleaseBinding, verifyRootManagedDeployment, type DeploymentNode } from "./deployment-contract";
import { SOURCE_VERIFIED_DONE_SCHEMA } from "./source-gate";

const unitPath = path.resolve(import.meta.dir, "../../../../ops/systemd/synapse-pm-autonomy.service");
const goodDirectory: DeploymentNode = { kind: "directory", uid: 0, mode: 0o755 };
const goodFile: DeploymentNode = { kind: "file", uid: 0, mode: 0o755 };

function inspector(overrides: Record<string, DeploymentNode> = {}): (candidate: string) => DeploymentNode {
  return (candidate) => overrides[candidate] ?? (DEPLOYMENT_DIRECTORIES.includes(candidate as typeof DEPLOYMENT_DIRECTORIES[number]) ? goodDirectory : goodFile);
}

describe("Synapse PM autonomy root-managed deployment contract", () => {
  test("accepts only the root-owned regular Bun and traversable /opt source tree contract", () => {
    expect(() => verifyRootManagedDeployment(inspector())).not.toThrow();
  });

  test("fails closed for absent, symlinked, non-root, or inaccessible deployment prerequisites", () => {
    for (const [candidate, node] of [
      [ROOT_MANAGED_BUN, { kind: "missing", uid: -1, mode: 0 }],
      [ROOT_MANAGED_BUN, { kind: "symlink", uid: 0, mode: 0o777 }],
      [ROOT_MANAGED_BUN, { kind: "file", uid: 1000, mode: 0o755 }],
      [ROOT_MANAGED_BUN, { kind: "file", uid: 0, mode: 0o644 }],
      [DEPLOYMENT_DIRECTORIES[1], { kind: "directory", uid: 0, mode: 0o700 }],
      [AUTONOMY_ENTRYPOINT, { kind: "symlink", uid: 0, mode: 0o755 }],
    ] as const) {
      expect(() => verifyRootManagedDeployment(inspector({ [candidate]: node }))).toThrow("DEPLOYMENT_PRECHECK_REJECTED");
    }
  });

  test("rejects a changed Bun executable or working tree in the source-only unit", () => {
    const unit = readFileSync(unitPath, "utf8");
    expect(() => verifyAutonomyUnitContract(unit)).not.toThrow();
    for (const invalid of [
      unit.replace("ExecStart=/usr/bin/bun", "# ExecStart=/usr/bin/bun"),
      unit + "\nExecStart=/usr/bin/bun /opt/agent-mesh-platform/packages/shared/synapse-pm-autonomy/src/main.ts\n",
      unit + "\nWorkingDirectory=/srv/agent-mesh-platform\n",
      unit.replace("ProtectHome=true", "ProtectHome=false"),
      unit.replace("RuntimeDirectoryMode=0700", "RuntimeDirectoryMode=0750"),
      unit + "\nEnvironment=PATH=/tmp\n",
      unit + "\nEnvironment=SELF_REMINDER_DB=/tmp/self-reminder.db\n",
      unit + "\n[Install]\nWantedBy=multi-user.target\n",
    ]) expect(() => verifyAutonomyUnitContract(invalid)).toThrow("DEPLOYMENT_PRECHECK_REJECTED");
    expect(() => verifyAutonomyUnitContract(unit + "\n# /home comment is inactive\n")).not.toThrow();
  });

  test("binds deployed Git HEAD to an exact private generated source-verified-done artifact", () => {
    const revision = "a".repeat(40);
    const contents = JSON.stringify({ schema: SOURCE_VERIFIED_DONE_SCHEMA, status: "verified_done", source_revision: revision, source_manifest_sha256: "b".repeat(64), checked_files_sha256: "c".repeat(64), command: "/usr/bin/git rev-parse --verify HEAD" });
    expect(() => verifyDeploymentReleaseBinding({ artifact: { kind: "file", mode: 0o600, contents }, deployedGitHead: revision })).not.toThrow();
    for (const input of [
      { artifact: { kind: "symlink" as const, mode: 0o600, contents }, deployedGitHead: revision },
      { artifact: { kind: "file" as const, mode: 0o644, contents }, deployedGitHead: revision },
      { artifact: { kind: "file" as const, mode: 0o600, contents: JSON.stringify({ schema: SOURCE_VERIFIED_DONE_SCHEMA, status: "pending", source_revision: revision, source_manifest_sha256: "b".repeat(64), checked_files_sha256: "c".repeat(64), command: "x" }) }, deployedGitHead: revision },
      { artifact: { kind: "file" as const, mode: 0o600, contents: JSON.stringify({ schema: SOURCE_VERIFIED_DONE_SCHEMA, status: "verified_done", source_revision: revision, source_manifest_sha256: "b".repeat(64), checked_files_sha256: "c".repeat(64), command: "x", extra: true }) }, deployedGitHead: revision },
      { artifact: { kind: "file" as const, mode: 0o600, contents: "not-json" }, deployedGitHead: revision },
      { artifact: { kind: "file" as const, mode: 0o600, contents }, deployedGitHead: "d".repeat(40) },
    ]) expect(() => verifyDeploymentReleaseBinding(input)).toThrow("DEPLOYMENT_PRECHECK_REJECTED");
  });
});

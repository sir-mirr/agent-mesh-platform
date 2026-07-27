import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AUTONOMY_ENTRYPOINT, DEPLOYMENT_DIRECTORIES, ROOT_MANAGED_BUN, verifyAutonomyUnitContract, verifyRootManagedDeployment, type DeploymentNode } from "./deployment-contract";

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
    expect(() => verifyAutonomyUnitContract(unit.replace("/usr/bin/bun", "/home/synapse-pm-autonomy/.bun/bin/bun"))).toThrow("DEPLOYMENT_PRECHECK_REJECTED");
    expect(() => verifyAutonomyUnitContract(unit.replace("WorkingDirectory=/opt/agent-mesh-platform", "WorkingDirectory=/srv/agent-mesh-platform"))).toThrow("DEPLOYMENT_PRECHECK_REJECTED");
  });
});

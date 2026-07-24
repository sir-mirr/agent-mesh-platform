import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { FixedKmsGateRunner } from "./kms-gate-runner";

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pm-autonomy-gate-"));
  await mkdir(join(root, ".synapse", "autonomy"), { recursive: true });
  await mkdir(join(root, ".synapse", "artifacts"), { recursive: true });
  await mkdir(join(root, "ops"), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("FixedKmsGateRunner", () => {
  test("rejects a manifest symlink whose target escapes the allowlist", async () => {
    const value = await fixture();
    try {
      const outside = join(value.root, "outside.json");
      await writeFile(outside, "{}");
      await symlink(outside, join(value.root, ".synapse", "autonomy", "escape.json"));
      await expect(new FixedKmsGateRunner({ kmsRoot: value.root, python: "/bin/true" }).run(".synapse/autonomy/escape.json")).rejects.toThrow("manifest ref escaped");
    } finally { await value.cleanup(); }
  });

  test("rejects an artifact symlink whose target escapes the allowlist", async () => {
    const value = await fixture();
    try {
      await writeFile(join(value.root, ".synapse", "autonomy", "task.json"), "{}");
      const outside = join(value.root, "outside.json");
      await writeFile(outside, "{}");
      await symlink(outside, join(value.root, ".synapse", "artifacts", "escape.json"));
      const script = join(value.root, "fake-python");
      await writeFile(script, "#!/bin/sh\nprintf '%s\\n' '{\"status\":\"verified_done\",\"artifact\":\".synapse/artifacts/escape.json\"}'\n");
      await chmod(script, 0o700);
      await expect(new FixedKmsGateRunner({ kmsRoot: value.root, python: script }).run(".synapse/autonomy/task.json")).rejects.toThrow("gate artifact escaped");
    } finally { await value.cleanup(); }
  });
});

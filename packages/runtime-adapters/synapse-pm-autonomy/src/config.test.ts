import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { autonomyDbPath } from "./config";

describe("autonomyDbPath", () => {
  test("accepts only an existing dedicated non-symlink parent and DB entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pm-autonomy-db-"));
    try {
      const dedicated = join(root, "synapse-pm-autonomy");
      const path = join(dedicated, "autonomy.db");
      await mkdir(dedicated);
      await expect(autonomyDbPath(path)).resolves.toBe(path);
      await expect(autonomyDbPath("/home/zkrypto/ai/mesh-state/self-reminder.db")).rejects.toThrow("dedicated");
      await expect(autonomyDbPath("/home/zkrypto/ai/mesh-state/autonomy.db")).rejects.toThrow("dedicated");
      await writeFile(join(root, "outside.db"), "not-a-db");
      await symlink(join(root, "outside.db"), path);
      await expect(autonomyDbPath(path)).rejects.toThrow("must not be a symlink");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("pm autonomy source gate", () => {
  test("rejects force or any caller-supplied argument", async () => {
    const root = resolve(import.meta.dir, "../../../../");
    const child = Bun.spawn([process.execPath, "tools/pm_autonomy_gate.ts", "--force"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).not.toBe(0);
  });
});

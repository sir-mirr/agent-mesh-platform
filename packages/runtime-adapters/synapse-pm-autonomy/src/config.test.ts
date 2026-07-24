import { describe, expect, test } from "bun:test";

import { autonomyDbPath } from "./config";

describe("autonomyDbPath", () => {
  test("accepts only the dedicated autonomy store location shape", () => {
    expect(autonomyDbPath("/var/lib/synapse-pm-autonomy/autonomy.db")).toBe("/var/lib/synapse-pm-autonomy/autonomy.db");
    expect(() => autonomyDbPath("/home/zkrypto/ai/mesh-state/self-reminder.db")).toThrow("dedicated");
    expect(() => autonomyDbPath("/home/zkrypto/ai/mesh-state/autonomy.db")).toThrow("dedicated");
  });
});

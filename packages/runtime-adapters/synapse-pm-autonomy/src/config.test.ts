import { describe, expect, test } from "bun:test";

import { autonomyDbPath } from "./config";

describe("autonomyDbPath", () => {
  test("rejects every non-dedicated state path before it can open a database", async () => {
    await expect(autonomyDbPath("/home/zkrypto/ai/mesh-state/self-reminder.db")).rejects.toThrow("must be /var/lib/synapse-pm-autonomy/autonomy.db");
    await expect(autonomyDbPath("/tmp/synapse-pm-autonomy/autonomy.db")).rejects.toThrow("must be /var/lib/synapse-pm-autonomy/autonomy.db");
    await expect(autonomyDbPath("/var/lib/synapse-pm-autonomy/other.db")).rejects.toThrow("must be /var/lib/synapse-pm-autonomy/autonomy.db");
  });
});

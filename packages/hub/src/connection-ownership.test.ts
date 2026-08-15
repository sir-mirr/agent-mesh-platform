import { describe, expect, test } from "bun:test";

import { ConnectionOwnership } from "./connection-ownership";

describe("ConnectionOwnership", () => {
  test("normal conflict retains the established owner with machine-correlatable generations", () => {
    const ownership = new ConnectionOwnership<object>();
    const owner = {};
    const contender = {};
    const first = ownership.claim("self-reminder", owner);
    const second = ownership.claim("self-reminder", contender);
    expect(first).toEqual({ ok: true, generation: 1 });
    expect(second).toEqual({ ok: false, incumbentGeneration: 1, contenderGeneration: 2 });
    expect(ownership.owner("self-reminder")).toBe(owner);
  });

  test("rapid repeated conflicts never evict the healthy incumbent", () => {
    const ownership = new ConnectionOwnership<object>();
    const owner = {};
    ownership.claim("self-reminder", owner);
    for (let index = 0; index < 3; index++) {
      expect(ownership.claim("self-reminder", {}).ok).toBe(false);
      expect(ownership.owner("self-reminder")).toBe(owner);
    }
  });

  test("incumbent-close race lets a new owner claim while a stale release cannot remove it", () => {
    const ownership = new ConnectionOwnership<object>();
    const oldOwner = {};
    const newOwner = {};
    ownership.claim("self-reminder", oldOwner);
    expect(ownership.release(oldOwner)).toEqual({ identity: "self-reminder", wasOwner: true });
    expect(ownership.claim("self-reminder", newOwner)).toEqual({ ok: true, generation: 2 });
    expect(ownership.release(oldOwner)).toBeNull();
    expect(ownership.owner("self-reminder")).toBe(newOwner);
  });
});

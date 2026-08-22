import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestDb } from "./harness.ts";
import { inspectGhost, runGhostIdentity } from "../scripts/ghost-identity";

/**
 * The row a crashed boot leaves, and the identity that looks like one.
 *
 * `renameSeededAdmin` moves `admin` to `platform-admin` once, and refuses when
 * both names hold rows in one table — two accounts under a single meaning being
 * worse than an old name. A boot that died part-way through (`46a2914`) left an
 * `agents.identity` row under the new name with no account behind it, so every
 * boot since has refused `name_taken (agents.identity)` and the deployment
 * cannot finish what that boot started.
 *
 * The repair is one row, and the whole risk is telling a leftover apart from a
 * real identity — which is why what is asserted here is mostly the *refusal*.
 */
describe("a name that holds nothing but a mesh row", () => {
  /** The two databases, with the columns this repair reads. */
  function stack(): { mesh: Database; local: Database } {
    // Through the harness, as every store in this tree is: `greppable.test.ts`
    // refuses a raw constructor here because the timeout it sets is the thing
    // that gets forgotten, and a rule with an exception for the harmless case
    // is a rule somebody has to adjudicate.
    const mesh = openTestDb(":memory:");
    mesh.run(`CREATE TABLE agents (identity TEXT PRIMARY KEY)`);
    mesh.run(`CREATE TABLE agent_keys (identity TEXT, fingerprint TEXT)`);
    mesh.run(`CREATE TABLE agent_owners (owner TEXT, identity TEXT)`);
    mesh.run(`CREATE TABLE role_grants (subject TEXT, capability TEXT)`);
    // `agent_group_members` and `pairing_codes` are deliberately absent: these
    // databases carry another process's DDL, and a missing table is a version
    // difference rather than an error.
    const local = openTestDb(":memory:");
    local.run(`CREATE TABLE local_users (username TEXT PRIMARY KEY)`);
    local.run(`CREATE TABLE agent_registry (id TEXT PRIMARY KEY)`);
    return { mesh, local };
  }

  test("is reported as a ghost, and removed only when asked", () => {
    const { mesh, local } = stack();
    mesh.prepare(`INSERT INTO agents (identity) VALUES (?)`).run("platform-admin");

    const looked = runGhostIdentity(["platform-admin"], { mesh, local });
    expect(looked.code).toBe(0);
    expect(looked.lines.join("\n")).toContain("a ghost");
    expect(
      mesh.prepare(`SELECT COUNT(*) AS n FROM agents`).get(),
      "reporting deleted a row — the default verb is looking",
    ).toEqual({ n: 1 });

    const removed = runGhostIdentity(["platform-admin", "--remove"], { mesh, local });
    expect(removed.code).toBe(0);
    expect({ said: removed.lines.join("\n").includes("removed"), left: mesh.prepare(`SELECT COUNT(*) AS n FROM agents`).get() })
      .toEqual({ said: true, left: { n: 0 } });
  });

  /**
   * The case this repair exists to be careful about. An identity with a key is
   * an identity; a seeded row that happens to share the name is not something
   * this can tell apart from here, so it refuses and says what it found.
   */
  test("a name with a key is refused, and the row survives", () => {
    const { mesh, local } = stack();
    mesh.prepare(`INSERT INTO agents (identity) VALUES (?)`).run("platform-admin");
    mesh.prepare(`INSERT INTO agent_keys (identity, fingerprint) VALUES (?, ?)`)
      .run("platform-admin", "SHA256:whatever");

    const out = runGhostIdentity(["platform-admin", "--remove"], { mesh, local });
    expect(
      { code: out.code, said: out.lines.join("\n"), left: mesh.prepare(`SELECT COUNT(*) AS n FROM agents`).get() },
      "a row with a key was deleted, or the refusal did not name what stopped it",
    ).toMatchObject({ code: 1, left: { n: 1 } });
    expect(out.lines.join("\n")).toContain("agent_keys.identity: 1");
  });

  test("an account behind the name is not a ghost either", () => {
    const { mesh, local } = stack();
    mesh.prepare(`INSERT INTO agents (identity) VALUES (?)`).run("platform-admin");
    local.prepare(`INSERT INTO local_users (username) VALUES (?)`).run("platform-admin");

    const out = runGhostIdentity(["platform-admin", "--remove"], { mesh, local });
    expect({ code: out.code, left: mesh.prepare(`SELECT COUNT(*) AS n FROM agents`).get() })
      .toEqual({ code: 1, left: { n: 1 } });
  });

  test("a name with no mesh row is not this tool's business", () => {
    const { mesh, local } = stack();
    const out = runGhostIdentity(["nobody", "--remove"], { mesh, local });
    expect(out.code).toBe(0);
    expect(out.lines.join("\n")).toContain("nothing here is blocking a rename");
  });

  /**
   * Where the two files come from when nobody hands them in.
   *
   * This is the half a test can skip forever — every case above passes its own
   * databases, so the paths the *operator* gets were the one part of a
   * destructive tool nothing exercised.
   */
  test("names the files it was pointed at, and refuses to guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-"));
    const mesh = openTestDb(join(dir, "agents.db"), { create: true });
    mesh.run(`CREATE TABLE agents (identity TEXT PRIMARY KEY)`);
    mesh.prepare(`INSERT INTO agents (identity) VALUES (?)`).run("platform-admin");
    mesh.close();
    const local = openTestDb(join(dir, "agent-mesh.db"), { create: true });
    local.run(`CREATE TABLE local_users (username TEXT PRIMARY KEY)`);
    local.close();

    const named = runGhostIdentity([
      "platform-admin",
      "--mesh", join(dir, "agents.db"),
      "--local", join(dir, "agent-mesh.db"),
    ]);
    expect(
      { code: named.code, said: named.lines.join("\n") },
      "the identity was read out of a flag's value, or the files were not opened",
    ).toEqual({ code: 0, said: expect.stringContaining("a ghost") });

    const was = process.env.AGENT_MESH_STATE_DIR;
    delete process.env.AGENT_MESH_STATE_DIR;
    try {
      const guessed = runGhostIdentity(["platform-admin"]);
      expect(
        { code: guessed.code, said: guessed.lines[0] },
        "a tool that deletes a row guessed which deployment it was pointed at",
      ).toEqual({ code: 2, said: "set AGENT_MESH_STATE_DIR, or pass --mesh <agents.db> --local <agent-mesh.db>" });
    } finally {
      if (was !== undefined) process.env.AGENT_MESH_STATE_DIR = was;
    }
  });

  test("without a name it says how to call it, and touches nothing", () => {
    const out = runGhostIdentity(["--remove"]);
    expect({ code: out.code, said: out.lines[0] })
      .toEqual({ code: 2, said: "usage: bun scripts/ghost-identity.ts <identity> [--remove]" });
  });

  test("a missing table is a version difference, not a crash", () => {
    const { mesh, local } = stack();
    mesh.prepare(`INSERT INTO agents (identity) VALUES (?)`).run("platform-admin");
    const report = inspectGhost("platform-admin", mesh, local);
    expect(
      { meshRow: report.meshRow, attachments: report.attachments },
      "a table this deployment does not have was counted as an attachment",
    ).toEqual({ meshRow: true, attachments: {} });
  });
});

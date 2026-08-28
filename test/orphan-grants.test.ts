/**
 * The repair for grants nobody answers to.
 *
 * Built from the owner's finding: twelve grants for `admin` on an installation
 * whose only administrator is `platform-admin`. Dead rows, and a loaded gun —
 * admit an account by that name later and it inherits the set on sight.
 *
 * The tests that matter here are the ones about *not* deleting: a subject can
 * be an agent rather than a person, and a repair that reads "no account by
 * this name" as "orphan" removes an agent's permissions along with the record
 * of why they were granted.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `openTestDb`, not `new Database`: the harness sets `busy_timeout` and
// `greppable.test.ts` enforces that every store in this tree is opened through
// it. These are throwaway fixtures in a temp directory, and the rule is still
// right — an exception is a copy of the setting that is missing.
import { openTestDb } from "./harness";

import { runChild } from "./child-output.ts";

const REPAIR = resolve(import.meta.dir, "..", "scripts", "orphan-grants.ts");

interface Grant {
  subject: string;
  capability: string;
}

/** A deployment: two databases, the tables this reads, and some rows. */
function deployment(opts: {
  localUsers?: string[];
  webUsers?: string[];
  registry?: string[];
  agents?: string[];
  grants: Grant[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), "orphan-grants-"));

  const local = openTestDb(join(dir, "agent-mesh.db"), { create: true });
  local.exec(`CREATE TABLE local_users (username TEXT PRIMARY KEY, role TEXT)`);
  local.exec(`CREATE TABLE users (github_id INTEGER PRIMARY KEY, github_login TEXT, role TEXT)`);
  local.exec(`CREATE TABLE agent_registry (id TEXT PRIMARY KEY)`);
  for (const username of opts.localUsers ?? []) {
    local.prepare(`INSERT INTO local_users (username, role) VALUES (?, 'admin')`).run(username);
  }
  opts.webUsers?.forEach((login, i) => {
    local.prepare(`INSERT INTO users (github_id, github_login, role) VALUES (?, ?, 'admin')`).run(i + 1, login);
  });
  for (const id of opts.registry ?? []) local.prepare(`INSERT INTO agent_registry (id) VALUES (?)`).run(id);
  local.close();

  const agents = openTestDb(join(dir, "agents.db"), { create: true });
  agents.exec(`CREATE TABLE agents (identity TEXT PRIMARY KEY, type TEXT)`);
  agents.exec(`CREATE TABLE role_grants (
    tenant TEXT NOT NULL, subject TEXT NOT NULL, capability TEXT NOT NULL,
    scope TEXT NOT NULL, granted_by TEXT, PRIMARY KEY (tenant, subject, capability, scope))`);
  for (const identity of opts.agents ?? []) {
    agents.prepare(`INSERT INTO agents (identity, type) VALUES (?, 'ai-claude')`).run(identity);
  }
  for (const g of opts.grants) {
    agents
      .prepare(`INSERT INTO role_grants (tenant, subject, capability, scope, granted_by) VALUES ('default', ?, ?, '*', 'legacy-admin-role')`)
      .run(g.subject, g.capability);
  }
  agents.close();
  return dir;
}

async function run(dir: string, ...args: string[]) {
  // Read from files, not pipes: `new Response(child.stdout).text()` threw
  // `EBADF: bad file descriptor` out of a reader in CI and failed a test whose
  // child had run correctly. See `test/child-output.ts`.
  const ran = await runChild(["bun", REPAIR, "--state-dir", dir, ...args]);
  return { code: ran.code, said: ran.stdout, complained: ran.stderr };
}

const subjects = (dir: string): string[] => {
  const db = openTestDb(join(dir, "agents.db"), { readonly: true });
  try {
    return (db.prepare(`SELECT subject FROM role_grants ORDER BY subject`).all() as Array<{ subject: string }>)
      .map((r) => r.subject);
  } finally {
    db.close();
  }
};

describe("finding grants nobody answers to", () => {
  test("names the subject, its grants, and who granted them", async () => {
    const dir = deployment({
      localUsers: ["platform-admin"],
      grants: [
        { subject: "platform-admin", capability: "usage.read" },
        { subject: "admin", capability: "usage.read" },
        { subject: "admin", capability: "role.grant" },
      ],
    });
    const report = await run(dir);
    // Non-zero: something is wrong and a caller that only checks the code still
    // finds out.
    expect(report.code).toBe(1);
    expect(report.said).toContain("admin — 2 grant(s)");
    expect(report.said).toContain("role.grant");
    expect(report.said).toContain("legacy-admin-role");
    // And it changed nothing.
    expect(subjects(dir)).toEqual(["admin", "admin", "platform-admin"]);
  }, 60_000);

  test("an agent's grants are not orphans", async () => {
    // The one that would be expensive to get wrong: agents hold capabilities
    // and answer to no account.
    const dir = deployment({
      localUsers: ["platform-admin"],
      agents: ["ai-claude-01"],
      grants: [
        { subject: "ai-claude-01", capability: "mailbox.read.depth" },
        { subject: "platform-admin", capability: "role.grant" },
      ],
    });
    const report = await run(dir);
    expect({ code: report.code, said: report.said.includes("no grant names a subject that does not exist") })
      .toEqual({ code: 0, said: true });
  }, 60_000);

  test("a web user counts as somebody, even with no local account", async () => {
    // The table the rename used to miss: the row that regrows these grants
    // every start is a real subject while it exists, not an orphan.
    const dir = deployment({
      webUsers: ["admin"],
      localUsers: ["platform-admin"],
      grants: [{ subject: "admin", capability: "usage.read" }],
    });
    expect((await run(dir)).code).toBe(0);
  }, 60_000);

  test("a registry row counts too", async () => {
    const dir = deployment({
      registry: ["console-agent"],
      grants: [{ subject: "console-agent", capability: "usage.read" }],
    });
    expect((await run(dir)).code).toBe(0);
  }, 60_000);
});

describe("repairing", () => {
  test("removes exactly the rows it named, and leaves the rest", async () => {
    const dir = deployment({
      localUsers: ["platform-admin"],
      agents: ["ai-claude-01"],
      grants: [
        { subject: "platform-admin", capability: "usage.read" },
        { subject: "ai-claude-01", capability: "mailbox.read.depth" },
        { subject: "admin", capability: "usage.read" },
        { subject: "admin", capability: "role.grant" },
      ],
    });
    const done = await run(dir, "--repair");
    expect(done.code).toBe(0);
    expect(done.said).toContain("removed 2 row(s)");
    expect(subjects(dir)).toEqual(["ai-claude-01", "platform-admin"]);
  }, 60_000);

  test("says that a repair alone does not keep them gone", async () => {
    // The boot re-grants the full set to every administrator name, so a
    // deployment still carrying the old name elsewhere writes these again on
    // its next start. A repair that did not say so would read as a fix.
    const dir = deployment({ localUsers: ["platform-admin"], grants: [{ subject: "admin", capability: "usage.read" }] });
    const done = await run(dir, "--repair");
    expect(done.said).toContain("the next start writes these again");
  }, 60_000);

  test("refuses to guess which deployment it is pointed at", async () => {
    const ran = await runChild(["bun", REPAIR], { env: { ...process.env, AGENT_MESH_STATE_DIR: "" } });
    expect({ code: ran.code, complained: ran.stderr.includes("will not guess") }).toEqual({ code: 2, complained: true });
  }, 60_000);
});

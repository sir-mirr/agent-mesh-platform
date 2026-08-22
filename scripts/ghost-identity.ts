#!/usr/bin/env bun
/**
 * What a name still holds, and removing a mesh row that holds nothing.
 *
 *   bun scripts/ghost-identity.ts platform-admin            # report only
 *   bun scripts/ghost-identity.ts platform-admin --remove   # remove, if it is empty
 *
 * **The state this exists for.** `renameSeededAdmin` moves `admin` to
 * `platform-admin` once at boot, and `renameLocalAccount` refuses when both
 * names hold rows in the same table — a rule that is right, because two
 * accounts under one meaning is worse than an old name. A boot that crashed
 * part-way (`46a2914`) left an `agents.identity` row under the *new* name with
 * no `local_users` account behind it, so the rename has refused
 * `name_taken (agents.identity)` on every boot since and the deployment cannot
 * finish what that boot began. Nobody can sign in as the ghost either: sign-in
 * reads `local_users`, and there is no row.
 *
 * **It removes one row and only when nothing points at it.** A name holding
 * keys, ownership, group membership, grants, a pairing code or a registry entry
 * is not a ghost — it is an identity, and one of them being seeded by accident
 * is not something this can tell from here. So the check is every table
 * `rename-account.ts` knows about, and anything found is printed and refused.
 * Reporting is the default; `--remove` is the verb.
 *
 * Out of process, and **not** safe to run while http is mid-boot: the rename it
 * unblocks happens in `startup()`. Stop the service, run this, start it.
 */

import { join } from "node:path";

import { openAt, openStore, stateDir } from "@agent-mesh/store";
import type { Database } from "bun:sqlite";

/** Where a name can appear, and which database holds it. */
export const MESH_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["role_grants", "subject"],
  ["agent_owners", "owner"],
  ["agent_owners", "identity"],
  ["agent_group_members", "identity"],
  ["agent_keys", "identity"],
  ["pairing_codes", "identity"],
];

export const LOCAL_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["agent_registry", "id"],
  ["policies", "github_login"],
  ["push_subscriptions", "github_login"],
  ["local_users", "username"],
];

/** How many rows `column` in `table` holds under `name`, or null when absent. */
export function held(db: Database, table: string, column: string, name: string): number | null {
  // `PRAGMA table_info` answers nothing for a table that is not there, which is
  // the check — these databases are owned by other processes' DDL, and a
  // missing table is a version difference rather than an error.
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) return null;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(name) as
    | { n: number }
    | null;
  return row?.n ?? 0;
}

export interface GhostReport {
  /** `true` when `agents.identity` holds the name. */
  meshRow: boolean;
  /** Everything else that names it, table.column to row count. Empty is a ghost. */
  attachments: Record<string, number>;
  /** What was done: nothing, or the row removed. */
  removed: boolean;
}

/**
 * Look, and remove only what is provably unattached.
 *
 * The databases are parameters because the two callers are a person with a
 * state directory and a test with two temporary files — and because a repair
 * that can only be exercised against a real deployment is one nobody exercises.
 */
export function inspectGhost(
  name: string,
  mesh: Database,
  local: Database,
  options: { remove?: boolean } = {},
): GhostReport {
  const attachments: Record<string, number> = {};
  for (const [db, tables] of [[mesh, MESH_TABLES], [local, LOCAL_TABLES]] as const) {
    for (const [table, column] of tables) {
      const n = held(db, table, column, name);
      if (n) attachments[`${table}.${column}`] = n;
    }
  }

  const meshRow = (held(mesh, "agents", "identity", name) ?? 0) > 0;
  const removable = meshRow && Object.keys(attachments).length === 0;
  if (options.remove && removable) {
    mesh.prepare(`DELETE FROM agents WHERE identity = ?`).run(name);
    return { meshRow, attachments, removed: true };
  }
  return { meshRow, attachments, removed: false };
}

/** The command, with its output as a value so a test can read it. */
export function runGhostIdentity(argv: string[], databases?: { mesh: Database; local: Database }): {
  code: number;
  lines: string[];
} {
  const lines: string[] = [];
  const say = (line: string) => { lines.push(line); };

  const remove = argv.includes("--remove");
  const name = argv.find((a) => !a.startsWith("--"));
  if (!name) {
    say("usage: bun scripts/ghost-identity.ts <identity> [--remove]");
    return { code: 2, lines };
  }

  const opened = databases ?? {
    mesh: openStore("agents"),
    local: openAt(join(stateDir(), "agent-mesh.db")),
  };
  const report = inspectGhost(name, opened.mesh, opened.local, { remove });

  if (!report.meshRow) {
    say(`${name}: no agents.identity row — nothing here is blocking a rename`);
    return { code: 0, lines };
  }
  const attached = Object.entries(report.attachments);
  if (attached.length > 0) {
    say(`${name}: an identity, not a ghost — refusing to remove it`);
    for (const [where, n] of attached) say(`  ${where}: ${n}`);
    return { code: 1, lines };
  }
  if (!remove) {
    say(`${name}: an agents.identity row and nothing else — a ghost`);
    say(`  re-run with --remove to delete it, with the http service stopped`);
    return { code: 0, lines };
  }
  say(`${name}: removed the agents.identity row it held and nothing else`);
  return { code: 0, lines };
}

if (import.meta.main) {
  const { code, lines } = runGhostIdentity(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}

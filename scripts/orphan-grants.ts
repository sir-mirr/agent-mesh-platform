#!/usr/bin/env bun
/**
 * Grants whose subject is nobody.
 *
 * ## The failure this exists for
 *
 * The owner noticed two screens disagreeing: the account-permissions page
 * listed `admin`, the local-accounts page did not. `agent-mesh-local-pm`
 * measured it — `/api/v1/admin/users` held only `platform-admin`, while
 * `/api/v1/admin/grants` still carried twelve rows for subject `admin`, the
 * same twelve the renamed account holds.
 *
 * They were dead rows: no account answers to that name, so nothing could
 * exercise them. They were also a loaded gun. Admit an account called `admin`
 * later and it inherits the full administrator set on sight, granted by
 * nobody, for a reason no longer written down anywhere.
 *
 * The rename that left them is fixed in `rename-account.ts` — it moves the web
 * `users` row now, not only `local_users`. This is the other half: an
 * installation that already carries the rows, where the repaired rename cannot
 * help. Both names are present in `role_grants`, which that rename reads as a
 * clash and refuses, exactly as it should.
 *
 * ## A subject is not always an account
 *
 * Capabilities are granted to agents too, so "no account by that name" is not
 * the test. A subject is an orphan only when nothing at all answers to it: no
 * local account, no web user, no mesh identity, no registry row. Anything less
 * careful deletes an agent's permissions, and the audit record for why they
 * existed is the grant row itself.
 *
 * ## It reports unless told to repair
 *
 * Deleting rows out of a live deployment is not a thing to do by default, and
 * the report is the part somebody else can check.
 *
 *   bun scripts/orphan-grants.ts --state-dir /path/to/state
 *   bun scripts/orphan-grants.ts --state-dir /path/to/state --repair
 */

export {};

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(name);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

const stateDir = flag("--state-dir") ?? process.env.AGENT_MESH_STATE_DIR;
const repair = argv.includes("--repair");

if (!stateDir) {
  console.error(
    "no state directory: pass --state-dir <path> or set AGENT_MESH_STATE_DIR.\n" +
      "This reads two databases and will not guess which deployment you mean.",
  );
  process.exit(2);
}

const agentsPath = join(stateDir, "agents.db");
const localPath = join(stateDir, "agent-mesh.db");
for (const path of [agentsPath, localPath]) {
  if (!existsSync(path)) {
    console.error(`no database at ${path}`);
    process.exit(2);
  }
}

/** Read-only unless repairing: a report must not be able to change anything. */
// `{ readonly: false }` is not "open for writing" to bun — it is a flag set
// with neither bit, and it throws SQLITE_MISUSE. The two cases are spelled out.
const agents = repair
  ? new Database(agentsPath, { readwrite: true })
  : new Database(agentsPath, { readonly: true });
const local = new Database(localPath, { readonly: true });

const column = (db: Database, sql: string): string[] => {
  try {
    return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  } catch {
    // A table this deployment does not have contributes no names. Absent is not
    // the same as empty, but for "does anything answer to this?" it is.
    return [];
  }
};

const answers = new Set<string>([
  ...column(local, `SELECT username FROM local_users`),
  ...column(local, `SELECT github_login FROM users`),
  ...column(local, `SELECT id FROM agent_registry`),
  ...column(agents, `SELECT identity FROM agents`),
]);

const rows = agents
  .prepare(`SELECT tenant, subject, capability, scope, granted_by FROM role_grants ORDER BY subject, capability`)
  .all() as Array<{ tenant: string; subject: string; capability: string; scope: string; granted_by: string }>;

const orphans = rows.filter((r) => !answers.has(r.subject));
const bySubject = new Map<string, typeof orphans>();
for (const row of orphans) {
  const held = bySubject.get(row.subject) ?? [];
  held.push(row);
  bySubject.set(row.subject, held);
}

console.log(`${rows.length} grants, ${answers.size} names that something answers to.`);
if (orphans.length === 0) {
  console.log("no grant names a subject that does not exist.");
  process.exit(0);
}

for (const [subject, held] of bySubject) {
  console.log(`\n${subject} — ${held.length} grant(s), granted by ${[...new Set(held.map((r) => r.granted_by))].join(", ")}`);
  for (const row of held) console.log(`  ${row.capability} (${row.scope})`);
}

if (!repair) {
  console.log(`\n${orphans.length} row(s) name a subject nothing answers to. Re-run with --repair to remove them.`);
  process.exit(1);
}

const remove = agents.prepare(
  `DELETE FROM role_grants WHERE tenant = ? AND subject = ? AND capability = ? AND scope = ?`,
);
let removed = 0;
const tx = agents.transaction(() => {
  for (const row of orphans) removed += remove.run(row.tenant, row.subject, row.capability, row.scope).changes;
});
tx();
console.log(`\nremoved ${removed} row(s).`);
// The rename is what stops them coming back; a repair alone would hold only
// until the next start, because the boot re-grants to every administrator name.
console.log("If a renamed account is still carrying an old name elsewhere, fix that too — otherwise the next start writes these again.");

/**
 * Renaming a local account, and every live reference to it (T-026).
 *
 * **The identity is the address**, which is what makes this more than an
 * `UPDATE` on one column. A local account's username is written into the
 * registry that says who can be addressed from the console, into the grants
 * that decide what they may do, into the ownership rows that say which agents
 * are theirs, and into the group membership that decides who they may send to.
 * A rename that moved only `local_users` would leave an operator who could
 * still sign in and could do nothing, with every screen answering `403` and
 * nothing anywhere saying why.
 *
 * ## What moves, and what deliberately does not
 *
 * Live references move: they name *this account* and have to keep naming it.
 *
 * **History does not.** `messages`, the hub's `message_stats` and the audit
 * record are accounts of things that happened, and what happened is that
 * `admin` sent that message. Rewriting them would make the record say
 * something nobody did — and the audit record is the one thing on this server
 * whose value is that it was not edited afterwards. The cost is real and is
 * the smaller one: a conversation from before the rename lists the old name.
 *
 * ## Two databases, two transactions
 *
 * `agent-mesh.db` and `agents.db` are separate files (SPEC § 3.1), so there is
 * no transaction across both. Each half is atomic; a crash between them leaves
 * the account renamed in one and not the other. Ordered so that the survivable
 * half fails first: the mesh-side rows are moved before `local_users`, because
 * grants naming an account that still has its old username are recoverable by
 * running this again, while an account renamed with its grants left behind
 * cannot sign in to fix itself.
 */

import type { Database } from 'bun:sqlite'

import { getDb, getLocalUser } from './db'
import { agentsDb } from './keys-admin'

/** Where a username is a live reference, by database. Order matters — see the note above. */
const MESH_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  ['role_grants', 'subject'],
  ['agent_owners', 'owner'],
  ['agent_owners', 'identity'],
  ['agent_group_members', 'identity'],
  ['agents', 'identity'],
  ['agent_keys', 'identity'],
  ['pairing_codes', 'identity'],
]

const LOCAL_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  ['agent_registry', 'id'],
  ['policies', 'github_login'],
  ['push_subscriptions', 'github_login'],
  ['local_users', 'username'],
]

/**
 * `reason` is spelled the way a counter key has to be — lower snake, no
 * hyphens — because the refusal is logged and `docs/LOGGING-OPS.md`'s rule is
 * that every reason a service logs is one a counter can key on. Rewriting it at
 * the log call was the first version, and `test/logging-ops.test.ts` reads the
 * source rather than the value: an expression there counts as unbounded.
 */
export type RenameOutcome =
  | { ok: true; moved: Record<string, number> }
  | { ok: false; reason: 'no_such_account' | 'name_taken' }

/**
 * Move `from` to `to` everywhere the name is a live reference.
 *
 * `moved` counts rows per `table.column`, so a caller can log what actually
 * happened rather than that something did. A table that does not exist in this
 * deployment is skipped rather than fatal: `pairing_codes` and `agent_keys` are
 * the hub's, and this service can be started against a database written before
 * either existed.
 */
export function renameLocalAccount(
  from: string,
  to: string,
  db: Database = getDb(),
  mesh: Database = agentsDb(),
): RenameOutcome {
  if (!getLocalUser(from)) return { ok: false, reason: 'no_such_account' }
  // Taken by an account or by a registry row. Both are the same namespace: a
  // registry id is what a message is addressed to, and two rows answering to
  // one name is the state this whole module exists to avoid creating.
  if (getLocalUser(to)) return { ok: false, reason: 'name_taken' }
  const takenInRegistry = db.prepare(`SELECT 1 FROM agent_registry WHERE id = ?`).get(to)
  if (takenInRegistry) return { ok: false, reason: 'name_taken' }

  const moved: Record<string, number> = {}
  const move = (handle: Database, table: string, column: string) => {
    // `PRAGMA table_info` answers nothing for a table that is not there, which
    // is the check: this service opens databases other processes own the DDL of.
    const columns = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === column)) return
    const { changes } = handle
      .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
      .run(to, from)
    if (changes > 0) moved[`${table}.${column}`] = changes
  }

  mesh.transaction(() => {
    for (const [table, column] of MESH_REFERENCES) move(mesh, table, column)
  })()
  db.transaction(() => {
    for (const [table, column] of LOCAL_REFERENCES) move(db, table, column)
  })()

  return { ok: true, moved }
}

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
  | { ok: false; reason: 'no_such_account' | 'name_taken' | 'write_failed'; blocked_by?: string }

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

  /** Whether `column` in `table` holds any row under `name`. */
  const present = (handle: Database, table: string, column: string, name: string): boolean => {
    // `PRAGMA table_info` answers nothing for a table that is not there, which
    // is the check: this service opens databases other processes own the DDL of.
    const columns = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === column)) return false
    return handle.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(name) !== null
  }

  /**
   * **Every table, not the two obvious ones — and the difference between a
   * clash and a resumption.**
   *
   * The first version checked `local_users` and `agent_registry` (the two
   * places a *person* is) and left the rest to the `UPDATE`s. `agents.identity`
   * is a primary key, so a deployment that already held a mesh row under the
   * new name met `UNIQUE constraint failed: agents.identity` from inside
   * `startup` and the http service **did not come up at all**.
   * `agent-mesh-local-pm` reproduced it on the running stack.
   * `role_grants`, `agent_owners` and `agent_group_members` are the same shape:
   * the name is part of a composite primary key.
   *
   * The two databases cannot share a transaction, so a rename can also stop
   * half-done — the mesh rows moved, the account not. That state looks exactly
   * like a clash from here and is the opposite of one: **the new name holding
   * rows the old name no longer has is this rename, already applied.** Skipping
   * those tables resumes it; refusing would strand the deployment on a boot
   * that can never finish what an earlier boot began.
   *
   * So, per table: both names present is a clash and refuses; only the new name
   * is a table already moved; only the old name is work to do.
   */
  const alreadyMoved = new Set<string>()
  for (const [handle, references] of [[mesh, MESH_REFERENCES], [db, LOCAL_REFERENCES]] as const) {
    for (const [table, column] of references) {
      if (!present(handle, table, column, to)) continue
      if (present(handle, table, column, from)) {
        return { ok: false, reason: 'name_taken', blocked_by: `${table}.${column}` }
      }
      alreadyMoved.add(`${table}.${column}`)
    }
  }

  const moved: Record<string, number> = {}
  const move = (handle: Database, table: string, column: string) => {
    if (alreadyMoved.has(`${table}.${column}`)) return
    const columns = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === column)) return
    const { changes } = handle
      .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
      .run(to, from)
    if (changes > 0) moved[`${table}.${column}`] = changes
  }

  // **A migration must not take the service down.** The refusals above are the
  // collisions this knows how to name; a constraint nobody anticipated is still
  // a database saying no, and the answer to that is an account keeping its old
  // name and a log line — not a process that fails to start, which is how this
  // reached a running deployment. The transaction rolls back on the way out, so
  // a half-renamed account is not one of the outcomes.
  try {
    mesh.transaction(() => {
      for (const [table, column] of MESH_REFERENCES) move(mesh, table, column)
    })()
    db.transaction(() => {
      for (const [table, column] of LOCAL_REFERENCES) move(db, table, column)
    })()
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  return { ok: true, moved }
}

import { updateMessageStatus } from './db'
import { log } from "./log"

/** How the row is corrected. Injected so the miss can be reached without breaking a database. */
export type StatusWriter = (id: string, status: string) => boolean

/**
 * Mark a message the hub never accepted as `failed`, and say so when the
 * correction applies to nothing.
 *
 * **Written back, not only corrected in memory.** The response and the SSE
 * frames are built from an in-memory object; the history route, the
 * conversation view and search all serve the stored row. Correcting one and
 * not the other told the caller the truth once and every later reader
 * otherwise — a message that never left this machine, reported for ever as one
 * still waiting for its recipient.
 *
 * The row is inserted moments earlier in the same handler, so a miss means the
 * insert did not take. That is worth saying out loud rather than leaving a
 * correction that quietly applied to nothing — and it is why the writer is a
 * parameter: reaching the miss otherwise means breaking the messages table
 * underneath a live handler, which is a harsher thing to arrange than it is to
 * observe.
 */
export function markSendFailed(id: string, update: StatusWriter = updateMessageStatus): boolean {
  if (update(id, 'failed')) return true
  log.error("could not mark a refused message failed: no such row", "send_failure_unrecorded", {
    id,
    outcome: "failed",
    reason: "no_such_row",
  })
  return false
}

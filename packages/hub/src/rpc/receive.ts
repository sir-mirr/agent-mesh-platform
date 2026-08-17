/**
 * `mesh.receive` — drain what is waiting for the caller (SPEC § 8.10.1).
 *
 * Delivery had always been push-only: the hub replays pending messages when an
 * identity connects and pushes new ones while it stays connected. That assumes
 * a participant which can hold a socket, and some cannot — an agent driven by an
 * application is awake only while answering, and has nowhere to be pushed to in
 * between.
 *
 * This is the pull half of the same queue, not a second store. The rows an
 * adapter would be handed on connect are the rows this returns.
 *
 * **At-least-once, acknowledged on the next call.** Three designs were
 * available and two of them lose:
 *
 * - A destructive read discards whatever the caller did not survive to persist.
 *   A turn can end between the response arriving and anything being written.
 * - A separate acknowledgement costs a round trip and opens a window: a message
 *   arriving between read and ack is cleared by an ack that predates it.
 * - Carrying the previous batch's ids on the *next* fetch has neither. One
 *   call, one transaction, and anything unacknowledged comes back.
 *
 * The cost is duplicates, and that is the right way round: a duplicate is
 * visible and cheap to handle against a stable id, a loss is neither.
 */

import { MAILBOX_CAPABILITY_DEFAULTS } from "@agent-mesh/contracts";

import { recordDelivered } from "./audit";
import {
  db,
  stmtMessageById,
  stmtAckMessage,
  stmtCountLeasable,
  stmtLeasableMessages,
  stmtLeaseMessage,
} from "../db";
import { INVALID_PARAMS, rpcError, rpcResult } from "../jsonrpc";

const DEFAULT_LIMIT = 50;

/**
 * How long a handed-out batch stays invisible (SPEC § 8.10.1).
 *
 * The contract's value unless a deployment overrides it. The tension is a turn
 * that dies mid-batch: too short and a working caller is handed messages it is
 * still on, too long and a caller that crashed waits that long for anything to
 * be re-offered. Both are survivable because ids are stable, so this is a
 * comfort setting rather than a correctness one — which is exactly why it is
 * adjustable rather than compiled in.
 */
/**
 * Exported because `/api/v1/capabilities` advertises it, and for a while it
 * advertised the *constant* instead — so a deployment that shortened the lease
 * told every client it had not. Nothing failed: ids are stable and the messages
 * still came back, the caller just re-polled on a cadence the hub had not asked
 * for. A defect with no symptom is one that stays.
 *
 * One binding, two readers. The alternative — each side reading the environment
 * — is what produced the divergence.
 */
export const LEASE_SECONDS = Number(
  process.env.AGENT_MESH_RECEIVE_LEASE_SECONDS ?? MAILBOX_CAPABILITY_DEFAULTS.receive_lease_seconds,
);

export function handleReceive(
  identity: string | null,
  params: Record<string, any>,
  id: string | number | null | undefined,
): string {
  if (!identity) {
    return rpcError(id, INVALID_PARAMS, "no identity: mesh.receive requires a signed request");
  }

  const limit = Math.min(
    Math.max(parseInt(params.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
    MAILBOX_CAPABILITY_DEFAULTS.max_receive_batch,
  );

  const ackIds: string[] = Array.isArray(params.ack_ids)
    ? params.ack_ids.filter((x: unknown) => typeof x === "string")
    : [];

  let page: any[] = [];
  let remaining = 0;

  // One transaction. The acknowledgement of the last batch and the lease of the
  // next are the same act, so there is no instant at which a caller has settled
  // one and not yet claimed the other.
  const tx = db.transaction(() => {
    // Scoped to the caller's own queue, and ids it does not hold are ignored
    // rather than refused: a caller retrying an ambiguous receive re-sends the
    // same acknowledgements, and failing that retry would strand the very batch
    // it is trying to settle.
    for (const messageId of ackIds) {
      // Recorded on acknowledgement rather than on hand-out, because that is
      // when it is true: a leased batch may be redelivered, and recording each
      // attempt would put several `delivered` events behind one message
      // (§ 8.9.4). `changes` is what says the caller actually held it.
      const settled = stmtAckMessage.run(messageId, identity);
      if (settled.changes > 0) {
        const row = stmtMessageById.get(messageId) as any;
        if (row) recordDelivered(row);
      }
    }

    page = stmtLeasableMessages.all(identity, limit) as any[];
    for (const m of page) {
      stmtLeaseMessage.run(m.id, LEASE_SECONDS);
    }
    remaining = (stmtCountLeasable.get(identity) as { n: number }).n;
  });
  tx();

  return rpcResult(id, {
    messages: page.map((m) => ({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      sent_by: m.sent_by,
      content: m.content,
      reply_to: m.reply_to,
      ts: m.ts,
    })),
    // Counted after the lease, so it excludes what was just handed out.
    remaining,
    // So a caller knows how long it has before these are offered again, and can
    // decide whether to acknowledge now or keep working.
    lease_seconds: LEASE_SECONDS,
  });
}

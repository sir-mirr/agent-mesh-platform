/**
 * Store and forward at the edge of the mesh.
 *
 * **Nothing here knows the hub exists**, and `test/mailbox-boundary.test.ts`
 * refuses an import that would change that. The reasoning is in
 * `docs/decisions/mailbox-and-hub.md`: mail has to be accepted while the hub is
 * down, because that window is the reason store-and-forward exists at all.
 *
 * The hub is a *caller* — it pulls for identities it currently holds a lane for
 * and delivers on this package's behalf. That makes it an optimisation on the
 * wait rather than something a conversation depends on.
 */

export { accept } from "./accept";
export { channelOf, replyChannel } from "./channel";
export type { Channel, ReplyRoutingInput } from "./channel";
export type { AcceptOptions, AcceptStatements, AcceptedStatus } from "./accept";
export { receive } from "./receive";
export type {
  MailboxMessage,
  MailboxStatements,
  ReceiveOptions,
  ReceiveResult,
} from "./receive";

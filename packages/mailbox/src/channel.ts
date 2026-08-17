/**
 * Which way a reply goes (SPEC § 8.2a).
 *
 * A reply names the original sender as its recipient, which is ordinary. The
 * question is which *channel* carries it, and the answer is not "whichever is
 * faster right now".
 *
 * **A reply goes back the way the thing it answers arrived.** The channel is a
 * property of the conversation rather than of the moment: a correspondent who
 * reads mail once an hour should not receive half a thread on a socket they
 * were briefly holding, and then have to find the other half.
 *
 * **Unless both ends are live**, in which case the mesh carries it. That is the
 * only condition under which the mailbox adds latency and nothing else — one
 * end present is not enough, because the absent one is exactly who the mailbox
 * is for.
 *
 * ## Why the decision lives here, and presence does not
 *
 * The rule is the mailbox's; the *inputs* are the hub's. `bothLive` arrives
 * already answered, because answering it means reading presence — see
 * `docs/decisions/mailbox-and-hub.md`. A function here that could ask would make
 * this package depend on the hub, and the boundary is the point.
 *
 * ## Why it is decided at send time
 *
 * Not written onto the conversation when it starts. A channel recorded once goes
 * stale the moment either side reconnects or drops, and then a thread routes by
 * a fact about a socket that closed an hour ago. Evaluated per send, it follows
 * presence.
 */

/** The transport a message was accepted through, recorded on the row (§ 8.2a). */
export type Channel = "mesh" | "mailbox";

/**
 * Rows written before `via` existed carry null.
 *
 * Read as `mesh`, because that is what those deployments had: the socketless
 * transport arrived with the column. Treating them as `mailbox` would reroute
 * live conversations on upgrade, which is a visible change nobody asked for.
 */
export function channelOf(via: string | null | undefined): Channel {
  return via === "mailbox" ? "mailbox" : "mesh";
}

export interface ReplyRoutingInput {
  /** The channel the message being answered came in on, or null for a fresh send. */
  inReplyToVia?: string | null;
  /** Does the recipient hold a lane right now? The hub's answer. */
  recipientLive: boolean;
  /** Does the sender? Only the reply rule needs this. */
  senderLive: boolean;
}

/**
 * Where this send should go.
 *
 * **The both-live condition applies to replies and to nothing else.** The first
 * version of this applied it to every send, and two tests said so immediately:
 * a mailbox participant sending to an agent holding a socket stopped being
 * delivered, which is a behaviour nobody asked to change and which the mailbox
 * transport was built to have.
 *
 * A send that answers nothing has no conversation to respect. It takes the mesh
 * whenever the recipient is there — the rule that predates this one.
 */
export function replyChannel(input: ReplyRoutingInput): Channel {
  const isReply = input.inReplyToVia !== undefined && input.inReplyToVia !== null;
  if (!isReply) return input.recipientLive ? "mesh" : "mailbox";

  // Answering something that came over the mesh: it goes back over the mesh
  // when there is a mesh to use.
  if (channelOf(input.inReplyToVia) === "mesh") {
    return input.recipientLive ? "mesh" : "mailbox";
  }

  // Answering mail. Only both-present takes the mesh; one present is exactly
  // the case the mailbox exists for, and half a thread on a socket somebody was
  // briefly holding is the outcome this refuses.
  return input.recipientLive && input.senderLive ? "mesh" : "mailbox";
}

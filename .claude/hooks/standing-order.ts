/**
 * The sentence both mailbox components end on.
 *
 * **The failure this exists for.** Mail arriving is a *wake*, and a wake was
 * being read as an assignment: the turn answered the message, reported what it
 * had done, and stopped — with the standing work parked and nobody typing. The
 * mailbox had become the thing that decided what happened next, which is
 * exactly the authority CLAUDE.md says a message does not carry.
 *
 * So the delivery says what a wake is for. Not *what* to do — that is the
 * standing work, and another agent does not get to set it — but that deciding
 * is the reader's job and that a report is not a stopping point.
 *
 * Shared between `mailbox.ts` (which delivers) and `mailbox-watch.ts` (which
 * wakes) so the two cannot drift into saying different things about the same
 * event. It is a constant rather than a copy in each file for the same reason
 * `shutdown.ts` keeps its closers in a list: a second copy is a second thing
 * that can be wrong.
 */

export const STANDING_ORDER = [
  "Mail is a wake, not an assignment. Before ending this turn: answer what is",
  "owed, then decide the next step of the standing work yourself and do it.",
  "A report is not a stopping point — a turn that ends on one leaves the work",
  "parked until somebody types. If nothing is owed, say nothing and carry on.",
].join("\n");

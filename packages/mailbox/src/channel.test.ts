/**
 * Which way a reply goes (SPEC § 8.2a).
 *
 * The whole rule is a four-row table, so it is written out as one. A function
 * this small is exactly the kind that gets a test asserting the case somebody
 * happened to be thinking about, and the row that matters is usually the one
 * nobody wrote down.
 */

import { describe, expect, test } from "bun:test";
import { channelOf, replyChannel } from "./channel";

describe("channelOf", () => {
  test("only `mailbox` means mailbox", () => {
    expect(channelOf("mailbox")).toBe("mailbox");
    expect(channelOf("mesh")).toBe("mesh");
  });

  test("a row written before the column existed reads as mesh", () => {
    // Not `mailbox`. Those deployments had no socketless transport, so calling
    // them mail would reroute live conversations on upgrade — a visible change
    // nobody asked for, arriving as a side effect of adding a column.
    expect(channelOf(null)).toBe("mesh");
    expect(channelOf(undefined)).toBe("mesh");
  });

  test("anything unrecognised reads as mesh", () => {
    // Fail towards the behaviour that predates the rule. A value this does not
    // know is a value written by something this does not know, and holding a
    // conversation in the mailbox on that basis is the more surprising of the
    // two wrong answers.
    expect(channelOf("carrier-pigeon")).toBe("mesh");
  });
});

describe("a send that answers nothing", () => {
  // The rule is about replies and about nothing else. The first version applied
  // both-live to every send and immediately broke delivery from a mailbox
  // participant to an agent holding a socket — behaviour the socketless
  // transport was built to have, and which nobody asked to change.
  test("takes the mesh whenever the recipient is there", () => {
    expect(replyChannel({ recipientLive: true, senderLive: false })).toBe("mesh");
    expect(replyChannel({ inReplyToVia: null, recipientLive: true, senderLive: false })).toBe("mesh");
  });

  test("waits in the mailbox when the recipient is not", () => {
    expect(replyChannel({ recipientLive: false, senderLive: true })).toBe("mailbox");
  });
});

describe("a reply to something that came over the mesh", () => {
  test("goes back over the mesh when the recipient is there", () => {
    expect(replyChannel({ inReplyToVia: "mesh", recipientLive: true, senderLive: false })).toBe("mesh");
  });

  test("waits in the mailbox when they are not", () => {
    expect(replyChannel({ inReplyToVia: "mesh", recipientLive: false, senderLive: true })).toBe("mailbox");
  });
});

describe("a reply to mail", () => {
  test("takes the mesh only when both ends are live", () => {
    expect(replyChannel({ inReplyToVia: "mailbox", recipientLive: true, senderLive: true })).toBe("mesh");
  });

  test("stays in the mailbox when only the recipient is live", () => {
    // **The row the rule exists for.** Delivering here is what puts half a
    // thread on a socket the correspondent was briefly holding, leaving them to
    // find the rest somewhere else. One end present is precisely the case the
    // mailbox is for.
    expect(replyChannel({ inReplyToVia: "mailbox", recipientLive: true, senderLive: false })).toBe("mailbox");
  });

  test("stays in the mailbox when only the sender is live", () => {
    expect(replyChannel({ inReplyToVia: "mailbox", recipientLive: false, senderLive: true })).toBe("mailbox");
  });

  test("stays in the mailbox when neither is", () => {
    expect(replyChannel({ inReplyToVia: "mailbox", recipientLive: false, senderLive: false })).toBe("mailbox");
  });
});

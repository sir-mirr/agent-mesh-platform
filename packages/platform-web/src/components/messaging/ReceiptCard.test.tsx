/**
 * A receipt says what the server said about the send, and claims nothing else.
 *
 * This card used to draw two rows that no route on this platform produces: an
 * `Ed25519` badge and a `SHA-256` digest box. `signature_verified` exists in no
 * hub route, no http route, no store column, no contract and no SPEC section —
 * so the badge was red on every send, telling an operator a message had *failed*
 * verification when nothing had been verified at all, and the digest box fell
 * back to the *sender's* agent fingerprint, putting a real hash under a label
 * that called it this message's digest.
 *
 * A receipt nobody signed reads as *unsigned*, and a digest nobody checked reads
 * as *unchecked* — on this card that means the row is not there at all, which is
 * a different statement from a red badge saying the check ran and came back bad.
 * So most of what is pinned here is what the card must *not* say, plus the one
 * decision it does make: which of the server's status words gets which tone.
 *
 * **The absences are pinned by subtraction, not by a denylist.** Naming the
 * words a bad row would use — `signature`, `verified`, `sha-256` — only finds
 * the row in the spelling it had last time, and the row it had last time was
 * Korean, which an English denylist cannot see at all. So the card is measured
 * against what it is *allowed* to say: the four values the server gave it and
 * its own labels. Everything left over is a claim it invented, whatever script
 * it is written in and whatever shape it is drawn as.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { registerDom } from "../../register-dom";

// Conditional and never unregistered: bun runs every file's top level before any
// test, so a register/unregister pair here would take `document` away from
// whichever sibling file is mid-render.
registerDom();

const { render, cleanup } = await import("@testing-library/react");
const { ReceiptCard } = await import("./ReceiptCard.tsx");
const { StatusBadge } = await import("@/components/common/StatusBadge.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

/** The key `I18nProvider` reads once, when it mounts. happy-dom hands the whole
 *  run one `localStorage`, so a language left set here would decide what a
 *  sibling file's screen renders in — removed after every render, after every
 *  test, and again at the end. */
const LANG_KEY = "agent_mesh_lang";

afterEach(() => {
  cleanup();
  localStorage.removeItem(LANG_KEY);
});
afterAll(() => {
  localStorage.removeItem(LANG_KEY);
});

type Props = Parameters<typeof ReceiptCard>[0];

const en = (key: string) => DICTIONARY.en[key]!;
const ko = (key: string) => DICTIONARY.ko[key]!;

/** Rendered inside the provider with the language chosen the way the product
 *  chooses it — never by mocking the module, which has its own tests and whose
 *  mock would outlive this file's `afterAll` in a process-wide registry.
 *  A Korean literal in an assertion is what `SC-I18N-04` holds this tree to zero
 *  on, so the Korean side is read out of the dictionary instead. */
const cardIn = (lang: "en" | "ko", props: Props) => {
  localStorage.setItem(LANG_KEY, lang);
  try {
    return render(
      <I18nProvider>
        <ReceiptCard {...props} />
      </I18nProvider>,
    ).container;
  } finally {
    localStorage.removeItem(LANG_KEY);
  }
};

const card = (props: Props) => cardIn("en", props);

const SERVER: Omit<Props, "status"> = {
  messageId: "msg_01HZX9",
  sender: "agent-alpha",
  recipient: "agent-beta",
  timestamp: "2026-08-20T04:00:00.000Z",
};

/** Every badge on the card, found by the pill radius `StatusBadge` draws with
 *  rather than by position — a second badge appearing anywhere in the header is
 *  the shape the signature row had, and counting is how its return is caught. */
const badges = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("span")).filter(
    (s) => s.style.borderRadius === "var(--radius-full)",
  );

const badge = (c: HTMLElement) => {
  const found = badges(c);
  expect(found.length).toBe(1);
  return found[0]!;
};

/** The colour `StatusBadge` gives a named tone, read off `StatusBadge` itself:
 *  the decision under test is which tone `ReceiptCard` picks, not which hex the
 *  palette assigns it, and copying the hex here would pin the wrong half. */
const toneColor = (tone: "success" | "pending" | "danger" | "neutral") =>
  badge(render(<StatusBadge label="reference" status={tone} size="sm" />).container).style.color;

/** The colour the *card* draws for one of the server's words. Comparing two of
 *  these compares two decisions this component made; comparing two `toneColor`
 *  results compares two entries in another component's palette and can fail
 *  for no defect here at all. */
const drawnColor = (status: string) => {
  const colour = badge(card({ ...SERVER, status } as unknown as Props)).style.color;
  cleanup();
  return colour;
};

/** What the card said beyond what it was allowed to say. Longest pieces first,
 *  so removing a label cannot cut a sentence that contains it in half and leave
 *  the halves looking like invented text. */
const residue = (c: HTMLElement, allowed: readonly string[]) =>
  [...allowed]
    .filter((piece) => piece !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((text, piece) => text.split(piece).join(""), c.textContent ?? "");

/** Every text node under the card, separately. `textContent` glues a label to
 *  the value drawn beside it — `…f00d` followed by the `At` label reads as one
 *  longer hex run — and a value the card draws is always its own node. */
const textNodes = (c: HTMLElement): string[] => {
  const out: string[] = [];
  const walk = (n: Node) => {
    // 3 is a text node; spelled numerically because `Node` is a global that
    // exists only once happy-dom is registered.
    if (n.nodeType === 3) out.push(n.nodeValue ?? "");
    else n.childNodes.forEach(walk);
  };
  walk(c);
  return out;
};

/** Every hash-shaped run on the card, sorted. Long and hex-only, so the message
 *  id and the timestamp are not tokens; short enough that a truncated digest
 *  still is one. */
const hashesOn = (c: HTMLElement) =>
  textNodes(c)
    .flatMap((t) => t.match(/[0-9a-f]{12,}/gi) ?? [])
    .sort();

/** The value drawn *under a given label*, not merely somewhere on the card.
 *  `From` and `To` hold the same kind of string, so a card that has both
 *  identities on it satisfies `toContain` whichever way round they are printed;
 *  the shortest element whose text opens with the label is the cell itself. */
const fieldAfter = (c: HTMLElement, label: string): string | null => {
  const cells = Array.from(c.querySelectorAll("div"))
    .filter((d) => (d.textContent ?? "").startsWith(label))
    .sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
  const text = cells[0]?.textContent;
  return text === undefined ? null : text.slice(label.length);
};

const KNOWN = [
  ["pending", "receipt.pending"],
  ["delivered", "receipt.delivered"],
  ["read", "receipt.read"],
  ["failed", "receipt.failed"],
] as const;

describe("ReceiptCard", () => {
  it("repeats the server's own sentence for each status it knows", () => {
    for (const [status, key] of KNOWN) {
      // Exactly, not `toContain`: `pending` says the hub has it and the
      // recipient does not, which is a different statement from `delivered`,
      // and the two were once collapsed onto one lease word.
      expect(badge(cardIn("en", { ...SERVER, status })).textContent).toBe(en(key));
      cleanup();
      // The other half of the same claim, and the half a dictionary comparison
      // alone cannot make: four `t("receipt.…")` calls replaced by the very
      // English strings they resolve to satisfy the line above exactly, and
      // leave every Korean screen reading English. Only a second language can
      // tell a lookup from a literal.
      expect(badge(cardIn("ko", { ...SERVER, status })).textContent).toBe(ko(key));
      cleanup();
    }
  });

  it("keeps refused, waiting and delivered in three different colours", () => {
    // The defect these assertions exist for: `failed` used to be mapped onto
    // the lease vocabulary and drawn as `Available` in amber, so a message the
    // hub had *refused* looked like one it was still holding.
    const refused = drawnColor("failed");
    const waiting = drawnColor("pending");
    const delivered = drawnColor("delivered");
    const alsoRead = drawnColor("read");

    // Distinctness of the card's own three renders, asserted before the tone
    // names below so a collapse is reported here. Two `toneColor` values
    // compared with each other is a fact about the palette that no defect in
    // this component can disturb; two cards compared with each other goes red
    // the moment two of the server's words start looking alike on screen —
    // including the case where the palette itself stopped separating them.
    expect(
      new Set([refused, waiting, delivered]).size,
      "two of refused / waiting / delivered came out in the same colour",
    ).toBe(3);
    expect(refused).toBe(toneColor("danger"));
    cleanup();
    expect(waiting).toBe(toneColor("pending"));
    cleanup();
    expect(delivered).toBe(toneColor("success"));
    cleanup();
    // `read` is a delivery that also got opened, not a fifth kind of outcome.
    expect(alsoRead).toBe(delivered);
  });

  it("calls a word it does not know unknown, and does not call it failed", () => {
    const neutral = toneColor("neutral");
    cleanup();

    // `sent` is the word this component's props type used to declare and no
    // route on this platform has ever written. A status the screen cannot place
    // is a gap in the screen's knowledge, not a verdict about the message: it
    // must not borrow the red the hub's refusal owns. Pinning the tone to
    // `neutral` says that and says which tone it is; the `not.toBe(danger)`
    // that used to follow could only have failed if `StatusBadge` gave neutral
    // and danger one hex, which is not a defect this component can have.
    const c = card({ ...SERVER, status: "sent" } as unknown as Props);
    const shown = badge(c);
    expect(shown.style.color).toBe(neutral);
    expect(shown.textContent).toContain(en("receipt.unknown"));
    // And it says which word it could not place, so the operator can go and
    // read it in the response rather than guess what the screen swallowed.
    expect(shown.textContent).toContain("sent");
    expect(c.querySelector("[data-testid='receipt-card']")?.getAttribute("data-status")).toBe("sent");
  });

  it("makes no claim about a signature in any state", () => {
    for (const [status, key] of [...KNOWN, ["sent", null] as const]) {
      const c = card({ ...SERVER, status } as unknown as Props);
      const sentence = key === null ? [en("receipt.unknown"), "sent"] : [en(key)];
      // Subtraction rather than a denylist. The row that was here read
      // `Ed25519 …` in Korean and was red on every send, because nothing on
      // this platform ever signs a message — a screen reporting a verification
      // failure that never happened. A regex naming English words cannot see
      // that row; removing everything the card is entitled to say and demanding
      // that no letter or digit of any script is left sees it, and sees the
      // next invented row too, whatever it ends up being called.
      expect(
        residue(c, [
          ...sentence,
          SERVER.messageId,
          SERVER.sender,
          SERVER.recipient,
          SERVER.timestamp,
          en("receipt.from"),
          en("receipt.to"),
          en("receipt.at"),
        ]),
        `the ${status} card drew something the server never said`,
      ).not.toMatch(/[\p{L}\p{N}]/u);
      // Words are not the only shape an invented claim takes: a second pill
      // carrying one of the words above would survive the subtraction.
      expect(badges(c).length).toBe(1);
      cleanup();
    }
  });

  it("draws nothing for the signature and digest a stale caller still passes", () => {
    // Cast because the props type no longer admits these; the point of the test
    // is a caller that has not been updated, which the type cannot stop at run
    // time. Absent has to stay absent even when a value is handed over.
    const stale = {
      ...SERVER,
      status: "delivered",
      signatureVerified: false,
      sha256Digest: "9f2c1b7a6d3e4f508192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
      leaseStatus: "Available",
    } as unknown as Props;

    const asTheServerSaidIt = card({ ...SERVER, status: "delivered" }).innerHTML;
    cleanup();
    // Byte-identical markup, rather than a list of words the stale values must
    // not appear as. A component that starts honouring one of these props draws
    // *something* — a row, a pill, a title attribute, a colour — and only
    // comparing the whole rendering against the one the server's own fields
    // produce catches every one of those without naming any of them.
    expect(card(stale).innerHTML).toBe(asTheServerSaidIt);
  });

  it("does not repeat the sender's fingerprint as this message's digest", () => {
    // The exact borrowing that was there: the digest box had no digest to draw,
    // so it drew the sender's agent fingerprint under a label saying it was the
    // hash of this message. A real sha256 in the wrong row reads as evidence —
    // and so does the *recipient's* fingerprint, and so does a constant nobody
    // computed. So this counts hashes rather than looking for one string: the
    // card may show the two the server handed it, once each, and no others.
    const senderFingerprint = "b3a1d0c9e8f7605142330fedcba98765b3a1d0c9e8f7605142330fedcba98765";
    const recipientFingerprint = "77edcba0123456789abcdef0fedcba9876543210deadbeefcafef00dbaadf00d";
    const c = card({
      ...SERVER,
      sender: senderFingerprint,
      recipient: recipientFingerprint,
      status: "delivered",
    });
    expect(hashesOn(c)).toEqual([senderFingerprint, recipientFingerprint].sort());
  });

  it("puts the server's fields on the card and exposes them unformatted", () => {
    const c = card({ ...SERVER, status: "pending" });
    const root = c.querySelector("[data-testid='receipt-card']")!;
    expect(c.textContent).toContain("msg_01HZX9");
    // Under the right label, and with the server's own timestamp string rather
    // than one re-rendered through the browser's clock or locale — the earlier
    // card filled `At` from `new Date()`, which agrees with itself forever.
    expect(fieldAfter(c, `${en("receipt.from")}: `)).toBe("agent-alpha");
    expect(fieldAfter(c, `${en("receipt.to")}: `)).toBe("agent-beta");
    expect(fieldAfter(c, `${en("receipt.at")}: `)).toBe("2026-08-20T04:00:00.000Z");
    cleanup();
    // The same three cells with the language switched: labels typed into the
    // component as English literals draw the same card in both languages, and
    // `fieldAfter` then finds no cell opening with the dictionary's Korean
    // label at all. The values must still be the server's, unchanged by the
    // language — a locale that reformats a timestamp is the other half of the
    // `new Date()` defect above.
    const k = cardIn("ko", { ...SERVER, status: "pending" });
    expect(fieldAfter(k, `${ko("receipt.from")}: `)).toBe("agent-alpha");
    expect(fieldAfter(k, `${ko("receipt.to")}: `)).toBe("agent-beta");
    expect(fieldAfter(k, `${ko("receipt.at")}: `)).toBe("2026-08-20T04:00:00.000Z");
    // Attributes rather than colour or sentence: a check that wants to know what
    // this receipt is should read the id and the server's word, not infer them
    // from a badge whose text depends on the chosen language.
    expect(root.getAttribute("data-message-id")).toBe("msg_01HZX9");
    expect(root.getAttribute("data-status")).toBe("pending");
  });

  it("leaves a field the server did not fill blank instead of filling it in", () => {
    // The card once drew the caller's own inputs, the browser's clock and a
    // literal `no receipt issued` where the server's id belongs, so every send
    // produced a plausible-looking receipt containing nothing from the server.
    // Whatever it draws now for an empty field, it must not be a word: a
    // placeholder an operator compares by eye is worse than a blank.
    const c = card({ messageId: "", sender: "", recipient: "", timestamp: "", status: "delivered" });
    const withoutItsOwnLabels = residue(c, [
      en("receipt.delivered"),
      en("receipt.from"),
      en("receipt.to"),
      en("receipt.at"),
    ]);
    // Any letter or digit in any script — a Korean placeholder is the one this
    // card actually had, and an English-only assertion would have missed it.
    expect(withoutItsOwnLabels).not.toMatch(/[\p{L}\p{N}]/u);
    expect(c.querySelector("[data-testid='receipt-card']")?.getAttribute("data-message-id")).toBe("");
  });
});

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
 */
import { describe, it, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Conditional and never unregistered: bun runs every file's top level before any
// test, so a register/unregister pair here would take `document` away from
// whichever sibling file is mid-render.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup } = await import("@testing-library/react");
const { ReceiptCard } = await import("./ReceiptCard.tsx");
const { StatusBadge } = await import("@/components/common/StatusBadge.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

afterEach(cleanup);

type Props = Parameters<typeof ReceiptCard>[0];

const en = (key: string) => DICTIONARY.en[key]!;

/** Rendered inside the provider, so the words are the dictionary's English and
 *  not the Korean fallbacks compiled into the component — a Korean literal in
 *  an assertion is what `SC-I18N-04` holds this tree to zero on. */
const card = (props: Props) =>
  render(
    <I18nProvider>
      <ReceiptCard {...props} />
    </I18nProvider>,
  ).container;

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

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

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
      expect(badge(card({ ...SERVER, status })).textContent).toBe(en(key));
      cleanup();
    }
  });

  it("keeps refused, waiting and delivered in three different colours", () => {
    const danger = toneColor("danger");
    const pending = toneColor("pending");
    const success = toneColor("success");
    cleanup();

    // The defect these three assertions exist for: `failed` used to be mapped
    // onto the lease vocabulary and drawn as `Available` in amber, so a message
    // the hub had *refused* looked like one it was still holding.
    expect(badge(card({ ...SERVER, status: "failed" })).style.color).toBe(danger);
    cleanup();
    expect(badge(card({ ...SERVER, status: "pending" })).style.color).toBe(pending);
    cleanup();
    expect(badge(card({ ...SERVER, status: "delivered" })).style.color).toBe(success);
    cleanup();
    expect(badge(card({ ...SERVER, status: "read" })).style.color).toBe(success);
    expect(danger).not.toBe(pending);
  });

  it("calls a word it does not know unknown, and does not call it failed", () => {
    const danger = toneColor("danger");
    const neutral = toneColor("neutral");
    cleanup();

    // `sent` is the word this component's props type used to declare and no
    // route on this platform has ever written. A status the screen cannot place
    // is a gap in the screen's knowledge, not a verdict about the message: it
    // must not borrow the red the hub's refusal owns.
    const c = card({ ...SERVER, status: "sent" } as unknown as Props);
    const shown = badge(c);
    expect(shown.style.color).toBe(neutral);
    expect(shown.style.color).not.toBe(danger);
    expect(shown.textContent).toContain(en("receipt.unknown"));
    // And it says which word it could not place, so the operator can go and
    // read it in the response rather than guess what the screen swallowed.
    expect(shown.textContent).toContain("sent");
    expect(c.querySelector("[data-testid='receipt-card']")?.getAttribute("data-status")).toBe("sent");
  });

  it("makes no claim about a signature in any state", () => {
    for (const [status] of [...KNOWN, ["sent"] as const]) {
      const c = card({ ...SERVER, status } as unknown as Props);
      // One badge, and it is the status. A second badge is the shape the
      // `Ed25519 verified / unverified` row had, and that row was red on every
      // send because nothing on this platform ever signs a message — a screen
      // reporting a verification failure that never happened.
      expect(badges(c).length).toBe(1);
      expect(c.textContent).not.toMatch(/ed25519|signature|verified|unverified/i);
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

    const c = card(stale);
    expect(badges(c).length).toBe(1);
    expect(badge(c).textContent).toBe(en("receipt.delivered"));
    expect(c.textContent).not.toContain("9f2c1b7a");
    expect(c.textContent).not.toMatch(/sha-?256/i);
    expect(c.textContent).not.toContain("Available");
  });

  it("does not repeat the sender's fingerprint as this message's digest", () => {
    // The exact borrowing that was there: the digest box had no digest to draw,
    // so it drew the sender's agent fingerprint under a label saying it was the
    // hash of this message. A real sha256 in the wrong row reads as evidence.
    const fingerprint = "b3a1d0c9e8f7605142330fedcba98765b3a1d0c9e8f7605142330fedcba98765";
    const c = card({ ...SERVER, sender: fingerprint, status: "delivered" });
    expect(occurrences(c.textContent ?? "", fingerprint)).toBe(1);
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
    const withoutItsOwnLabels = [
      en("receipt.delivered"),
      en("receipt.from"),
      en("receipt.to"),
      en("receipt.at"),
    ].reduce((text, label) => text.split(label).join(""), c.textContent ?? "");
    // Any letter or digit in any script — a Korean placeholder is the one this
    // card actually had, and an English-only assertion would have missed it.
    expect(withoutItsOwnLabels).not.toMatch(/[\p{L}\p{N}]/u);
    expect(c.querySelector("[data-testid='receipt-card']")?.getAttribute("data-message-id")).toBe("");
  });
});

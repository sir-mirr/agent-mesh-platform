/**
 * A credential dialog, and the three things it must not blur.
 *
 * The code in this box is what an operator reads aloud or pastes into another
 * machine's terminal, so *no code yet*, *this code*, and *this code has run
 * out* have to be three different pictures. The failure this repository keeps
 * finding is the middle one drawn over the other two: a screen that renders a
 * confident, copyable command around a value that is not a credential — the
 * pairing analogue of a queue that says "nobody is waiting" about a backend
 * that never answered.
 *
 * Four globals are taken over rather than waited on: `Math.random`, so "a
 * different code each time" is an assertion about the component and not about
 * luck; the one-second `setInterval`, so five minutes of countdown costs no
 * wall-clock time; `navigator.clipboard`, which happy-dom does not give us a
 * readable one of; and the document's own address, so what the redeem command
 * points at can be compared against a literal instead of against the same
 * expression the component used to build it.
 *
 * **All four are installed per test and taken back per test**, which is the
 * same discipline `mock.module` needs here and for the same reason: bun runs
 * every file's top level before it runs any test, so a stub installed at the
 * top of this file would be live during every *other* file's tests too. A
 * swallowed one-second interval, a hijacked clipboard or a window left pointing
 * at some other host would surface as a failure in a file that never asked for
 * any of them — the shape of the seven failures that appeared only when two
 * files ran together. Only the 1000 ms interval is intercepted even so;
 * anything else still reaches the real timer, so React's own scheduling is
 * untouched.
 *
 * ## What a click cannot reach here
 *
 * React drops `onClick` for an element whose *props* say `disabled` — not its
 * attribute, its props — so a `fireEvent.click` on the approve or deny button
 * of a fingerprintless request never enters the component at all. Assertions
 * placed after such a click are inert in every implementation, and this file
 * used to carry two of them: both in-handler `if (request.fingerprint === null)
 * return;` guards could be deleted with all sixteen tests still green. What is
 * asserted instead is what a click can reach.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Type-only, so it is erased before the module graph is built and cannot run
// ahead of the registration below the way a value import would.
import type { PendingAgentRequest } from "./AgentPairingModal.tsx";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair here would
// pull `document` out from under whichever file happens to run alongside.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { AgentPairingModal } = await import("./AgentPairingModal.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

// ------------------------------------------------- globals, borrowed per test

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realRandom = Math.random;
const realClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

/** Live one-second ticks, keyed by the id we handed back for them. */
const armed = new Map<number, () => void>();
let nextTimerId = 0x1000;
let randomStep = 0;
const written: string[] = [];

const borrowGlobals = () => {
  armed.clear();
  randomStep = 0;
  written.length = 0;

  globalThis.setInterval = ((handler: unknown, delay?: number, ...rest: unknown[]) => {
    // Narrowed to the component's own tick. A blanket capture would also
    // swallow whatever the DOM implementation schedules, and firing those by
    // hand would make a countdown assertion depend on happy-dom internals.
    if (delay === 1000 && typeof handler === "function") {
      const id = nextTimerId++;
      armed.set(id, handler as () => void);
      return id;
    }
    return (realSetInterval as unknown as (...a: unknown[]) => unknown)(handler, delay, ...rest);
  }) as unknown as typeof globalThis.setInterval;

  globalThis.clearInterval = ((id?: unknown) => {
    if (typeof id === "number" && armed.delete(id)) return;
    (realClearInterval as unknown as (i?: unknown) => void)(id);
  }) as unknown as typeof globalThis.clearInterval;

  // Distinct, ordered, and non-repeating: the suffix is `1000 + r * 9000`, so
  // consecutive draws land 90 apart and "the same code twice" cannot be a
  // coincidence of the stub.
  Math.random = () => ((randomStep++ % 100) + 0.5) / 100;

  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } },
  });
};

const returnGlobals = () => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  Math.random = realRandom;
  if (realClipboard) Object.defineProperty(globalThis.navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(globalThis.navigator as unknown as object, "clipboard");
};

/**
 * The address the document was served from — a process-wide global exactly like
 * the timer and the clipboard, and given back for the same reason.
 */
const happy = (globalThis as unknown as { happyDOM?: { setURL?: (url: string) => void } }).happyDOM;
const ORIGINAL_HREF = globalThis.location.href;

/** Two hosts, neither of them anybody's machine, so an origin can be a literal. */
const FIRST_ORIGIN = "https://console.agent-mesh.example";
const SECOND_ORIGIN = "https://mesh.ops.example";

const servedFrom = (origin: string) => {
  // Loud rather than skipped: with no handle the window would stay where it
  // was, and the assertion downstream would then pass or fail for a reason that
  // has nothing to do with the component.
  if (typeof happy?.setURL !== "function") throw new Error("no handle on the document address");
  // A path, not a bare origin: a command built from the whole address would
  // carry `/agents/pending` into the route and post somewhere nothing serves.
  happy.setURL(`${origin}/agents/pending`);
};
const returnLocation = () => { happy?.setURL?.(ORIGINAL_HREF); };

/** Advance the displayed countdown by `n` seconds without spending any. */
const secondsPass = (n: number) => {
  for (let i = 0; i < n; i++) {
    // A snapshot per tick: the effect re-arms the interval on every change of
    // `ttl`, so the map is rewritten while we are walking it.
    const due = [...armed.values()];
    act(() => { for (const fire of due) fire(); });
  }
};

// `cleanup` first, so a component still mounted returns its interval through
// the stub that issued the id rather than to the real timer.
beforeEach(borrowGlobals);
afterEach(cleanup);
afterEach(returnGlobals);
afterEach(returnLocation);
// Belt and braces on the one global that outlives an `afterEach` failure: a
// window left on another host is not a failure in this file, it is a failure in
// whichever file bun happens to run next.
afterAll(returnLocation);

// ------------------------------------------------------------------ helpers

/**
 * Held apart from `REQUEST` so the positive control below can compare against a
 * `string`: `PendingAgentRequest.fingerprint` is `string | null`, and a `!` at
 * the assertion would be the test agreeing with itself about the one field it
 * is there to check.
 */
const FINGERPRINT = "sha256:0f1e2d3c";

const REQUEST: PendingAgentRequest = {
  id: "req-1",
  identity: "agt_billing_worker",
  name: "Billing worker",
  groupName: "finance",
  requestedAt: "2026-08-20T09:00:00.000Z",
  fingerprint: FINGERPRINT,
  status: "pending",
};

const show = (props: Record<string, unknown> = {}) =>
  render(
    <I18nProvider>
      <AgentPairingModal isOpen onClose={() => {}} request={REQUEST} {...props} />
    </I18nProvider>,
  );

/** The code as it stands on its own line, not as it appears inside the command. */
const codeOnDisplay = (c: HTMLElement): string | null => {
  const box = [...c.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && /^PAIR-\S+$/.test((d.textContent ?? "").trim()),
  );
  return box ? (box.textContent ?? "").trim() : null;
};

const redeemCommand = (c: HTMLElement): string | null => c.querySelector("pre code")?.textContent ?? null;

/**
 * The value under the fingerprint heading, which is where a stand-in hides.
 *
 * Throws for a missing field or a missing value element rather than returning
 * `""` for either, because "the screen shows a blank" and "the screen shows
 * nothing" are the two readings this whole file exists to keep apart.
 */
const fingerprintShown = (c: HTMLElement): string => {
  const field = [...c.querySelectorAll("div")].find(
    (d) => (d.textContent ?? "").startsWith(DICTIONARY.en["pair.fingerprint"]!),
  );
  if (!field) throw new Error("no fingerprint field rendered");
  const value = field.querySelector("code");
  if (!value) throw new Error("the fingerprint field renders no value element");
  return value.textContent ?? "";
};

const ttlBox = (c: HTMLElement): HTMLElement => {
  const span = [...c.querySelectorAll("span")].find(
    (s) => (s.textContent ?? "").includes(DICTIONARY.en["pair.ttl"]!),
  );
  if (!span) throw new Error("no countdown rendered");
  return span as HTMLElement;
};

const secondsLeft = (c: HTMLElement): string => ttlBox(c).querySelector("strong")?.textContent ?? "";

const button = (c: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...c.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  if (!found) throw new Error(`no button labelled ${label}`);
  return found as HTMLButtonElement;
};

const closedCopy = (
  <I18nProvider>
    <AgentPairingModal isOpen={false} onClose={() => {}} request={REQUEST} />
  </I18nProvider>
);

const openCopy = (
  <I18nProvider>
    <AgentPairingModal isOpen onClose={() => {}} request={REQUEST} />
  </I18nProvider>
);

const APPROVE = DICTIONARY.en["pairing.modal.approveAndBind"]!;
const DENY = DICTIONARY.en["common.reject"]!;
const CLOSE = DICTIONARY.en["common.close"]!;

describe("AgentPairingModal — before a code exists", () => {
  it("draws nothing at all when there is no request, rather than a dialog around a blank code", () => {
    // The alternative reading is the dangerous one: the body would render
    // `"code": ""` inside a curl line that looks exactly as copyable as a real
    // one. Nothing here is the only honest picture of "no credential yet".
    const before = randomStep;
    const { container } = show({ request: null });
    expect(container.textContent).toBe("");
    // And nothing is spent minting one. The mint effect is a hook, so it runs
    // even on the render that bails out — a guard that asked only whether the
    // dialog was open would draw a code for a request that does not exist.
    expect(randomStep).toBe(before);
  });

  it("mints no code and starts no clock for a dialog nobody opened", () => {
    const before = randomStep;
    show({ isOpen: false });
    // A code minted behind a closed dialog is a live credential with no one
    // watching its clock: the countdown does not run while closed, so it would
    // be handed over already stale.
    expect(randomStep).toBe(before);
    // And no tick is taken for it either. `container.textContent` was asserted
    // empty here and is gone: that emptiness is Modal's `if (!isOpen) return
    // null`, which holds for any mint effect at all, so it could not fail.
    expect(armed.size).toBe(0);
  });

  it("stops the clock it started when the dialog closes", () => {
    const { rerender } = show();
    // Asserted from both sides, so the zero below reads "given back" rather than
    // "never taken" — against a component that armed nothing, 0 then 0 would
    // pass and say nothing.
    expect(armed.size).toBe(1);
    rerender(closedCopy);
    // A closed dialog still counting is a clock nobody can read, and it is
    // counting for a code that can never be shown again: the next opening mints
    // a new one. That the body leaves the document is Modal's `if (!isOpen)
    // return null` rather than anything this component decides, so it is not
    // claimed here.
    expect(armed.size).toBe(0);
  });
});

describe("AgentPairingModal — the code it shows", () => {
  it("shows the same characters in the box and in the command that redeems them", () => {
    const { container } = show();
    const shown = codeOnDisplay(container);
    expect(shown).not.toBe(null);
    // Two renderings of one credential. If they ever diverge the operator reads
    // one aloud and pastes the other, and only one of the two can be redeemed.
    expect(redeemCommand(container)).toContain(shown!);
  });

  it("addresses the command at whichever origin served the page", () => {
    // These lines were pinned to one machine's own address, which named the
    // reader's laptop on a deployment and named the hub rather than the http
    // service everywhere. `config/env.ts` records the whole story.
    //
    // **Two origins, and both expectations are literals.** Writing the expected
    // string as `${window.location.origin}/api/...` is the module's own
    // expression, so it agrees with the module whichever way the module is
    // wrong — and in this DOM it evaluates to `"null"`, so that version passed
    // against a rendered `curl -X POST null/api/v1/pairing-codes/redeem`. One
    // literal would still let a hardcoded host through; a second origin is what
    // makes the command have to follow the page.
    servedFrom(FIRST_ORIGIN);
    const first = redeemCommand(show().container) ?? "";
    expect(first).toContain(`${FIRST_ORIGIN}/api/v1/pairing-codes/redeem`);

    cleanup();
    servedFrom(SECOND_ORIGIN);
    const second = redeemCommand(show().container) ?? "";
    expect(second).toContain(`${SECOND_ORIGIN}/api/v1/pairing-codes/redeem`);

    // The old address is not named here, even to assert its absence:
    // `greppable.test.ts` forbids a local address anywhere under platform-web
    // and reads this file too, so writing it out fails the very check this
    // assertion agrees with. That guard owns the absence; this one owns what
    // is there instead — and owns it against every wrong host rather than one.
  });

  it("mints a different code each time it is opened", () => {
    const { container, rerender } = show();
    const first = codeOnDisplay(container);
    rerender(closedCopy);
    rerender(openCopy);
    const second = codeOnDisplay(container);
    // "One-time" is the word on the label above this box (SPEC § 11.3: single
    // use). Re-showing the previous code would make the second dialog a promise
    // the redeem route cannot keep, and would say nothing about which of the
    // two openings spent it.
    expect(second).not.toBe(null);
    expect(second).not.toBe(first);
  });

  it("copies the code that is on the screen, and says it has", () => {
    const { container } = show();
    const shown = codeOnDisplay(container)!;
    const copy = button(container, "📋");
    fireEvent.click(copy);
    // The clipboard is the only part of this the operator cannot see. Copying
    // anything other than the displayed characters is invisible until redeem
    // fails on another machine.
    expect(written).toEqual([shown]);
    expect(copy.textContent).toContain(DICTIONARY.en["reg.copied"]!);
  });
});

describe("AgentPairingModal — the clock on the code", () => {
  it("counts down in whole seconds from the five minutes it grants", () => {
    const { container } = show();
    const unit = DICTIONARY.en["agents.unit.second"]!;
    expect(secondsLeft(container)).toBe(`300${unit}`);
    secondsPass(3);
    expect(secondsLeft(container)).toBe(`297${unit}`);
  });

  it("changes how the last minute reads, at the second it becomes the last minute", () => {
    const { container } = show();
    const calm = ttlBox(container).style.color;
    secondsPass(240);
    // Exactly 60 is still the calm colour, 59 is not: the boundary is asserted
    // from both sides so an off-by-one cannot hide behind "it turns red
    // eventually". This is the only warning the dialog gives before expiry.
    expect(secondsLeft(container)).toBe(`60${DICTIONARY.en["agents.unit.second"]!}`);
    expect(ttlBox(container).style.color).toBe(calm);
    secondsPass(1);
    expect(ttlBox(container).style.color).not.toBe(calm);
    expect(ttlBox(container).style.color).toContain("danger");
  });

  it("stops at zero instead of counting into negative seconds", () => {
    const { container } = show();
    const unit = DICTIONARY.en["agents.unit.second"]!;
    secondsPass(300);
    expect(secondsLeft(container)).toBe(`0${unit}`);
    secondsPass(5);
    // A countdown that runs past zero reads as a running clock, which is the
    // opposite of what it means. `-5s` under a credential is worse than `0s`
    // because it still looks alive. Pinned to the exact string; the `not
    // .toContain("-")` that used to follow was implied by it and could not fail.
    expect(secondsLeft(container)).toBe(`0${unit}`);
  });

  it("gives the fresh code a fresh five minutes when reopened", () => {
    const { container, rerender } = show();
    secondsPass(120);
    expect(secondsLeft(container)).toBe(`180${DICTIONARY.en["agents.unit.second"]!}`);
    rerender(closedCopy);
    rerender(openCopy);
    // The clock belongs to the code, not to the dialog. Carrying the previous
    // reading over would put a used-up countdown under a code that has its full
    // life ahead of it.
    expect(secondsLeft(container)).toBe(`300${DICTIONARY.en["agents.unit.second"]!}`);
  });
});

describe("AgentPairingModal — the decision", () => {
  it("hands approval the fingerprint, the identity and the code the operator was looking at", () => {
    const seen: unknown[][] = [];
    let closed = 0;
    const { container } = show({
      onApprove: (...args: unknown[]) => seen.push(args),
      onClose: () => { closed++; },
    });
    const shown = codeOnDisplay(container)!;
    fireEvent.click(button(container, APPROVE));
    // The third argument is the credential the operator is about to read out.
    // Approving with a freshly minted one instead would bind the agent to a
    // code nobody has, and the dialog would have lied about which it was.
    expect(seen).toEqual([[REQUEST.fingerprint, REQUEST.identity, shown]]);
    expect(closed).toBe(1);
  });

  it("hands refusal the fingerprint and the identity, approves nothing, and closes", () => {
    const denied: unknown[][] = [];
    const approved: unknown[][] = [];
    let closed = 0;
    const { container } = show({
      onDeny: (...args: unknown[]) => denied.push(args),
      onApprove: (...args: unknown[]) => approved.push(args),
      onClose: () => { closed++; },
    });
    fireEvent.click(button(container, DENY));
    expect(denied).toEqual([[REQUEST.fingerprint, REQUEST.identity]]);
    expect(approved).toEqual([]);
    // Refusal closes, the same as approval. Only approval used to be asserted
    // here, and dropping `onClose()` from the deny handler passed the whole
    // file: a dialog left standing after the decision has gone through reads as
    // a click that did not register, and the reflex is to click it again.
    expect(closed).toBe(1);
  });

  it("treats closing as neither answer", () => {
    const decisions: string[] = [];
    let closed = 0;
    const { container } = show({
      onApprove: () => decisions.push("approve"),
      onDeny: () => decisions.push("deny"),
      onClose: () => { closed++; },
    });
    fireEvent.click(button(container, CLOSE));
    // Walking away from a pending key must leave it pending. Either default —
    // silently approving or silently refusing — is a decision nobody made.
    expect(decisions).toEqual([]);
    expect(closed).toBe(1);
  });
});

describe("AgentPairingModal — a proposal that carried no fingerprint", () => {
  const noKey: PendingAgentRequest = { ...REQUEST, fingerprint: null };

  it("refuses both decisions but not the way out", () => {
    const decisions: string[] = [];
    let closed = 0;
    const { container } = show({
      request: noKey,
      onApprove: () => decisions.push("approve"),
      onDeny: () => decisions.push("deny"),
      onClose: () => { closed++; },
    });
    // § 10.2 approval is what lets an identity open a lane, and a request the
    // server could not resolve is not one an operator should be able to make by
    // clicking.
    expect(button(container, APPROVE).disabled).toBe(true);
    expect(button(container, DENY).disabled).toBe(true);

    // **The third button is the one a click can still reach**, and it is the one
    // worth asserting. Clicking the two dead ones and expecting nothing was the
    // previous claim here; React refuses to deliver a click to a disabled
    // element, so those expectations held for every implementation, including
    // one with both in-handler guards deleted. A dialog that disabled all three
    // would strand an operator in front of a decision they are not allowed to
    // make.
    const close = button(container, CLOSE);
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(decisions).toEqual([]);
    expect(closed).toBe(1);
  });

  it("leaves the fingerprint field blank rather than filling it with a stand-in", () => {
    // The positive control comes first, because "blank" only means anything
    // from a field that shows the real value when there is one: a component
    // that had stopped rendering the fingerprint at all would satisfy the
    // blank below while telling the operator nothing.
    expect(fingerprintShown(show().container)).toBe(FINGERPRINT);
    cleanup();

    const { container } = show({ request: noKey });
    expect(fingerprintShown(container)).toBe("");
    // The constant that used to sit here read `sha256:verified_mesh_identity`
    // under a heading an operator compares by eye, and the word *verified*
    // inside it invited skipping the comparison. A blank is worse to look at
    // and better to trust. Checked across the whole body, not just the field:
    // a stand-in in the curl line is the same lie one line further down.
    expect(container.textContent).not.toContain("verified_mesh_identity");
  });
});

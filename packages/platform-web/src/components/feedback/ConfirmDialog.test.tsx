/**
 * The last thing between an operator and an identity that cannot come back.
 *
 * The only caller of this dialog is agent teardown: the identity is destroyed,
 * its approved key is moved to the breach store, and the same id answers `409`
 * from then on. So what is worth asserting here is not that a sentence was
 * drawn — it is the two decisions the component makes on the operator's behalf.
 * *Which button was pressed*, because a cancel that also confirms is
 * indistinguishable from a confirm right up until the agent is gone; and
 * *whether the confirm is armed at all*, because `confirmPromptMatch` is the
 * entire reason this exists instead of a `window.confirm`.
 *
 * **Closed has to mean gone, not invisible.** `AgentsPage` keeps this mounted
 * for as long as it holds a teardown target and drives it with `isOpen`, so a
 * closed dialog that still rendered its footer would leave a live teardown
 * button lying underneath the page.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, and a register/unregister pair swaps the
// document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { ConfirmDialog } = await import("./ConfirmDialog.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

afterEach(cleanup);

type Props = Parameters<typeof ConfirmDialog>[0];

/** Counted rather than mocked, so "confirmed once" and "confirmed twice" are
 *  different assertions — the second is what a re-clickable teardown does. */
const calls = { confirmed: 0, closed: 0 };
beforeEach(() => { calls.confirmed = 0; calls.closed = 0; });

const TITLE = "Tear down agent-7";
const DESCRIPTION = "agent-7 (ag_7) - this destroys the identity permanently.";

const baseProps = (): Props => ({
  isOpen: true,
  onClose: () => { calls.closed += 1; },
  onConfirm: () => { calls.confirmed += 1; },
  title: TITLE,
  description: DESCRIPTION,
});

// Rendered inside the provider so every word compared below is the dictionary's
// English rather than the Korean fallback compiled into the component —
// SC-I18N-04 holds this whole tree at zero Korean characters, test files
// included.
const view = (props: Props) =>
  render(<I18nProvider><ConfirmDialog {...props} /></I18nProvider>);

// Found by variant class, not by their words: the words are exactly what half
// of these tests vary, and a label lookup would then be asserting itself.
const confirmButton = (c: HTMLElement) =>
  c.querySelector(".btn-danger, .btn-primary") as HTMLButtonElement;
const cancelButton = (c: HTMLElement) =>
  c.querySelector(".btn-secondary") as HTMLButtonElement;

describe("ConfirmDialog", () => {
  it("draws nothing at all while it is closed", () => {
    const { container } = view({
      ...baseProps(),
      isOpen: false,
      isDestructive: true,
      confirmPromptMatch: "ag_7",
    });
    // Not hidden, not merely empty-looking: no node. The caller holds this
    // mounted for as long as it has a target, so a footer that outlived
    // `isOpen: false` would be a reachable teardown under an unrelated screen.
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBe(null);
  });

  it("names the thing it is about", () => {
    const { container } = view(baseProps());
    // A dialog that says only "are you sure?" is the one an operator answers
    // for the wrong agent.
    expect(container.textContent).toContain(TITLE);
    expect(container.textContent).toContain(DESCRIPTION);
  });

  it("passes a confirm to the caller and leaves the closing to them", () => {
    const { container } = view(baseProps());
    fireEvent.click(confirmButton(container));
    expect(calls.confirmed).toBe(1);
    // Deliberate: the caller closes once its request has answered, which is
    // what lets it hold the dialog open showing `isLoading` meanwhile. A
    // dialog that shut itself here would take that state with it and report
    // nothing about whether the teardown landed.
    expect(calls.closed).toBe(0);
  });

  it("passes a cancel to the caller and does not confirm on the way out", () => {
    const { container } = view(baseProps());
    fireEvent.click(cancelButton(container));
    expect(calls.closed).toBe(1);
    // The two callbacks are one prop apart in the caller's JSX; crossing them
    // is silent everywhere except here.
    expect(calls.confirmed).toBe(0);
  });

  it("treats escape and the backdrop as cancel, never as confirm", () => {
    const { container } = view(baseProps());
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(container.firstElementChild!);
    // Both reflex dismissals reach `onClose`. Either one reaching `onConfirm`
    // would destroy an identity as the way of declining to.
    expect(calls.closed).toBe(2);
    expect(calls.confirmed).toBe(0);
  });

  it("does not dress an ordinary confirm as a destructive one", () => {
    const { container } = view(baseProps());
    expect(confirmButton(container).className).toContain("btn-primary");
    // A warning on every dialog is a warning on none.
    expect(container.textContent).not.toContain(DICTIONARY.en["confirm.irreversible"]!);
  });

  it("says a destructive confirm is destructive in words as well as in colour", () => {
    const { container } = view({ ...baseProps(), isDestructive: true });
    expect(confirmButton(container).className).toContain("btn-danger");
    // The variant is a colour, and a colour is the half of this signal that
    // some of the people looking at it do not receive. The sentence is the
    // half that survives.
    expect(container.textContent).toContain(DICTIONARY.en["confirm.irreversible"]!);
  });

  it("prefers the caller's words to its own generic ones", () => {
    const { container } = view({
      ...baseProps(),
      confirmLabel: "Run permanent teardown",
      cancelLabel: "Keep it",
    });
    expect(confirmButton(container).textContent).toContain("Run permanent teardown");
    expect(cancelButton(container).textContent).toContain("Keep it");
    // "Confirm" on an irreversible action names nothing the operator can check
    // against what they meant to do, which is why the caller overrides it.
    expect(container.textContent).not.toContain(DICTIONARY.en["confirm.ok"]!);
  });

  it("falls back to its own words when the caller supplies none", () => {
    const { container } = view(baseProps());
    expect(confirmButton(container).textContent).toContain(DICTIONARY.en["confirm.ok"]!);
    expect(cancelButton(container).textContent).toContain(DICTIONARY.en["confirm.cancel"]!);
  });

  it("asks for nothing typed when the caller asked for no gate", () => {
    const { container } = view(baseProps());
    // Absent has to look absent: an inert text box beside a confirm button
    // reads as a gate, and an operator who sees one assumes it is holding.
    expect(container.querySelector("input")).toBe(null);
    expect(container.textContent).not.toContain(DICTIONARY.en["confirm.type"]!);
    expect(confirmButton(container).disabled).toBe(false);
  });

  it("refuses to confirm until the typed text matches exactly", () => {
    const { container } = view({
      ...baseProps(), isDestructive: true, confirmPromptMatch: "ag_7",
    });
    const input = container.querySelector("input") as HTMLInputElement;

    // The field holds nothing on open, whatever it displays. Nobody has typed
    // yet, and the gate is shut.
    expect(input.value).toBe("");
    expect(confirmButton(container).disabled).toBe(true);
    fireEvent.click(confirmButton(container));
    // Refused, not merely styled as refused: a button that looks disabled and
    // still fires is the worst of the three states.
    expect(calls.confirmed).toBe(0);

    for (const near of ["ag_", "AG_7", "ag_7 ", " ag_7", "ag_70"]) {
      // `fireEvent.change`, never an assignment to `.value`: React tracks the
      // value on the node, so assigning it reaches the DOM and never reaches
      // the state this gate is read from — the gate would then appear to hold
      // for reasons that have nothing to do with what was typed.
      fireEvent.change(input, { target: { value: near } });
      // Strict equality, no trim and no case folding. A pasted id carrying a
      // stray space is the near miss this gate exists for, and each of these
      // would be let through by an "obvious" loosening of it.
      expect(confirmButton(container).disabled).toBe(true);
    }
    expect(calls.confirmed).toBe(0);
  });

  it("arms the confirm on an exact match and passes that click through", () => {
    const { container } = view({
      ...baseProps(), isDestructive: true, confirmPromptMatch: "ag_7",
    });
    fireEvent.change(container.querySelector("input")!, { target: { value: "ag_7" } });
    expect(confirmButton(container).disabled).toBe(false);
    fireEvent.click(confirmButton(container));
    // The other half of the gate: one that never opens is discovered late and
    // worked around, usually by removing it.
    expect(calls.confirmed).toBe(1);
  });

  it("forgets what was typed when the dialog is closed and opened again", () => {
    const props = { ...baseProps(), isDestructive: true, confirmPromptMatch: "ag_7" };
    const { container, rerender } = view(props);
    fireEvent.change(container.querySelector("input")!, { target: { value: "ag_7" } });
    expect(confirmButton(container).disabled).toBe(false);

    // One dialog instance serves whichever agent is selected, and closing it
    // does not unmount it. If the typed confirmation survived the close, the
    // next agent's teardown would open already armed by a confirmation nobody
    // gave for that agent.
    rerender(<I18nProvider><ConfirmDialog {...props} isOpen={false} /></I18nProvider>);
    rerender(<I18nProvider><ConfirmDialog {...props} isOpen /></I18nProvider>);

    expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(confirmButton(container).disabled).toBe(true);
  });

  it("cannot be confirmed a second time while the first is still running", () => {
    const { container } = view({ ...baseProps(), isDestructive: true, isLoading: true });
    expect(confirmButton(container).disabled).toBe(true);
    fireEvent.click(confirmButton(container));
    // Teardown is not idempotent: a second call answers 409, and the operator
    // is then told the teardown failed for an identity that is already gone.
    expect(calls.confirmed).toBe(0);
    // Cancel is held down too, so the footer offers nothing that dismisses the
    // dialog out from under a request still in flight.
    expect(cancelButton(container).disabled).toBe(true);
  });
});

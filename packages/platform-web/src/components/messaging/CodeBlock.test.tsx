/**
 * A command block is a promise that the clipboard holds what the eye read.
 *
 * Everything this component draws ends up pasted into a terminal on another
 * machine — `docs`-side, `config/env.ts` says so in as many words about the
 * `curl` lines the pairing screens render here. That makes the two halves of
 * this component one claim rather than two: the characters in the `<pre>` and
 * the characters handed to `navigator.clipboard` have to be the same
 * characters. A block that shows a whole multi-line command and copies its
 * first line, or that trims the leading spaces of a heredoc, is wrong in the
 * one way an operator cannot see — the paste happens somewhere else, and the
 * failure surfaces as a redeem that does not work on a host with no console.
 *
 * The other half is the word "copied", which is a statement about the
 * clipboard and not about the click. `navigator.clipboard` is absent outside a
 * secure context and rejects when permission is denied, and this component
 * swallows both. What it must not do is say the copy happened anyway: an
 * operator who reads that confirmation pastes whatever the clipboard held
 * before. So the refused and the unreachable clipboards are asserted here
 * alongside the working one — three different outcomes, only one of which may
 * claim success.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair here would
// take `document` away from whichever file happens to be running alongside.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, because a static import is hoisted above the registration
// above and would bind React DOM to a process that has no document yet.
const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { CodeBlock } = await import("./CodeBlock.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

// ---------------------------------------------------------------- clipboard

const realClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const written: string[] = [];
/** Swapped per-test so a denial is a state of the page, not of the component. */
let clipboardRefuses = false;

const installClipboard = () =>
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        // A refusal records nothing: a rejected `writeText` has not put the
        // text anywhere, so a test that asserted on `written` after one would
        // be asserting about this stub rather than about the browser.
        if (clipboardRefuses) return Promise.reject(new Error("write permission denied"));
        written.push(text);
        return Promise.resolve();
      },
    },
  });
installClipboard();

// -------------------------------------------------------------------- clock

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pending = new Map<number, () => void>();
let nextTimerId = 0x2000;

// Narrowed to the component's own two-second reset. A blanket capture would
// also swallow whatever React and happy-dom schedule, and firing those by hand
// would make every assertion below depend on their internals.
globalThis.setTimeout = ((handler: unknown, delay?: number, ...rest: unknown[]) => {
  if (delay === 2000 && typeof handler === "function") {
    const id = nextTimerId++;
    pending.set(id, handler as () => void);
    return id;
  }
  return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(handler, delay, ...rest);
}) as unknown as typeof globalThis.setTimeout;

globalThis.clearTimeout = ((id?: unknown) => {
  if (typeof id === "number" && pending.delete(id)) return;
  (realClearTimeout as unknown as (i?: unknown) => void)(id);
}) as unknown as typeof globalThis.clearTimeout;

/** Let the confirmation's two seconds elapse without spending any. */
const twoSecondsPass = () => {
  const due = [...pending.values()];
  pending.clear();
  act(() => { for (const fire of due) fire(); });
};

beforeEach(() => {
  written.length = 0;
  clipboardRefuses = false;
  pending.clear();
});
afterEach(cleanup);
afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  if (realClipboard) Object.defineProperty(globalThis.navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(globalThis.navigator as unknown as object, "clipboard");
});

// ------------------------------------------------------------------ helpers

// Rendered inside the provider so the labels are the dictionary's English and
// not the Korean fallbacks compiled into the component — a Korean literal in
// an assertion is what `SC-I18N-04` holds this tree to zero on.
const show = (props: Record<string, unknown>) =>
  render(
    <I18nProvider>
      <CodeBlock code="" {...props} />
    </I18nProvider>,
  ).container;

/** The command as the reader sees it, and as a paste would reproduce it. */
const shownCode = (c: HTMLElement): string => c.querySelector("pre code")!.textContent ?? "";

const copyButton = (c: HTMLElement): HTMLButtonElement | null => c.querySelector("button");

const headerText = (c: HTMLElement): string | null =>
  c.querySelector("div > div > span")?.textContent ?? null;

const COPY = DICTIONARY.en["reg.copy"]!;
const COPIED = DICTIONARY.en["reg.copied"]!;

const clickCopy = async (c: HTMLElement): Promise<HTMLButtonElement> => {
  const button = copyButton(c);
  if (!button) throw new Error("no copy button rendered");
  // The handler awaits the clipboard before it sets any state, so the label
  // changes a microtask after the click. Asserting straight after `fireEvent`
  // would read the previous label and pass for a component that never
  // confirmed anything at all.
  await act(async () => { fireEvent.click(button); });
  return button;
};

// A command with every shape that a careless renderer flattens: leading
// indentation, an embedded newline, a continuation backslash, quotes, and an
// ampersand. Each of these changes what the shell does when the paste lands.
const MULTILINE = [
  "curl -sS -X POST 'https://mesh.example/api/v1/pairing-codes/redeem' \\",
  "  -H 'content-type: application/json' \\",
  '  -d \'{"code":"PAIR-1234","identity":"agt_billing & co"}\'',
].join("\n");

describe("CodeBlock — what is shown", () => {
  it("draws the command character for character, with nothing trimmed or collapsed", () => {
    const c = show({ code: MULTILINE });
    // `toBe`, not `toContain`: a block that shows the first line of a
    // three-line command still contains the string an operator looked for.
    expect(shownCode(c)).toBe(MULTILINE);
  });

  it("keeps the whitespace a paste depends on, including the edges", () => {
    // Leading spaces are a heredoc's body and a YAML block's meaning; a
    // trailing newline is the difference between a command that runs on paste
    // and one that waits at the prompt.
    const padded = "\n  indented --flag\ntrailing\n";
    const c = show({ code: padded });
    expect(shownCode(c)).toBe(padded);
  });

  it("shows the line breaks rather than reflowing them into one line", () => {
    const c = show({ code: MULTILINE });
    // The text node carries the newlines whatever the CSS says; `white-space`
    // is what decides whether the reader sees three lines or one. A block that
    // shows one line and copies three has already broken the promise, because
    // the operator checked the thing they could see.
    const pre = c.querySelector("pre")!;
    expect(pre.style.whiteSpace).toBe("pre-wrap");
  });

  it("renders a command that looks like markup as text, not as markup", () => {
    const injected = `curl -d '<script>alert(1)</script>' https://mesh.example`;
    const c = show({ code: injected });
    // Not a theoretical escaping check: payloads shown here come from the API,
    // and a block that parsed them would both execute the page's own markup
    // and copy something different from what it drew.
    expect(c.querySelector("script")).toBe(null);
    expect(shownCode(c)).toBe(injected);
  });
});

describe("CodeBlock — what is copied", () => {
  it("puts on the clipboard exactly what it put on the screen", async () => {
    const c = show({ code: MULTILINE, title: "Agent terminal" });
    await clickCopy(c);
    expect(written).toEqual([MULTILINE]);
    // The point of the whole component, stated against the DOM rather than
    // against the prop: the two halves cannot drift apart without this failing.
    expect(written[0]).toBe(shownCode(c));
  });

  it("copies the command alone, not the label sitting above it", async () => {
    const c = show({ code: "am agent status", title: "Agent terminal", language: "bash" });
    await clickCopy(c);
    // The header is chrome. A copy that swept it in pastes `Agent terminal`
    // into a shell as the first word of the command.
    expect(written[0]).toBe("am agent status");
    expect(written[0]).not.toContain("Agent terminal");
    expect(written[0]).not.toContain("BASH");
  });

  it("keeps the edge whitespace on the way to the clipboard too", async () => {
    const padded = "  am agent approve agt_worker\n";
    const c = show({ code: padded });
    await clickCopy(c);
    // Trimming here would be invisible on screen and would silently change a
    // command that ends in a newline into one that does not.
    expect(written[0]).toBe(padded);
  });

  it("says it copied only once the clipboard has taken it", async () => {
    const c = show({ code: "am agent status" });
    const button = copyButton(c)!;
    expect(button.textContent).toContain(COPY);
    expect(button.textContent).not.toContain(COPIED);
    await clickCopy(c);
    expect(button.textContent).toContain(COPIED);
  });

  it("does not claim a copy the clipboard refused", async () => {
    clipboardRefuses = true;
    const c = show({ code: "am agent status" });
    const button = await clickCopy(c);
    // The defect this repository keeps finding, in its clipboard form: a
    // confirmation about something that did not happen. An operator who reads
    // `copied` pastes whatever the clipboard held before this screen.
    expect(written).toEqual([]);
    expect(button.textContent).not.toContain(COPIED);
    expect(button.textContent).toContain(COPY);
  });

  it("does not claim a copy on a page that has no clipboard at all", async () => {
    // What an admin console served over plain http on an internal network
    // actually gets: `navigator.clipboard` is undefined outside a secure
    // context, so the property access throws before any write starts.
    //
    // Defined as `undefined` rather than deleted, because deleting the own
    // property uncovers happy-dom's own prototype clipboard and the write then
    // succeeds — this test passed against a browser it was not describing
    // until that was fixed.
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
    try {
      const c = show({ code: "am agent status" });
      const button = await clickCopy(c);
      expect(button.textContent).not.toContain(COPIED);
      // And the block still shows the command, which is the only way to get it
      // off this page now.
      expect(shownCode(c)).toBe("am agent status");
    } finally {
      installClipboard();
    }
  });

  it("lets the confirmation lapse back into an offer, rather than standing forever", async () => {
    const c = show({ code: "am agent status" });
    const button = await clickCopy(c);
    expect(button.textContent).toContain(COPIED);
    twoSecondsPass();
    // `copied` is a claim about what the clipboard holds now, and the page has
    // no way to know it still holds it. Bounding the claim keeps a stale one
    // from outliving its truth by more than the two seconds; leaving the
    // button offering to copy again is the recovery for every case above.
    expect(button.textContent).toContain(COPY);
    expect(button.textContent).not.toContain(COPIED);
  });
});

describe("CodeBlock — the bar above the command", () => {
  it("names the language when the caller gave no title", () => {
    expect(headerText(show({ code: "ls" }))).toBe("BASH");
    cleanup();
    expect(headerText(show({ code: "{}", language: "json" }))).toBe("JSON");
  });

  it("prefers the caller's title, so the bar can say where the command is run", () => {
    const c = show({ code: "ls", language: "bash", title: "Agent terminal" });
    expect(headerText(c)).toBe("Agent terminal");
  });

  it("draws no bar at all when there is nothing for it to hold", () => {
    const c = show({ code: MULTILINE, showCopy: false });
    const block = c.firstElementChild!;
    // An empty grey strip reads as a header whose text failed to load. With no
    // title and no button there is nothing to put in it, so there is none —
    // absent looks absent, and the command is still all the way there.
    expect(copyButton(c)).toBe(null);
    expect(block.children.length).toBe(1);
    expect(block.children[0]!.tagName).toBe("PRE");
    expect(shownCode(c)).toBe(MULTILINE);
  });

  it("keeps the title bar without the button when only copying is turned off", () => {
    const c = show({ code: "ls", title: "Agent terminal", showCopy: false });
    expect(headerText(c)).toBe("Agent terminal");
    // A button that cannot copy is worse than none: it invites a click that
    // silently does nothing, which is the same picture as a refused clipboard.
    expect(copyButton(c)).toBe(null);
  });
});

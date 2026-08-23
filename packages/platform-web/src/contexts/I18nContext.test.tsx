/**
 * The dictionary, and the two ways a screen ends up showing the wrong language.
 *
 * `DICTIONARY` is about 1,100 of this package's 12,339 lines and has no
 * branches in it, so importing this module moves the coverage number a long
 * way without asserting anything. What is worth asserting is the parity — a
 * key added to one language and not the other draws the *key itself* on the
 * screen that lacks it, and nothing in the type system says the two records
 * hold the same keys. They do today: 510 and 510.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered before `@testing-library/react` is loaded, which is why these are
// `await import` and not statements: a static import is hoisted above this line
// and would run against a process with no `document`.
// **Registered once for the process, and never unregistered.** Bun executes
// every matching file's top level before it runs any test, so two files each
// calling `register()` swap the document out from under one another, and the
// first `afterAll` to fire takes it away from the file still using it — seven
// failures that appeared only when the two ran together, and none when either
// ran alone.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { cleanup, render, screen, act } = await import("@testing-library/react");
const { DICTIONARY, I18nProvider, useI18n } = await import("./I18nContext.tsx");
type Language = "ko" | "en";


describe("the dictionary", () => {
  it("holds the same keys in both languages", () => {
    const ko = Object.keys(DICTIONARY.ko).sort();
    const en = Object.keys(DICTIONARY.en).sort();
    // Named individually: a count tells a reader that something is missing,
    // the list tells them which line to write.
    expect(en.filter((k) => !(k in DICTIONARY.ko))).toEqual([]);
    expect(ko.filter((k) => !(k in DICTIONARY.en))).toEqual([]);
    // A floor, so a dictionary that stopped being read cannot pass by being
    // empty on both sides.
    expect(ko.length).toBeGreaterThan(400);
  });

  it("has no empty translations", () => {
    for (const lang of ["ko", "en"] as Language[]) {
      const blank = Object.entries(DICTIONARY[lang]).filter(([, v]) => v.trim() === "");
      expect(blank.map(([k]) => `${lang}:${k}`)).toEqual([]);
    }
  });
});

function Probe({ k, fallback }: { k: string; fallback?: string }) {
  const { t, language, setLanguage } = useI18n();
  return (
    <div>
      <span data-testid="said">{t(k, fallback)}</span>
      <span data-testid="lang">{language}</span>
      <button data-testid="to-ko" onClick={() => setLanguage("ko")}>ko</button>
      <button data-testid="to-en" onClick={() => setLanguage("en")}>en</button>
    </div>
  );
}

beforeEach(() => { cleanup(); localStorage.clear(); });
// **And after the last one.** happy-dom's storage is shared by every file in
// the run, so leaving `agent_mesh_lang` set to `ko` here makes every later file
// that renders inside `I18nProvider` draw Korean — which is what two DataTable
// and three CodeBlock assertions read as a failure. Clearing on the way in
// protects this file; clearing on the way out protects everyone else.
afterAll(() => { localStorage.clear(); });

describe("t()", () => {
  it("answers in English until somebody has chosen otherwise", () => {
    // Not Korean, which was the old default and is wrong for a deployment
    // opened elsewhere: the first screen is the login page and the language
    // toggle lives in the sidebar, behind it. A visitor who could not read the
    // form could not reach the control that would have translated it.
    render(<I18nProvider><Probe k="common.loading" /></I18nProvider>);
    expect(screen.getByTestId("lang").textContent).toBe("en");
    expect(screen.getByTestId("said").textContent).toBe(DICTIONARY.en["common.loading"]!);
  });

  it("takes the saved choice over the default", () => {
    localStorage.setItem("agent_mesh_lang", "ko");
    render(<I18nProvider><Probe k="common.loading" /></I18nProvider>);
    expect(screen.getByTestId("said").textContent).toBe(DICTIONARY.ko["common.loading"]!);
  });

  it("ignores a saved value that is not a language it has", () => {
    localStorage.setItem("agent_mesh_lang", "de");
    render(<I18nProvider><Probe k="common.loading" /></I18nProvider>);
    expect(screen.getByTestId("lang").textContent).toBe("en");
  });

  it("falls back to the caller's sentence, and then to the key itself", () => {
    render(<I18nProvider><Probe k="no.such.key" fallback="a fallback" /></I18nProvider>);
    expect(screen.getByTestId("said").textContent).toBe("a fallback");
    cleanup();
    render(<I18nProvider><Probe k="no.such.key" /></I18nProvider>);
    // The key on screen is the visible form of a missing translation, which is
    // what the parity test above exists to prevent.
    expect(screen.getByTestId("said").textContent).toBe("no.such.key");
  });

  it("follows the language when it changes, and remembers the choice", () => {
    render(<I18nProvider><Probe k="common.loading" /></I18nProvider>);
    act(() => { screen.getByTestId("to-ko").click(); });
    expect(screen.getByTestId("lang").textContent).toBe("ko");
    expect(screen.getByTestId("said").textContent).toBe(DICTIONARY.ko["common.loading"]!);
    expect(localStorage.getItem("agent_mesh_lang")).toBe("ko");
  });
});

describe("useI18n outside a provider", () => {
  it("still answers and keeps its fallback language when its control is used", () => {
    // A hook that throws here turns one forgotten provider into a blank screen.
    render(<Probe k="common.loading" fallback="untranslated" />);
    expect(screen.getByTestId("said").textContent).toBe("untranslated");
    expect(screen.getByTestId("lang").textContent).toBe("ko");

    // There is deliberately no provider state to change. The recovery
    // contract is that a live language control remains safe, not that clicking
    // it manufactures a second, disconnected source of language state.
    expect(() => {
      act(() => { screen.getByTestId("to-en").click(); });
    }).not.toThrow();
    expect(screen.getByTestId("lang").textContent).toBe("ko");
    expect(screen.getByTestId("said").textContent).toBe("untranslated");
  });
});

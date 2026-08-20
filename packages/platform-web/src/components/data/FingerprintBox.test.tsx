/**
 * Absent has to look absent.
 *
 * This prop was a required string and `GET /api/v1/agents` carries no
 * fingerprint, so every row rendered the literal `sha256:verified_mesh_identity`
 * under a column headed "Ed25519 public key fingerprint". A constant there
 * makes every agent match the one an operator is comparing against, and the
 * word *verified* inside it invites skipping the comparison — so a real
 * mismatch would have been invisible. `null` now draws a dash and says why.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { DICTIONARY, I18nProvider } = await import("@/contexts/I18nContext.tsx");
const { FingerprintBox } = await import("./FingerprintBox.tsx");

afterEach(cleanup);

describe("FingerprintBox", () => {
  it("says the server did not send one, rather than inventing a value", () => {
    for (const absent of [null, ""] as const) {
      const { container } = render(<FingerprintBox fingerprint={absent} />);
      expect(container.querySelector('[data-testid="fingerprint-absent"]')).not.toBe(null);
      expect(container.textContent).not.toContain("verified_mesh_identity");
      cleanup();
    }
  });

  it("draws the fingerprint it is given", () => {
    const { container } = render(<FingerprintBox fingerprint="sha256:abc123" />);
    expect(container.textContent).toContain("abc123");
    expect(container.querySelector('[data-testid="fingerprint-absent"]')).toBe(null);
  });

  it("adds the prefix once, and only when it is missing", () => {
    const withPrefix = render(<FingerprintBox fingerprint="sha256:abc" />).container.textContent ?? "";
    expect(withPrefix.split("sha256:").length - 1).toBe(1);
    cleanup();
    const without = render(<FingerprintBox fingerprint="abc" />).container.textContent ?? "";
    expect(without).toContain("sha256:abc");
  });
});

describe("copying it", () => {
  const clipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  });

  const withClipboard = (writeText: () => Promise<void>) => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  };

  it("says the copy failed rather than saying nothing", async () => {
    // The catch was labelled `// Fallback` and had no fallback in it. A refused
    // clipboard — no permission, an insecure origin — left the button reading
    // `Copy`, so a person who pressed it and moved on pasted whatever was there
    // before. The fingerprint is the one value on this card somebody carries
    // somewhere else to compare against.
    withClipboard(() => Promise.reject(new Error("denied")));
    // Inside the provider, which defaults to English: the real `useI18n`
    // answers outside one with the Korean fallback compiled into the
    // component, and comparing that against `DICTIONARY.en` compares two
    // different languages.
    const { container } = render(
      <I18nProvider><FingerprintBox fingerprint="sha256:abc123" /></I18nProvider>,
    );
    const button = container.querySelector("button")!;
    await act(async () => { fireEvent.click(button); });
    expect(container.textContent).toContain(DICTIONARY.en["fp.copyFailed"]!);
    // And it does not claim success in the same breath.
    expect(container.textContent).not.toContain(DICTIONARY.en["reg.copied"]!);
  });

  it("says it copied when the clipboard took it", async () => {
    withClipboard(() => Promise.resolve());
    const { container } = render(
      <I18nProvider><FingerprintBox fingerprint="sha256:abc123" /></I18nProvider>,
    );
    await act(async () => { fireEvent.click(container.querySelector("button")!); });
    expect(container.textContent).toContain(DICTIONARY.en["reg.copied"]!);
    expect(container.textContent).not.toContain(DICTIONARY.en["fp.copyFailed"]!);
  });
});


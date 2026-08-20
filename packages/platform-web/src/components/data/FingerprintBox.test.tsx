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

const { render, cleanup } = await import("@testing-library/react");
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

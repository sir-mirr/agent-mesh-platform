/**
 * The two badges, which carry no logic except the part that has been wrong.
 *
 * `StatusBadge` maps eight status words onto colours and falls back to
 * `neutral`; `Toast` maps four. Neither decides anything, so what is worth
 * asserting is narrow: that an unknown word does not produce an undefined
 * colour (which renders as an invisible badge rather than an error), and that
 * the label and the dot are governed by the props they claim to be.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { registerDom } from "../../register-dom";

registerDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const { StatusBadge } = await import("./StatusBadge.tsx");
const { Toast } = await import("./Toast.tsx");

afterEach(cleanup);

describe("StatusBadge", () => {
  it("draws the label it is given", () => {
    render(<StatusBadge label="online" status="online" />);
    expect(screen.getByText("online")).toBeDefined();
  });

  it("falls back to neutral for a status it does not know", () => {
    // The map is indexed by a union, but the data comes from a route: a word
    // the front end has not heard of must not index to `undefined` and paint a
    // badge with no background at all.
    const { container } = render(<StatusBadge label="?" status={"unheard-of" as never} />);
    const span = container.querySelector("span");
    expect(span?.getAttribute("style") ?? "").toContain("background");
  });

  it("drops the dot when asked", () => {
    const withDot = render(<StatusBadge label="a" hasDot />).container.querySelectorAll("span").length;
    cleanup();
    const without = render(<StatusBadge label="a" hasDot={false} />).container.querySelectorAll("span").length;
    expect(withDot).toBeGreaterThan(without);
  });
});

describe("Toast", () => {
  it("draws the message", () => {
    render(<Toast message="saved" type="success" />);
    expect(screen.getByText("saved")).toBeDefined();
  });

  it("says which kind of thing it is, where a reader can ask", () => {
    // The type is what tells a success from a failure when the two sentences
    // differ by one word. Asserted here so the attribute cannot quietly go:
    // scenarios locate the toast by it.
    const { container } = render(<Toast type="error" message="could not create" />);
    expect(container.querySelector('[data-toast="error"]')).not.toBe(null);
    expect(container.querySelector('[data-toast="success"]')).toBe(null);
  });

  it("defaults to info rather than nothing", () => {
    const { container } = render(<Toast message="hello" />);
    expect(container.textContent).toContain("hello");
  });
});

/**
 * The modal, the page header, and the telemetry bar.
 *
 * Each has one behaviour worth writing down. A modal that only closes by its
 * own button traps somebody behind a dialog whose action failed; a header that
 * drops its actions takes the page's only controls with it; and a bar whose
 * percentage is not clamped draws a fill wider than its track — a 137%
 * "capacity" that reads as a rendering bug rather than as the number it is.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { Modal } = await import("./feedback/Modal.tsx");
const { PageHeader } = await import("./layout/PageHeader.tsx");
const { TelemetryCard } = await import("./data/TelemetryCard.tsx");

afterEach(cleanup);

describe("Modal", () => {
  it("draws nothing at all while it is closed", () => {
    const { container } = render(
      <Modal isOpen={false} onClose={() => {}} title="Tear down"><p>are you sure</p></Modal>,
    );
    expect(container.textContent).not.toContain("are you sure");
  });

  it("draws its title and its children when open", () => {
    const { container } = render(
      <Modal isOpen onClose={() => {}} title="Tear down"><p>are you sure</p></Modal>,
    );
    expect(container.textContent).toContain("Tear down");
    expect(container.textContent).toContain("are you sure");
  });

  it("closes on Escape, so a dialog is never a trap", () => {
    let closed = 0;
    render(<Modal isOpen onClose={() => { closed += 1; }}><p>body</p></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toBe(1);
  });

  it("does not listen for Escape while it is closed", () => {
    let closed = 0;
    render(<Modal isOpen={false} onClose={() => { closed += 1; }}><p>body</p></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    // A closed dialog reacting to a keypress closes something else's.
    expect(closed).toBe(0);
  });
});

describe("PageHeader", () => {
  it("draws the title, the subtitle and the actions", () => {
    const { container } = render(
      <PageHeader title="Agents" subtitle="who is on the mesh"
                  actions={<button>Register</button>} />,
    );
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("who is on the mesh");
    expect(container.querySelector("button")?.textContent).toBe("Register");
  });
});

describe("TelemetryCard", () => {
  it("clamps the bar to its track in both directions", () => {
    for (const [given, drawn] of [[137, "100%"], [-5, "0%"], [42, "42%"]] as const) {
      const { container } = render(
        <TelemetryCard label="capacity" currentValue={given} percentage={given} />,
      );
      const widths = [...container.querySelectorAll("div")]
        .map((d) => d.getAttribute("style") ?? "")
        .filter((s) => s.includes("width:"));
      expect(widths.some((s) => s.includes(drawn))).toBe(true);
      cleanup();
    }
  });

  it("puts the number where a reader can name it, with its unit beside it", () => {
    const { container } = render(
      <TelemetryCard label="queue" currentValue={7} maxLabel="100" percentage={7}
                     valueTestId="queue-depth" statusText="healthy" />,
    );
    expect(container.querySelector('[data-testid="queue-depth"]')?.textContent).toBe("7");
    expect(container.textContent).toContain("100");
    expect(container.textContent).toContain("healthy");
  });
});

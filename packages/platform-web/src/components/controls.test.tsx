/**
 * The controls a screen is assembled from: button, input, KPI card.
 *
 * None of them decides anything, and the assertions are correspondingly narrow
 * — but each has a prop that changes what an operator can *do*, and those are
 * the ones written down here. A loading button that is still clickable submits
 * twice; a KPI card that drops `data-kpi` takes every scenario's way of naming
 * the number it is reading with it.
 */
import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { registerDom } from "../register-dom";

registerDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { Button } = await import("./common/Button.tsx");
const { Input } = await import("./common/Input.tsx");
const { KpiCard } = await import("./data/KpiCard.tsx");

afterEach(cleanup);

describe("Button", () => {
  it("draws its children and passes clicks through", () => {
    let clicks = 0;
    render(<Button onClick={() => { clicks += 1; }}>Approve</Button>);
    (screen.getByText("Approve").closest("button") as HTMLButtonElement).click();
    expect(clicks).toBe(1);
  });

  it("cannot be clicked while it is loading", () => {
    let clicks = 0;
    const { container } = render(
      <Button isLoading onClick={() => { clicks += 1; }}>Approve</Button>,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    // A loading button that still fires submits the same approval twice.
    expect(button.disabled).toBe(true);
    button.click();
    expect(clicks).toBe(0);
  });

  it("is disabled when told, loading or not", () => {
    const { container } = render(<Button disabled>Approve</Button>);
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the attributes a caller passes to the element itself", () => {
    const { container } = render(<Button type="submit" data-testid="go">Go</Button>);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("data-testid")).toBe("go");
  });
});

describe("Input", () => {
  it("carries value and change through to the caller", () => {
    let seen = "";
    const { container } = render(
      <Input value="" onChange={(e) => { seen = (e.target as HTMLInputElement).value; }} />,
    );
    // `fireEvent.change`, not a hand-dispatched `input`: React tracks the
    // value on the node itself, so assigning `.value` and dispatching an event
    // reaches the DOM and never reaches the component.
    fireEvent.change(container.querySelector("input")!, { target: { value: "typed" } });
    expect(seen).toBe("typed");
  });

  it("ties its label to its field, generating an id when none is given", () => {
    const { container } = render(<Input label="Identity" />);
    const input = container.querySelector("input")!;
    const label = container.querySelector("label")!;
    // Without this pairing the label is decoration: clicking it does not focus
    // the field and a screen reader reads the two as unrelated.
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.id).toBeTruthy();
  });

  it("prefers the id it is given", () => {
    const { container } = render(<Input label="Identity" id="chosen" />);
    expect(container.querySelector("input")!.id).toBe("chosen");
  });

  it("shows an error, and the helper text when there is no error", () => {
    const { container } = render(<Input helperText="lowercase only" />);
    expect(container.textContent).toContain("lowercase only");
    cleanup();
    const withError = render(<Input helperText="lowercase only" error="already taken" />);
    expect(withError.container.textContent).toContain("already taken");
  });
});

describe("KpiCard", () => {
  it("names itself with its label so a reader can find the number", () => {
    const { container } = render(<KpiCard label="agents" value={12} />);
    // Locating a KPI by surrounding text matches whatever else shares the
    // container; this attribute is how every scenario names one.
    expect(container.querySelector('[data-kpi="agents"]')).not.toBe(null);
    expect(container.textContent).toContain("12");
  });

  it("draws a sub-value and a trend when it has them", () => {
    const { container } = render(
      <KpiCard label="queue" value={3} subValue="live registry"
               trend={{ value: "+2", isPositive: true }} />,
    );
    expect(container.textContent).toContain("live registry");
    expect(container.textContent).toContain("+2");
  });

  it("draws a zero as a zero", () => {
    // `value` is `string | number`, and a falsy number rendered through a
    // shortcut disappears — an empty cell where the mesh said nought.
    const { container } = render(<KpiCard label="queue" value={0} />);
    expect(container.textContent).toContain("0");
  });
});

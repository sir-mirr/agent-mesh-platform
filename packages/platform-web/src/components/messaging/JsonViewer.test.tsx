/**
 * The four sights a payload panel has to keep apart.
 *
 * This is the last thing between an operator and the body the mesh actually
 * carried, and the states it has to distinguish are the ones this console
 * keeps conflating: a field that *was* `null`, a field that was never sent, an
 * empty object, and a body that could not be serialized at all. `JSON.stringify`
 * answers three of those with a short string and the fourth by throwing, so all
 * four decisions live in the eight lines of `JsonViewer` — and until this file
 * none of them had an assertion on it, because the component is one call deep
 * and looked too small to be a decision.
 *
 * Rendered inside `I18nProvider` so the words on screen come from the
 * dictionary (English by default) instead of the Korean fallbacks compiled into
 * `CodeBlock`; `SC-I18N-04` holds this whole tree at zero Korean characters,
 * test files included.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair here would
// pull `document` out from under whichever file is running alongside.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup } = await import("@testing-library/react");
const { JsonViewer } = await import("./JsonViewer.tsx");
const { I18nProvider } = await import("@/contexts/I18nContext.tsx");

afterEach(cleanup);

const draw = (data: unknown) =>
  render(
    <I18nProvider>
      <JsonViewer data={data} />
    </I18nProvider>,
  ).container;

/** Only the `<code>` element, never the container: the container also carries
 *  the title bar and the copy button's label, and neither of those is the
 *  payload. An assertion on `container.textContent` would pass on a panel that
 *  drew nothing at all, which is the exact failure this file is about. */
const shown = (data: unknown): string => draw(data).querySelector("code")?.textContent ?? "";

describe("JsonViewer given a value that is not JSON", () => {
  it("hands a string through untouched instead of re-encoding it", () => {
    // The alternative reading is `JSON.stringify(body)`, which would wrap this
    // in quotes and escape the angle brackets. An operator diffing a gateway's
    // reply against what came off the wire would then be reading an encoding of
    // the body rather than the body.
    const body = "<html><head><title>504 Gateway Time-out</title></head></html>";
    expect(shown(body)).toBe(body);
    expect(shown(body).startsWith('"')).toBe(false);
  });

  it("does not parse or re-indent a string that happens to be JSON", () => {
    // String in, string out, with no round trip through the parser: whatever
    // the caller held is what is on screen. Re-indenting would silently repair
    // a body — key order and spacing included — and hide that the sender sent
    // something a strict receiver would reject.
    const raw = '{"agent":"a-1","depth":3}';
    expect(shown(raw)).toBe(raw);
    expect(shown(raw)).not.toContain("\n");
  });

  it("keeps the panel mounted when the payload cannot be serialized at all", () => {
    const circular: Record<string, unknown> = { agent: "a-1" };
    circular.self = circular;
    // `JSON.stringify` throws on a cycle. Without the module's catch this panel
    // would take its whole page down, so staying mounted is the decision being
    // pinned. What it puts in the block *instead* is not asserted here: today
    // that is `String(data)`, which discards the payload and prints one opaque
    // constant, and that is reported rather than frozen by a test.
    const container = draw(circular);
    expect(container.querySelector("code")).not.toBe(null);
    expect(container.textContent).toContain("JSON Payload");
  });

  it("labels the block from the caller's title, which is not a claim about the content", () => {
    // The header reads "JSON Payload" over a body nothing here has checked is
    // JSON. That is the caller's word, not the viewer's finding — pinned so a
    // future change that starts validating has to come here and say so.
    expect(draw("not json at all").textContent).toContain("JSON Payload");
    const titled = render(
      <I18nProvider>
        <JsonViewer data={{ ok: true }} title="Dispatched body" />
      </I18nProvider>,
    ).container;
    expect(titled.textContent).toContain("Dispatched body");
    expect(titled.textContent).not.toContain("JSON Payload");
  });
});

describe("JsonViewer given null, and the sights null must not share", () => {
  it("draws null as the word null rather than as nothing", () => {
    // A field the server explicitly sent as null is a statement. Drawing it as
    // an empty block would turn that statement into the absence of one.
    expect(shown(null)).toBe("null");
  });

  it("keeps null, an empty object, zero and an empty string four different sights", () => {
    const sights = [shown(null), shown({}), shown(0), shown("")];
    expect(sights).toEqual(["null", "{}", "0", ""]);
    // The property that matters is not the four spellings but that no two of
    // them collide: null is not zero, an empty object is not a missing one, and
    // an operator comparing two receipts by eye has to be able to tell.
    expect(new Set(sights).size).toBe(4);
  });

  it("draws an absent payload blank, not as the word null and not as the word undefined", () => {
    // `JSON.stringify(undefined)` returns `undefined`, so nothing reaches the
    // block. Blank is the defensible half: it must not borrow null's word for a
    // field that was never sent, nor print the literal text `undefined`, which
    // would sit in the block looking like a value the sender chose.
    expect(shown(undefined)).toBe("");
    expect(shown(undefined)).not.toBe("null");
    expect(shown(undefined)).not.toContain("undefined");
  });

  it("draws a number JSON cannot carry as null, because that is what a receiver would parse", () => {
    // JSON has no NaN and no Infinity. Showing the operator `NaN` here would
    // show a value no peer ever receives; `null` is what actually goes on the
    // wire. Pinned so nobody "improves" this panel into something truthful
    // about the local object and false about the message.
    expect(shown(Number.NaN)).toBe("null");
    expect(shown(Number.POSITIVE_INFINITY)).toBe("null");
  });
});

describe("JsonViewer given a deeply nested object", () => {
  const LEVELS = 12;
  const build = () => {
    let node: Record<string, unknown> = { leaf: "the-innermost-value", count: 0 };
    for (let i = LEVELS; i >= 1; i--) node = { [`level${i}`]: node, kept: i };
    return node;
  };

  it("draws every level down to the leaf, with no depth cut", () => {
    const deep = build();
    const text = shown(deep);
    // The strongest available statement that nothing was lost: what is on
    // screen parses back into the object that went in. A viewer that summarised
    // below some depth would still contain the outer keys and pass a `toContain`
    // check on them.
    expect(JSON.parse(text)).toEqual(deep);
    expect(text).toContain("the-innermost-value");
    // The shapes a depth-limited printer leaves behind (`console.log` and
    // `util.inspect` both stop at depth 2 and print these).
    expect(text).not.toContain("[Object]");
    expect(text).not.toContain("[Array]");
    expect(text).not.toContain("…");
  });

  it("indents two spaces per level instead of printing one long line", () => {
    const text = shown(build());
    // Depth is what an operator reads structure from, and it is only visible if
    // the block is pretty-printed: `JSON.stringify(data)` with no indent
    // argument would render the same payload as a single unreadable line, and
    // every assertion above would still pass.
    expect(text).toContain(`\n${" ".repeat(2 * (LEVELS + 1))}"leaf":`);
    expect(text.split("\n").length).toBeGreaterThan(LEVELS);
  });

  it("draws a nested array as an array rather than as an object", () => {
    // `String(value)` — the module's fallback path — flattens `[1,[2,[3]]]` to
    // `1,2,3` and loses every bracket. This asserts the normal path did the
    // serialising, not the catch.
    expect(JSON.parse(shown([1, [2, [3, []]]]))).toEqual([1, [2, [3, []]]]);
    expect(shown([1, [2, [3, []]]])).toContain("[");
  });
});

describe("JsonViewer when the payload it is given changes", () => {
  it("redraws the new body instead of holding the memoised previous one", () => {
    // The body is computed in a `useMemo` keyed on `data`. Keyed on `[]` — the
    // easy typo — this panel would keep showing the first receipt an operator
    // opened while the header and the rest of the page moved on to the second.
    const view = render(
      <I18nProvider>
        <JsonViewer data={{ receipt: "first-dispatch" }} />
      </I18nProvider>,
    );
    view.rerender(
      <I18nProvider>
        <JsonViewer data={{ receipt: "second-dispatch" }} />
      </I18nProvider>,
    );
    const text = view.container.querySelector("code")?.textContent ?? "";
    expect(text).toContain("second-dispatch");
    expect(text).not.toContain("first-dispatch");
  });
});

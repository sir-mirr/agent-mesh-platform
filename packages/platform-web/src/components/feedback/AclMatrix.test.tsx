/**
 * What a cell in the egress grid actually claims.
 *
 * Three readings live in one square here, and only two of them are the same
 * thing: *someone wrote a deny*, *nobody ever wrote a rule*, and *the policy
 * was never read*. The first two agree at the server — `maySend` needs a rule
 * and refuses without one, so drawing DENY for an absent rule is a reading, not
 * a claim. The third does not agree with anything, and this component has no
 * way to say it: its `rules` prop is `Record<string, Record<string, boolean>>`,
 * which has no third state, so an empty map and a fully-denied tenant render
 * byte for byte the same grid. That is pinned below rather than assumed,
 * because it is the whole reason the caller has to decide *before* it mounts
 * this component.
 *
 * The other half is direction. `a -> b` is not `b -> a`; the grid is the only
 * place an operator sees that, and a transposed lookup would still produce a
 * self-consistent table. So the cells here are located by where they sit —
 * which row label, which column header — and not by the `data-testid` the same
 * loop generates.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a paired unregister() would pull the
// document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, because a static import is hoisted above the register call
// and would bind a React DOM renderer to a process that has no document yet.
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { AclMatrix } = await import("./AclMatrix.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

afterEach(cleanup);

type Group = { id: string; name: string };
type Rules = Record<string, Record<string, boolean>>;
type Toggle = (sourceId: string, targetId: string, currentAllowed: boolean) => void;

// Ids and names differ on purpose: a cell has to prove which of the two it put
// in the label and which it put in the test id, and identical strings would
// let a mix-up pass.
const OPS: Group = { id: "grp_ops", name: "Ops" };
const BILLING: Group = { id: "grp_billing", name: "Billing" };
const DEFAULT: Group = { id: "grp_default", name: "Default" };
const GROUPS: Group[] = [OPS, BILLING, DEFAULT];

const ALLOW = DICTIONARY.en["acl.allow"]!;
const DENY = DICTIONARY.en["acl.deny"]!;

// Rendered inside the provider so the words are the dictionary's English, not
// the Korean fallbacks compiled into the component — SC-I18N-04 holds this
// tree at zero Korean characters, assertions included.
const draw = (
  groups: Group[],
  rules: Rules,
  extra: { onToggleRule?: Toggle; readOnly?: boolean } = {},
) =>
  render(
    <I18nProvider>
      <AclMatrix groups={groups} rules={rules} {...extra} />
    </I18nProvider>,
  ).container;

/** The table as plain data — no DOM nodes, so two renders can be compared. */
const grid = (c: HTMLElement) => {
  const headers = [...c.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
  return {
    axis: headers[0] ?? "",
    targets: headers.slice(1),
    rows: [...c.querySelectorAll("tbody tr")].map((tr) => {
      const tds = [...tr.children] as HTMLElement[];
      return {
        source: tds[0]?.textContent ?? "",
        cells: tds.slice(1).map((td) => ({
          testid: td.getAttribute("data-testid"),
          allowed: td.getAttribute("data-allowed"),
          label: td.textContent ?? "",
        })),
      };
    }),
  };
};

/** Located by position — row whose label is `source`, column whose header is
 *  `target`. A transposed read of `rules` survives a lookup by test id, since
 *  the id is built from the same two loop variables; it does not survive this. */
const cellAt = (c: HTMLElement, source: string, target: string) => {
  const g = grid(c);
  const row = g.rows.find((r) => r.source === source);
  const column = g.targets.indexOf(target);
  expect(row, `no row is labelled ${source}`).toBeDefined();
  expect(column, `no column is headed ${target}`).toBeGreaterThan(-1);
  return row!.cells[column]!;
};

const buttonAt = (c: HTMLElement, sourceId: string, targetId: string) =>
  c.querySelector<HTMLButtonElement>(`[data-testid="acl-${sourceId}-${targetId}"] button`)!;

describe("AclMatrix", () => {
  it("names both axes and draws every group on each of them", () => {
    const c = draw(GROUPS, {});
    const g = grid(c);
    // The corner header is the only thing that says which axis is the sender.
    // Without it the table is a symmetric-looking square of the same names.
    expect(g.axis).toBe(DICTIONARY.en["acl.axis"]!);
    expect(g.targets).toEqual(["Ops", "Billing", "Default"]);
    expect(g.rows.map((r) => r.source)).toEqual(["Ops", "Billing", "Default"]);
  });

  it("gives every ordered pair a cell, so a missing rule is a square and not a gap", () => {
    const c = draw(GROUPS, {});
    const g = grid(c);
    // Nine cells for three groups, including the three on the diagonal. A grid
    // that omitted the pairs it had no rule for would invite reading the hole
    // as "does not apply" rather than "may not send".
    expect(g.rows).toHaveLength(3);
    expect(g.rows.flatMap((r) => r.cells)).toHaveLength(9);
    for (const source of GROUPS) {
      for (const target of GROUPS) {
        expect(c.querySelector(`[data-testid="acl-${source.id}-${target.id}"]`)).not.toBe(null);
      }
    }
  });

  it("reads Ops -> Billing without also granting Billing -> Ops", () => {
    const c = draw(GROUPS, { [OPS.id]: { [BILLING.id]: true } });
    // The direction is the product here: SPEC section 12 is deny-by-default and
    // one-way, and a grid that mirrored the rule would tell an operator a
    // reverse route exists that the hub answers with -32018.
    expect(cellAt(c, "Ops", "Billing").allowed).toBe("yes");
    expect(cellAt(c, "Ops", "Billing").label).toBe(ALLOW);
    expect(cellAt(c, "Billing", "Ops").allowed).toBe("no");
    expect(cellAt(c, "Billing", "Ops").label).toBe(DENY);
    // And the id an e2e selector uses is source-then-target, matching the
    // position — the two must not disagree about which end is the sender.
    expect(cellAt(c, "Ops", "Billing").testid).toBe("acl-grp_ops-grp_billing");
  });

  it("reads deny whether the source row is missing or only the target is", () => {
    const c = draw(GROUPS, { [OPS.id]: { [BILLING.id]: true } });
    // Two different absences reach the same `?? false`: `rules` has no entry
    // for Billing at all, and Ops' entry says nothing about Default. Both are
    // "no rule was written", which is what the server enforces.
    expect(cellAt(c, "Ops", "Default").allowed).toBe("no");
    expect(cellAt(c, "Billing", "Default").allowed).toBe("no");
    expect(cellAt(c, "Default", "Ops").allowed).toBe("no");
  });

  it("cannot say unknown: a policy never read draws exactly like one read as empty", () => {
    // **This is the component's blind spot, pinned so nobody relies on it not
    // existing.** `fetchGroups` deliberately keeps `egress_allowed: null` — the
    // route did not answer with egress at all — apart from `[]`, the tenant
    // genuinely allows nothing. That distinction dies before it reaches here
    // (TenantEgressAclPage collapses both with `|| false`), and this component
    // could not carry it anyway: `boolean` has two states and this is the third.
    // So an unread policy renders as a complete, confident refusal. The caller,
    // not the grid, is the only place that can refuse to draw it.
    const neverRead = grid(draw(GROUPS, {}));
    cleanup();
    const readAsEmpty = grid(
      draw(GROUPS, Object.fromEntries(
        GROUPS.map((s) => [s.id, Object.fromEntries(GROUPS.map((t) => [t.id, false]))]),
      )),
    );
    expect(neverRead).toEqual(readAsEmpty);
    // Every square states a decision; there is no third rendering to look for.
    expect(neverRead.rows.flatMap((r) => r.cells).map((cell) => cell.allowed))
      .toEqual(Array(9).fill("no"));
  });

  it("treats the diagonal as an ordinary pair, denied until someone writes it", () => {
    const denied = draw(GROUPS, {});
    // It used to print a literal self-is-allowed label here. `maySend` has no
    // self-exception — its query is from_group AND to_group and nothing else —
    // so that label contradicted the server for every group except the seeded
    // `default`, and `default` agreeing is why it survived. An exact match, not
    // `toContain`, so re-adding any such word to the cell fails here.
    expect(cellAt(denied, "Ops", "Ops").label).toBe(DENY);
    expect(cellAt(denied, "Ops", "Ops").allowed).toBe("no");
    cleanup();

    const granted = draw(GROUPS, { [OPS.id]: { [OPS.id]: true } });
    expect(cellAt(granted, "Ops", "Ops").label).toBe(ALLOW);
  });

  it("hands the toggle the state it is looking at, not the state it wants", () => {
    const toggled = mock<Toggle>(() => {});
    const c = draw(GROUPS, { [OPS.id]: { [BILLING.id]: true } }, { onToggleRule: toggled });

    fireEvent.click(buttonAt(c, OPS.id, BILLING.id));
    fireEvent.click(buttonAt(c, BILLING.id, OPS.id));

    // The caller writes `!currentAllowed`: passing the *intended* value instead
    // would invert every write, turning a revoke into a POST that re-grants the
    // rule the operator just clicked away.
    expect(toggled.mock.calls[0]).toEqual([OPS.id, BILLING.id, true]);
    // Second click proves the same argument order for the reverse direction —
    // a handler called (target, source) would revoke the wrong route.
    expect(toggled.mock.calls[1]).toEqual([BILLING.id, OPS.id, false]);
    expect(toggled.mock.calls).toHaveLength(2);
  });

  it("refuses the click when read-only, rather than looking clickable and failing later", () => {
    const toggled = mock<Toggle>(() => {});
    const c = draw(GROUPS, {}, { onToggleRule: toggled, readOnly: true });

    expect(buttonAt(c, OPS.id, BILLING.id).disabled).toBe(true);
    fireEvent.click(buttonAt(c, OPS.id, BILLING.id));
    // The caller updates the grid optimistically, so a write that goes out and
    // comes back refused paints an ALLOW that never existed for as long as the
    // round trip takes. A viewer without the capability must not start one.
    expect(toggled.mock.calls).toHaveLength(0);
  });

  it("is inert, not broken, when nobody passed a handler", () => {
    // A read-only page may mount the grid without `onToggleRule` and leave
    // `readOnly` at its default; the optional call is what keeps that from
    // throwing an unhandled error into the page on the first click.
    const c = draw(GROUPS, {});
    expect(() => fireEvent.click(buttonAt(c, OPS.id, BILLING.id))).not.toThrow();
  });

  it("draws exactly the groups it was given, and nothing a rule mentions", () => {
    // Today's behaviour, pinned rather than endorsed: a rule whose target is
    // not in `groups` produces no cell and no warning, so the square looks
    // complete while a live ALLOW sits outside it. Reported, not fixed here.
    const c = draw([OPS, BILLING], { [OPS.id]: { grp_retired: true } });
    expect(c.querySelector('[data-testid="acl-grp_ops-grp_retired"]')).toBe(null);
    expect(grid(c).rows.flatMap((r) => r.cells).map((cell) => cell.allowed))
      .toEqual(["no", "no", "no", "no"]);
  });
});

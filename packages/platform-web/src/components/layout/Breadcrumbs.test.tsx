/**
 * Where the trail says you are, and what it does with a path it cannot name.
 *
 * A breadcrumb is read as a claim about the console's own shape: *this page
 * lives under that section, and that section is somewhere you can go*. So the
 * subject here is `App.tsx`'s route list, not this component's `switch`. The
 * table below used to be transcribed from that `switch`, which meant it could
 * only ever agree with it — a route added to `App.tsx` with no `case` here
 * would ship a crumb reading the raw URL and nothing would fail. It is derived
 * now: the routes are read out of `App.tsx`, narrowed to the pages that mount
 * `<Breadcrumbs />` with no props, and a route with no row is a failure.
 *
 * Two `case`s in the component — `/tenant/egress` and `/tenant/audit` — are
 * spellings the router does not serve and nothing links to; `*` sends them to
 * `/`, which redirects to `/dashboard`, and that page mounts no trail. They are
 * dead, so nothing here holds them: what is held instead is the live half of
 * the same claim, that every destination a crumb offers is a path the router
 * answers.
 *
 * The words asserted below are the English dictionary's, not the Korean
 * fallbacks compiled into the component — `SC-I18N-04` holds this tree at zero
 * Korean characters, so the trail is rendered inside `I18nProvider` and
 * compared against `DICTIONARY.en`.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a paired `unregister()` here would take
// `document` away from a file still using it.
registerDom();

// `await import`, not a statement: a static import is hoisted above the
// registrator and would run against a process with no document.
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { Breadcrumbs } = await import("./Breadcrumbs.tsx");

type Item = { label: string; href?: string };
type Props = { items?: Item[] };

const en = (key: string) => DICTIONARY.en[key]!;

/**
 * The console's routes, read out of `App.tsx` rather than typed here.
 *
 * `SERVED` is every path the router answers, redirects included — what a crumb
 * is allowed to point at. `WITH_TRAIL` narrows that to the routes whose page
 * mounts `<Breadcrumbs />` with no props, which are the only ones the `switch`
 * is answerable for; a page passing `items` draws its own trail and `/dashboard`
 * draws none at all.
 */
const SRC = join(import.meta.dir, "..", "..");
const APP = readFileSync(join(SRC, "App.tsx"), "utf8");

const PAGE_FILES = new Map<string, string>();
for (const m of APP.matchAll(/import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*"@\/([^"]+)"/g)) {
  PAGE_FILES.set(m[1]!, join(SRC, m[2]!));
}

const SERVED: string[] = [];
const WITH_TRAIL: string[] = [];
// Splitting on the opening tag ends a parent route's text where its first child
// begins, so a piece holds one route's own path and element and nothing nested
// inside it. (`</Route>` is not a match — the `/` follows the `<`.)
for (const piece of APP.split("<Route").slice(1)) {
  const pathname = /path="([^"]+)"/.exec(piece)?.[1];
  if (pathname === undefined || pathname === "*") continue;
  SERVED.push(pathname);
  const page = /<([A-Za-z0-9_]*Page)\b/.exec(piece)?.[1];
  const file = page === undefined ? undefined : PAGE_FILES.get(page);
  if (file === undefined) continue; // a redirect has no page of its own
  if (/<Breadcrumbs\s*\/>/.test(readFileSync(file, "utf8"))) WITH_TRAIL.push(pathname);
}

/**
 * The bell this component mounts asks for the pending-key queue on mount, so
 * every render here would otherwise reach for a network that is not there and
 * light the bell's *could not ask* badge over a trail test.
 *
 * Stubbed rather than `mock.module`-ed: replacing `./NotificationBell.tsx`
 * would swap the module for the whole process, and the file that tests the bell
 * captures its export at its own top level — which bun runs before any test in
 * either file. A stubbed answer is a quiet network, not a replaced component,
 * so what `Breadcrumbs` mounts below is the real bell.
 *
 * The request is left unsettled on purpose. An answer — even an empty one —
 * resolves after these synchronous assertions have run, and a state update
 * landing outside `act` is both a warning per render and a mount still moving
 * while the trail is being read. What the queue replies is the bell's own
 * file's subject.
 */
const realFetch = globalThis.fetch;
const noAnswer = mock(() => new Promise<Response>(() => {}));
beforeEach(() => { globalThis.fetch = noAnswer as unknown as typeof globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

const view = (pathname: string, props: Props = {}) =>
  render(
    <I18nProvider>
      {/* A real router rather than a mocked `useLocation`: the assertion is
          what an operator can click, and only a router turns a crumb's `href`
          into an anchor with a destination. */}
      <MemoryRouter initialEntries={[pathname]}>
        <Breadcrumbs {...props} />
      </MemoryRouter>
    </I18nProvider>,
  ).container;

const navAt = (pathname: string, props: Props = {}) =>
  view(pathname, props).querySelector('nav[aria-label="Breadcrumb"]')!;

/**
 * The trail as an operator reads it: each step's word, and where — if anywhere
 * — it goes. `href` is read off the attribute so that a step with nowhere to go
 * comes back `null`; an empty string would be an anchor pointing at the current
 * document, which looks clickable and is not a destination.
 *
 * There is deliberately no second "is it a link" field. `Link` is the only
 * thing in this component that puts an `href` on a step and every other branch
 * is a bare `<span>`, so the attribute *is* that reading; a field carrying
 * `tagName === "A"` restated it on both sides of every expectation below and
 * read as an independent check while being the same fact twice.
 *
 * Separators occupy the odd child positions. The stride of two is safe because
 * "puts a separator between each pair" is asserted directly below.
 */
const crumbs = (nav: Element) =>
  Array.from(nav.children)
    .filter((_, i) => i % 2 === 0)
    .map((el) => ({ label: el.textContent ?? "", href: el.getAttribute("href") }));

const trail = (pathname: string, props: Props = {}) => crumbs(navAt(pathname, props));

beforeEach(() => {
  // The provider restores a saved language, and every word expected here is the
  // English dictionary's. Another file in this process switching to Korean would
  // otherwise decide what this file compares against.
  try { localStorage.removeItem("agent_mesh_lang"); } catch { /* no storage, no saved language */ }
});
afterEach(cleanup);

/**
 * Every route that mounts a trail, and the exact trail it produces.
 *
 * Two things this table records that are easy to lose. *Platform Governance* is
 * a label, not a place — there is no governance index route, so each of its four
 * pages points the section crumb at itself; and `/creator/lease-queue` is
 * labelled the agent mailbox, which is the operator's name for that queue and
 * not the route's.
 */
const ROUTES: Array<[string, Array<[string, string | null]>]> = [
  ["/creator", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.agents", null]]],
  ["/creator/groups", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.groups", null]]],
  ["/creator/topology", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.topology", null]]],
  ["/creator/playground", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.playground", null]]],
  ["/creator/lease-queue", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.mailbox", null]]],
  ["/creator/register", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.register", null]]],
  ["/platform", [["bc.home", "/"], ["bc.platform", "/platform"], ["bc.server", null]]],
  ["/platform/telemetry", [["bc.home", "/"], ["bc.platform", "/platform"], ["bc.telemetry", null]]],
  ["/platform/tenants", [["bc.home", "/"], ["bc.governance", "/platform/tenants"], ["bc.tenants", null]]],
  ["/platform/tenant-directory", [["bc.home", "/"], ["bc.governance", "/platform/tenant-directory"], ["bc.tenantDirectory", null]]],
  ["/platform/users", [["bc.home", "/"], ["bc.governance", "/platform/users"], ["bc.users", null]]],
  ["/tenant/egress-acl", [["bc.home", "/"], ["bc.governance", "/tenant/egress-acl"], ["bc.egress", null]]],
  ["/tenant/audits", [["bc.home", "/"], ["bc.governance", "/tenant/audits"], ["bc.audit", null]]],
  ["/tenant/rbac", [["bc.home", "/"], ["bc.governance", "/tenant/rbac"], ["bc.rbac", null]]],
];

describe("Breadcrumbs, from the route", () => {
  /**
   * This one holds the table, not the component. The expectations below are
   * only worth what their subject list is worth, and transcribed from the
   * switch that list could never disagree with it — which is the one defect a
   * mutant in the component cannot express, and the reason this is an assertion
   * about `App.tsx` rather than about a render.
   */
  it("keeps its table answerable to the console's route list", () => {
    // A floor first: a derivation that stopped matching agrees with everything,
    // which is how a test that reads its own subject goes quietly vacuous.
    expect(WITH_TRAIL.length).toBeGreaterThan(10);
    // A route added to `App.tsx` with no `case` in the switch fails here as a
    // missing row, instead of shipping a crumb that reads the raw URL with
    // nothing to notice. A row for a path nobody serves fails too — which is
    // what rules out writing the `/tenant/egress` spelling into a destination.
    expect([...WITH_TRAIL].sort()).toEqual(ROUTES.map(([pathname]) => pathname).sort());
    // And a crumb is a link an operator clicks: pointed at a path the router
    // does not answer it lands them on the wildcard route, which redirects, and
    // the trail then disagrees with the page they came from.
    const destinations = ROUTES.flatMap(([, steps]) =>
      steps.map(([, href]) => href).filter((href): href is string => href !== null),
    );
    expect([...new Set(destinations)].filter((href) => !SERVED.includes(href))).toEqual([]);
  });

  it("puts every one of them under the section it belongs to, and links only the way back", () => {
    for (const [pathname, expected] of ROUTES) {
      // `toEqual` on the whole trail rather than `toContain` on a word: a
      // dropped section crumb, a duplicated one, or a last step turned into a
      // link all still contain the right words.
      expect(trail(pathname)).toEqual(expected.map(([key, href]) => ({ label: en(key), href })));
      cleanup();
    }
  });

  it("echoes a path it has no label for instead of naming it after another page", () => {
    // Nothing the console serves reaches this arm today — the derivation above
    // is what says so. It is where a route added to `App.tsx` without a `case`
    // here lands, and the shape of that landing is the point: calling an
    // unlabelled path the dashboard, the label sitting one line away in the same
    // branch, tells an operator they are somewhere they are not, and rendering
    // nothing leaves a blank step that reads as a label which failed to load.
    // Home has to survive it too, or an unknown path is a trail of one and the
    // trail stops being navigation.
    //
    // Two paths rather than one, because one path is an example and two are a
    // rule: an arm returning any fixed string, or only the last segment, agrees
    // with a single row.
    const unnamed: Array<[string, string]> = [
      ["/creator/agents/agent-7", "creator/agents/agent-7"],
      ["/reports", "reports"],
    ];
    for (const [pathname, echoed] of unnamed) {
      expect(trail(pathname)).toEqual([
        { label: en("bc.home"), href: "/" },
        { label: echoed, href: null },
      ]);
      cleanup();
    }
  });

  it("puts a separator between each pair and never in front of the first", () => {
    const kids = Array.from(navAt("/creator/groups").children);
    expect(kids.length).toBe(5); // three crumbs, two separators
    expect(kids.filter((_, i) => i % 2 === 1).map((el) => (el.textContent ?? "").trim())).toEqual(["/", "/"]);
    // Separators are decoration. One rendered as an anchor would offer
    // navigation to nothing and would take a keyboard tab stop to do it.
    expect(kids.some((el) => el.tagName === "A" && (el.textContent ?? "").trim() === "/")).toBe(false);
  });

  it("shows which earlier step is under the pointer, then restores it", () => {
    const link = navAt("/creator/groups").querySelector("a");
    if (!link) throw new Error("the route trail has no linked earlier step");

    expect(link.style.color).toBe("var(--color-text-secondary)");
    fireEvent.mouseEnter(link);
    expect(link.style.color).toBe("var(--color-primary)");
    fireEvent.mouseLeave(link);
    expect(link.style.color).toBe("var(--color-text-secondary)");
  });

  it("mounts the registration bell beside the trail, outside the nav", () => {
    // The bell is the only surface a pending agent registration appears on, and
    // it hangs off this component rather than off any page — a header that
    // stopped rendering it would take the whole queue off the screen without
    // any page noticing. Beside the trail, not in it: it is not a step, and a
    // reader walking `nav` must not find it there.
    const container = view("/creator");
    expect(container.querySelector('[data-testid="bell"]')).not.toBe(null);
    expect(navAt("/creator").querySelector('[data-testid="bell"]')).toBe(null);
  });
});

describe("Breadcrumbs, from the caller", () => {
  it("uses the given trail instead of the route's, without merging the two", () => {
    const nav = navAt("/creator/groups", {
      items: [{ label: "Groups", href: "/creator/groups" }, { label: "platform-team" }],
    });
    expect(crumbs(nav).map((c) => c.label)).toEqual(["Groups", "platform-team"]);
    // Merged instead of replaced, the route's own first step would still be in
    // front, and a caller could not draw a trail that omits it.
    expect(nav.textContent).not.toContain(en("bc.home"));
  });

  it("treats an empty trail as a trail, not as a missing one", () => {
    // `[]` is a caller saying *this page has no trail*, and the route's steps
    // are not a repair for it — drawn instead, they are the steps the caller
    // deliberately removed. The fallback has to turn on whether `items` was
    // given, not on whether it holds anything: `items?.length ? items : route`
    // is the shape that reads an empty trail as an absent one, and this is the
    // only assertion in the file that tells those two apart. (`||` and `??` do
    // not differ here — `[]` is truthy, so both keep it.)
    expect(trail("/creator/groups", { items: [] })).toEqual([]);
    cleanup();
    expect(trail("/creator/groups").length).toBe(3);
  });

  it("never links the page you are already on, even when the caller gives it a href", () => {
    const got = trail("/creator", {
      items: [{ label: "Studio", href: "/creator" }, { label: "Agents", href: "/creator" }],
    });
    expect(got[0]!.href).toBe("/creator");
    // The last step is where you are. Drawn as a link it claims there is
    // somewhere else to go, and clicking it reloads the page you are reading.
    expect(got[1]!.href).toBe(null);
  });

  it("draws a step with nowhere to go as text, not as a link with no destination", () => {
    // A middle step without a href is a section that has no page of its own.
    // Rendered as an anchor with an empty href it would be a control that looks
    // live and reloads the current document instead.
    expect(trail("/creator", { items: [{ label: "Tenant" }, { label: "Keys", href: "/x" }] })[0])
      .toEqual({ label: "Tenant", href: null });
  });
});

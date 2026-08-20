/**
 * Where the trail says you are, and what it does with a path it cannot name.
 *
 * A breadcrumb is read as a claim about the console's own shape: *this page
 * lives under that section, and that section is somewhere you can go*. Two of
 * the mappings here are not the path you arrived on — `/tenant/egress` and
 * `/tenant/audit` are aliases the router does not serve — so a section crumb
 * built out of `location.pathname` would offer an operator a link to a page
 * that only redirects. And the last arm of the switch is the interesting one:
 * a path with no label is drawn from the URL itself, which is honest, while
 * the branch one line away holds a label for a page it is not.
 *
 * The words asserted below are the English dictionary's, not the Korean
 * fallbacks compiled into the component — `SC-I18N-04` holds this tree at zero
 * Korean characters, so the trail is rendered inside `I18nProvider` and
 * compared against `DICTIONARY.en`.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a paired `unregister()` here would take
// `document` away from a file still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, not a statement: a static import is hoisted above the
// registrator and would run against a process with no document.
const { render, cleanup } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { Breadcrumbs } = await import("./Breadcrumbs.tsx");

type Item = { label: string; href?: string };
type Props = { items?: Item[] };

const en = (key: string) => DICTIONARY.en[key]!;

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
 * Separators occupy the odd child positions. The stride of two is safe because
 * "puts a separator between each pair" is asserted directly below.
 */
const crumbs = (nav: Element) =>
  Array.from(nav.children)
    .filter((_, i) => i % 2 === 0)
    .map((el) => ({
      label: el.textContent ?? "",
      href: el.getAttribute("href"),
      linked: el.tagName === "A",
    }));

const trail = (pathname: string, props: Props = {}) => crumbs(navAt(pathname, props));

beforeEach(() => {
  // The provider restores a saved language, and every word expected here is the
  // English dictionary's. Another file in this process switching to Korean would
  // otherwise decide what this file compares against.
  try { localStorage.removeItem("agent_mesh_lang"); } catch { /* no storage, no saved language */ }
});
afterEach(cleanup);

/**
 * Every path the switch names, and the exact trail it produces.
 *
 * Two things this table records that are easy to lose. *Platform Governance* is
 * a label, not a place — there is no governance index route, so each of its four
 * pages points the section crumb at itself; and `/creator/lease-queue` is
 * labelled the agent mailbox, which is the operator's name for that queue and
 * not the route's.
 */
const ROUTES: Array<[string, Array<[string, string | null]>]> = [
  ["/", [["bc.home", "/"], ["bc.dashboard", null]]],
  ["/creator", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.agents", null]]],
  ["/creator/groups", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.groups", null]]],
  ["/creator/topology", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.topology", null]]],
  ["/creator/playground", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.playground", null]]],
  ["/creator/lease-queue", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.mailbox", null]]],
  ["/creator/register", [["bc.home", "/"], ["bc.studio", "/creator"], ["bc.register", null]]],
  ["/platform", [["bc.home", "/"], ["bc.platform", "/platform"], ["bc.server", null]]],
  ["/platform/telemetry", [["bc.home", "/"], ["bc.platform", "/platform"], ["bc.telemetry", null]]],
  ["/platform/tenants", [["bc.home", "/"], ["bc.governance", "/platform/tenants"], ["bc.tenants", null]]],
  ["/platform/users", [["bc.home", "/"], ["bc.governance", "/platform/users"], ["bc.users", null]]],
  ["/tenant/egress-acl", [["bc.home", "/"], ["bc.governance", "/tenant/egress-acl"], ["bc.egress", null]]],
  ["/tenant/audits", [["bc.home", "/"], ["bc.governance", "/tenant/audits"], ["bc.audit", null]]],
  ["/tenant/rbac", [["bc.home", "/"], ["bc.governance", "/tenant/rbac"], ["bc.rbac", null]]],
];

describe("Breadcrumbs, from the route", () => {
  it("puts every known path under the section it belongs to, and links only the way back", () => {
    for (const [pathname, expected] of ROUTES) {
      // `toEqual` on the whole trail rather than `toContain` on a word: a
      // dropped section crumb, a duplicated one, or a last step turned into a
      // link all still contain the right words.
      expect(trail(pathname)).toEqual(
        expected.map(([key, href]) => ({ label: en(key), href, linked: href !== null })),
      );
      cleanup();
    }
  });

  it("links the section at the route the app serves, not at the alias you arrived on", () => {
    // `/tenant/egress` and `/tenant/audit` are not routes in `App.tsx`; only the
    // plural forms are. A section crumb echoing `location.pathname` would hand
    // an operator a link to a path the router answers with a redirect, and the
    // trail would then disagree with itself depending on how the page was
    // reached.
    expect(trail("/tenant/egress")[1]).toEqual({
      label: en("bc.governance"), href: "/tenant/egress-acl", linked: true,
    });
    expect(trail("/tenant/audit")[1]).toEqual({
      label: en("bc.governance"), href: "/tenant/audits", linked: true,
    });
  });

  it("gives an alias the same trail as the route it stands for", () => {
    expect(trail("/tenant/egress")).toEqual(trail("/tenant/egress-acl"));
    expect(trail("/tenant/audit")).toEqual(trail("/tenant/audits"));
  });

  it("echoes a path it has no label for instead of naming it after another page", () => {
    // Worth knowing where this arm is reached from: `App.tsx` serves the
    // dashboard at `/dashboard` and the sidebar links there, while the switch
    // above names only `/` — which the router immediately redirects away from.
    // So the console's landing page arrives here, and is drawn from its URL. An
    // unlabelled path is asserted instead, because that behaviour is the arm's
    // job; `/dashboard` reaching it is a gap in the switch, not a decision.
    const got = trail("/creator/agents/agent-7");
    // Two worse answers are ruled out here. Calling an unlabelled path the
    // dashboard — the label sitting one line away in the same branch — tells an
    // operator they are somewhere they are not; and rendering nothing leaves a
    // blank step, which reads as a label that failed to load rather than as a
    // page the trail does not know.
    expect(got).toEqual([
      { label: en("bc.home"), href: "/", linked: true },
      { label: "creator/agents/agent-7", href: null, linked: false },
    ]);
    expect(got[1]!.label).not.toBe(en("bc.dashboard"));
  });

  it("keeps the way home on a path it cannot name", () => {
    // The one crumb that must survive the fallback: without it an unknown path
    // is a trail of one, and the trail stops being navigation.
    expect(trail("/whatever/this/is")[0]).toEqual({ label: en("bc.home"), href: "/", linked: true });
  });

  it("puts a separator between each pair and never in front of the first", () => {
    const kids = Array.from(navAt("/creator/groups").children);
    expect(kids.length).toBe(5); // three crumbs, two separators
    expect(kids.filter((_, i) => i % 2 === 1).map((el) => (el.textContent ?? "").trim())).toEqual(["/", "/"]);
    // Separators are decoration. One rendered as an anchor would offer
    // navigation to nothing and would take a keyboard tab stop to do it.
    expect(kids.some((el) => el.tagName === "A" && (el.textContent ?? "").trim() === "/")).toBe(false);
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
    // `items || route` and `items ?? route` differ exactly here. `[]` is a
    // caller saying *this page has no trail*; falling back to the route's would
    // draw the steps the caller deliberately removed. Absent is `undefined`,
    // and empty is not absent.
    expect(trail("/creator/groups", { items: [] })).toEqual([]);
    cleanup();
    expect(trail("/creator/groups").length).toBe(3);
  });

  it("never links the page you are already on, even when the caller gives it a href", () => {
    const got = trail("/creator", {
      items: [{ label: "Studio", href: "/creator" }, { label: "Agents", href: "/creator" }],
    });
    expect(got[0]!.linked).toBe(true);
    // The last step is where you are. Drawn as a link it claims there is
    // somewhere else to go, and clicking it reloads the page you are reading.
    expect(got[1]!.linked).toBe(false);
    expect(got[1]!.href).toBe(null);
  });

  it("draws a step with nowhere to go as text, not as a link with no destination", () => {
    // A middle step without a href is a section that has no page of its own.
    // Rendered as an anchor with an empty href it would be a control that looks
    // live and reloads the current document instead.
    expect(trail("/", { items: [{ label: "Tenant" }, { label: "Keys", href: "/x" }] })[0])
      .toEqual({ label: "Tenant", href: null, linked: false });
  });
});

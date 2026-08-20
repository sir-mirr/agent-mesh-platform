/**
 * What the menu tells a person about their own access.
 *
 * Two of this component's defects were found by somebody looking at the screen,
 * because nothing else could see them. Six items named capabilities the
 * contract does not define, and a name nobody holds hides its item from
 * everybody — so the menu was identical for a platform operator, a tenant admin
 * and an ordinary user, and no check objected. And the footer drew
 * `admin (…)`: a Korean noun appended to the role the server returned, over a
 * default title nobody had granted.
 *
 * `test/sidebar-guards.test.ts` compares this table against `App.tsx`'s routes
 * from the source, which settles whether the two files ask for the same names.
 * It cannot settle what a viewer holding one capability actually sees — a
 * filter that ignored its argument entirely would agree with every route in the
 * file — and that is what is asserted here.
 *
 * **A real router, and a real dictionary.** `mock.module` is global to the
 * process and outlives the file that calls it: a `useLocation` stub here put
 * every one of `Breadcrumbs.test.tsx`'s five assertions on the wrong path,
 * because bun runs every file's top level before any test and the last
 * replacement of a module wins. Nothing this file needs is easier to reach
 * through a mock than through `MemoryRouter`, so nothing is mocked.
 *
 * The imports are `await import` all the same: a static import is hoisted above
 * `GlobalRegistrator.register()` and would load `@testing-library/react` into a
 * process with no document.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SidebarProps } from "./Sidebar.tsx";

// **Registered once for the process, and never unregistered.** Bun runs every
// test file's top level before any test, so a file that unregisters takes the
// document away from a file still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { Sidebar } = await import("./Sidebar.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

const COLLAPSED_KEY = "agent_mesh_sidebar_collapsed";
const LANG_KEY = "agent_mesh_lang";

// Rendered inside the real provider, which defaults to English, so the words
// compared below are the dictionary's. The fallbacks compiled into the
// component are Korean, and `SC-I18N-04` holds this whole tree to zero Korean
// characters — an assertion written against a fallback would be the violation.
const show = (props: SidebarProps = {}, pathname = "/dashboard") =>
  render(
    <I18nProvider>
      {/* A real router, because "which item is the page you are on" is decided
          from `useLocation`, and a stubbed location is a claim about the test
          rather than about the router the console actually mounts. */}
      <MemoryRouter initialEntries={[pathname]}>
        <Sidebar {...props} />
      </MemoryRouter>
    </I18nProvider>,
  );

/** Scoped to the `<aside>`: a document-wide `a[href]` once counted a dashboard
 *  link as a sidebar item and reported a menu entry that was not in the menu. */
const aside = () => document.querySelector("aside")!;
const hrefs = () =>
  Array.from(aside().querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));

/** Every destination offered to somebody holding no capability at all. */
const UNGATED = [
  "/dashboard",
  "/creator",
  "/creator/groups",
  "/creator/topology",
  "/creator/playground",
  "/creator/lease-queue",
  "/creator/register",
  "/platform",
  "/platform/telemetry",
];

/** Each guarded destination and the one capability that reveals it. */
const GATED: ReadonlyArray<readonly [string, string]> = [
  ["/platform/tenants", "tenant.read.stats"],
  ["/tenant/egress-acl", "group.manage"],
  ["/tenant/audits", "audit.read.metadata"],
  ["/platform/users", "user.admit"],
  ["/tenant/rbac", "role.grant"],
];

beforeEach(() => {
  localStorage.removeItem(COLLAPSED_KEY);
  localStorage.removeItem(LANG_KEY);
});
afterEach(() => {
  cleanup();
  // Both keys are cleared again on the way out. `localStorage` outlives this
  // file the same way the document does, and a language left set to Korean here
  // would make the next file's provider start in Korean and fail its own
  // English assertions — for a reason nothing in that file mentions.
  localStorage.removeItem(COLLAPSED_KEY);
  localStorage.removeItem(LANG_KEY);
});

describe("Sidebar capability filter", () => {
  it("offers every ungated destination to somebody holding nothing", () => {
    show({ userCapabilities: [] });
    // Exactly these, in this order: the list is closed at both ends, so an item
    // that stops being gated is as much a failure as one that stops appearing.
    // `/platform` and `/platform/telemetry` are in it deliberately — their
    // routes gate on a session and nothing more, and a menu stricter than the
    // route hides a page the person is allowed to open and can reach by URL.
    expect(hrefs()).toEqual(UNGATED);
  });

  it("reveals a guarded destination only to the holder of its own capability", () => {
    for (const [href, capability] of GATED) {
      show({ userCapabilities: [capability] });
      const shown = hrefs();
      expect(shown).toContain(href);
      // And none of the others. One capability standing in for the rest is the
      // shape § 11 exists to undo, and a filter that let any capability through
      // would satisfy the line above on its own.
      for (const [other] of GATED) {
        if (other !== href) expect(shown).not.toContain(other);
      }
      cleanup();
    }
  });

  it("shows the whole menu to somebody holding every name", () => {
    show({ userCapabilities: GATED.map(([, capability]) => capability) });
    // Written out rather than assembled from the two lists above, so this says
    // what an administrator sees in the order they see it and does not repeat
    // whatever mistake the lists might contain.
    expect(hrefs()).toEqual([
      "/dashboard",
      "/creator",
      "/creator/groups",
      "/creator/topology",
      "/creator/playground",
      "/creator/lease-queue",
      "/creator/register",
      "/platform",
      "/platform/telemetry",
      "/platform/tenants",
      "/tenant/egress-acl",
      "/tenant/audits",
      "/platform/users",
      "/tenant/rbac",
    ]);
  });

  it("does not accept an all-powerful name in place of the twelve", () => {
    // `admin.all` is not in the contract and must not come back: "is an
    // administrator" is not a capability, and one name standing for all of them
    // is exactly what § 11 replaced. An admin holds the names individually.
    show({ userCapabilities: ["admin.all", "admin", "*"] });
    expect(hrefs()).toEqual(UNGATED);
  });

  it("compares capability names whole rather than by prefix", () => {
    // `audit.read` is not `audit.read.content`, and the difference between them
    // is § 11's privacy boundary: seeing that mail exists is a different
    // authorisation from reading it. A prefix comparison would hand the second
    // to every holder of the first.
    show({ userCapabilities: ["role", "audit.read", "tenant.read", "group"] });
    expect(hrefs()).toEqual(UNGATED);
  });

  it("drops a section heading when every item under it is hidden", () => {
    // A heading with nothing under it tells a person they have a console they
    // cannot open, and leaves them hunting for the items that would be in it.
    show({ userCapabilities: [] });
    expect(aside().textContent).not.toContain(DICTIONARY.en["nav.sec.tenant"]!);
    cleanup();

    // The other direction, because a component that never drew that heading at
    // all would pass the assertion above.
    show({ userCapabilities: ["role.grant"] });
    expect(aside().textContent).toContain(DICTIONARY.en["nav.sec.tenant"]!);
  });
});

describe("Sidebar viewer identity", () => {
  it("prints the role the server returned and appends nothing to it", () => {
    // The defect: `admin (…)` on every screen, the brackets holding a Korean
    // noun the client added to a role the server had named, over a default
    // title nobody had granted — neither of them anything a server said. So
    // the two renders are compared rather than searched: with the role removed,
    // the tree must be *character for character* the tree drawn for a viewer
    // whose role is unknown. A decoration on either side moves that equality,
    // and `toContain` would not have noticed either one.
    show({ userName: "kim", userRole: "PLATFORM_ADMIN" });
    const withRole = aside().textContent ?? "";
    cleanup();

    show({ userName: "kim" });
    const withoutRole = aside().textContent ?? "";

    expect(withRole).toContain("PLATFORM_ADMIN");
    expect(withRole.replace("PLATFORM_ADMIN", "")).toBe(withoutRole);
  });

  it("leaves the role blank when there is none rather than guessing one", () => {
    // Absent has to look absent. A plausible constant in a field an operator
    // reads to know whose session this is is worse than a blank: it cannot be
    // told from a role the server really returned.
    show({ userName: "kim" });
    const text = aside().textContent ?? "";
    for (const invented of ["PLATFORM_ADMIN", "TENANT_ADMIN", "GROUP_ADMIN", "AGENT_OPERATOR"]) {
      expect(text).not.toContain(invented);
    }
  });
});

describe("Sidebar collapse", () => {
  const collapseTitle = DICTIONARY.en["nav.collapse"]!;
  const expandTitle = DICTIONARY.en["nav.expand"]!;
  const button = (title: string) => aside().querySelector<HTMLButtonElement>(`button[title="${title}"]`);

  it("keeps every destination when the labels go away", () => {
    show({ userCapabilities: ["role.grant"] });
    const expanded = hrefs();
    fireEvent.click(button(collapseTitle)!);

    // Collapsing is about width, not about access: the same links are still
    // there, reachable, and only their words are gone. A collapse that filtered
    // would silently take a page away from somebody who has it.
    expect(hrefs()).toEqual(expanded);
    expect(aside().textContent).not.toContain(DICTIONARY.en["nav.dashboard"]!);
    expect(aside().textContent).not.toContain(DICTIONARY.en["nav.sec.tenant"]!);
    expect(button(expandTitle)).not.toBe(null);
  });

  it("remembers the choice for the next mount", () => {
    show();
    fireEvent.click(button(collapseTitle)!);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe("true");
    cleanup();

    show();
    expect(button(expandTitle)).not.toBe(null);
    // And back, so the stored value is a state rather than a one-way latch.
    fireEvent.click(button(expandTitle)!);
    expect(localStorage.getItem(COLLAPSED_KEY)).toBe("false");
    expect(button(collapseTitle)).not.toBe(null);
  });

  it("treats anything that is not the word true as not collapsed", () => {
    // The stored value is compared as a string, so `"1"` — the other obvious
    // way to write this down, and what a hand-edited profile may hold — must
    // not half-open the menu.
    localStorage.setItem(COLLAPSED_KEY, "1");
    show();
    expect(button(collapseTitle)).not.toBe(null);
    expect(aside().textContent).toContain(DICTIONARY.en["nav.dashboard"]!);
  });

  it("still draws the navigation when storage is unavailable", () => {
    // A browser with storage switched off must lose the remembered width, not
    // the menu. The read happens while the state initialiser runs and the write
    // inside the click, so an uncaught throw at either point takes down the
    // whole shell and every screen inside it.
    //
    // Swapped through the global's own descriptor rather than by assigning over
    // `localStorage.getItem`: that assignment is silently absorbed by
    // happy-dom's storage proxy, and this test passed against a perfectly
    // working `localStorage` until the line below caught it.
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    const dead = {
      getItem: () => { throw new Error("storage is disabled"); },
      setItem: () => { throw new Error("storage is disabled"); },
      removeItem: () => { throw new Error("storage is disabled"); },
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dead });
    try {
      expect(() => localStorage.getItem(COLLAPSED_KEY)).toThrow();

      show({ userCapabilities: ["role.grant"] });
      expect(hrefs()).toContain("/tenant/rbac");
      expect(button(collapseTitle)).not.toBe(null);

      // And the preference still works for this session, unremembered: a failed
      // write is a reason not to persist the choice, not a reason to refuse it.
      fireEvent.click(button(collapseTitle)!);
      expect(button(expandTitle)).not.toBe(null);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("Sidebar current page", () => {
  const highlighted = () =>
    Array.from(aside().querySelectorAll("a[href]"))
      .filter((a) => (a.getAttribute("style") ?? "").includes("--color-primary-light"))
      .map((a) => a.getAttribute("href"));

  it("marks the one item whose path is open, and only that one", () => {
    show({}, "/creator/groups");
    // `/creator` is a prefix of the open path and must not light up with it:
    // two items drawn as current tells a person the menu does not know where
    // they are.
    expect(highlighted()).toEqual(["/creator/groups"]);
  });

  it("marks nothing when the open path is not in the menu", () => {
    // A detail page under a menu entry is not that entry. Drawing the nearest
    // item as current would be a guess, and the honest answer is none.
    show({ userCapabilities: ["user.admit"] }, "/platform/users/abc-123");
    expect(highlighted()).toEqual([]);
  });
});

describe("Sidebar language control", () => {
  const openPopover = () => {
    fireEvent.click(aside().querySelector<HTMLButtonElement>(
      `button[title="${DICTIONARY.en["nav.lang"]!}"]`,
    )!);
  };
  // Located through the dictionary rather than typed out: the Korean option is
  // labelled in Korean in both locales, and this file may hold no Korean.
  const koreanOption = () => screen.queryByText(DICTIONARY.en["lang.ko"]!);

  it("relabels the menu and records the choice", () => {
    show();
    expect(koreanOption()).toBe(null);
    openPopover();
    fireEvent.click(koreanOption()!);

    // The control has to change the product, not just its own highlight — the
    // whole point of the switch is that an operator elsewhere can read the
    // console, and a toggle that only remembers itself looks identical.
    expect(aside().textContent).toContain(DICTIONARY.ko["nav.dashboard"]!);
    expect(aside().textContent).not.toContain(DICTIONARY.en["nav.sec.studio"]!);
    expect(localStorage.getItem(LANG_KEY)).toBe("ko");
  });

  it("closes the popover on a click outside it", () => {
    show();
    openPopover();
    expect(koreanOption()).not.toBe(null);
    // The listener is attached to the document while the popover is open; if it
    // is never removed, the menu stays covered by a panel the person has
    // already dismissed with their eyes.
    fireEvent.mouseDown(document.body);
    expect(koreanOption()).toBe(null);
  });
});

describe("Sidebar sign-out", () => {
  it("calls back exactly once when the control is used", () => {
    const onLogout = mock(() => {});
    show({ onLogout });
    fireEvent.click(screen.getByTestId("logout"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("offers no sign-out control when the caller gave no way to sign out", () => {
    // A button that ends a session has to end one. Drawing it with nothing
    // behind it teaches a person they have signed out when they have not.
    show();
    expect(screen.queryByTestId("logout")).toBe(null);
  });
});

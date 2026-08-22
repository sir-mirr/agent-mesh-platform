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
const ROLE_GATED = "/platform/tenant-directory";

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

  it("reveals every guarded destination at once to somebody holding all of them", () => {
    // This was a hand-copied list of today's fourteen entries. It read as a
    // rule and was a snapshot: it would fail on any legitimate menu addition,
    // and every defect it caught was already caught by the two tests above.
    //
    // What it is actually for is the one thing neither of those can see. Both
    // render zero capabilities or exactly one, so a filter that reveals *at
    // most one* guarded item — `userCapabilities[0] === item.requiredCapability`
    // — agrees with both of them and hands an administrator a menu missing four
    // of the five consoles they hold. Holding all five has to reveal all five.
    show({ userCapabilities: GATED.map(([, capability]) => capability) });
    const shown = hrefs();
    for (const [href] of GATED) expect(shown).toContain(href);

    // Closed at both ends by count, so an item drawn twice — one section
    // repeating another's entry — is as much a failure as one gone missing.
    expect(shown).toHaveLength(UNGATED.length + GATED.length);

    // And the ungated items keep their order among the rest: a section that
    // reorders or drops one while the guarded ones all still appear would
    // satisfy every line above.
    expect(shown.filter((href): href is string => href !== null && UNGATED.includes(href)))
      .toEqual(UNGATED);
  });

  it("does not accept an all-powerful name in place of the twelve", () => {
    // `admin.all` is not in the contract and must not come back: "is an
    // administrator" is not a capability, and one name standing for all of them
    // is exactly what § 11 replaced. An admin holds the names individually.
    show({ userCapabilities: ["admin.all", "admin", "*"] });
    expect(hrefs()).toEqual(UNGATED);
  });

  it("offers tenant management only for the role the server uses as its T-026 stand-in", () => {
    show({ userName: "platform-admin", userRole: "AGENT_OPERATOR", userCapabilities: [] });
    expect(hrefs()).not.toContain(ROLE_GATED);
    cleanup();

    show({ userName: "somebody-else", userRole: "PLATFORM_ADMIN", userCapabilities: [] });
    expect(hrefs()).toContain(ROLE_GATED);
  });

  it("compares capability names whole rather than by prefix", () => {
    // `audit.read` is not `audit.read.content`, and the difference between them
    // is § 11's privacy boundary: seeing that mail exists is a different
    // authorisation from reading it. A prefix comparison would hand the second
    // to every holder of the first.
    // The prefixes are cut from the real names rather than typed. Two reasons:
    // a namespaced name written here that the contract does not define fails
    // `capability-vocabulary`, which is right — an invented name in a test
    // reads as a real one — and a derived prefix follows the name if § 11 ever
    // renames it.
    const prefixOf = (name: string) => name.split(".").slice(0, -1).join(".");
    show({
      userCapabilities: [
        prefixOf("role.grant"),
        prefixOf("audit.read.metadata"),
        prefixOf("tenant.read.stats"),
      ],
    });
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
  const VIEWER = "operator-7";

  /**
   * The line under the account name in the footer — the field an operator reads
   * to know what this session is authorised to do.
   *
   * Found by the name it sits under rather than by a position in the tree, so a
   * wrapper added around the footer moves it without breaking this, and a
   * footer that stopped drawing the name at all fails here rather than silently
   * reading some other element's text.
   */
  const roleSlot = (): Element => {
    const nameSlot = Array.from(aside().querySelectorAll("div")).find(
      (d) => d.children.length === 0 && d.textContent === VIEWER,
    );
    expect(nameSlot, "the footer never printed the account name").not.toBe(undefined);
    const role = nameSlot!.nextElementSibling;
    expect(role, "the account name has no role line under it").not.toBe(null);
    return role!;
  };

  it("prints the role the server returned and appends nothing to it", () => {
    // The defect: `admin (…)` on every screen, the brackets holding a Korean
    // noun the client added to a role the server had named, over a default
    // title nobody had granted — neither of them anything a server said. So
    // the two renders are compared rather than searched: with the role removed,
    // the tree must be *character for character* the tree drawn for a viewer
    // whose role is unknown. A decoration on either side moves that equality,
    // and `toContain` would not have noticed either one.
    show({ userName: "kim", userRole: "AGENT_OPERATOR" });
    const withRole = aside().textContent ?? "";
    cleanup();

    show({ userName: "kim" });
    const withoutRole = aside().textContent ?? "";

    expect(withRole).toContain("AGENT_OPERATOR");
    expect(withRole.replace("AGENT_OPERATOR", "")).toBe(withoutRole);
  });

  it("leaves the role blank when there is none rather than guessing one", () => {
    // Absent has to look absent. A plausible constant in a field an operator
    // reads to know whose session this is is worse than a blank: it cannot be
    // told from a role the server really returned.
    //
    // The slot itself is read, not the footer searched for four names somebody
    // thought of. A denylist only denies what is on it: it passed against a
    // default of `admin` — the component's own default for the name beside it —
    // and against `{userRole || userName}`, which prints the account name where
    // its authorisation belongs.
    show({ userName: VIEWER });
    expect(roleSlot().textContent).toBe("");
    cleanup();

    // The other direction, because a footer that had no role slot at all, or
    // one it never filled, would satisfy the line above and tell an operator
    // nothing about the session they are in.
    show({ userName: VIEWER, userRole: "PLATFORM_ADMIN" });
    expect(roleSlot().textContent).toBe("PLATFORM_ADMIN");
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
      // A precondition on the fixture, deliberately not an `expect`. Nothing
      // has rendered yet, so it can say nothing about Sidebar, and written as
      // an expectation it was counted and read as coverage — this test's
      // expectation count should be what the component actually did. It stays
      // because the swap really did fail once: assigning over
      // `localStorage.getItem` is absorbed by happy-dom's storage proxy, and
      // everything below then passed against a working `localStorage` while
      // claiming to prove the opposite.
      let swapped = false;
      try { localStorage.getItem(COLLAPSED_KEY); } catch { swapped = true; }
      if (!swapped) throw new Error("fixture: localStorage was not replaced by the dead one");

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
  // The trigger carries a translated `title`, so the locale currently on screen
  // has to be named to find it again after a switch. Read out of the dictionary
  // in both cases; this file may hold no Korean.
  const openPopover = (language: "en" | "ko" = "en") => {
    fireEvent.click(aside().querySelector<HTMLButtonElement>(
      `button[title="${DICTIONARY[language]["nav.lang"]!}"]`,
    )!);
  };
  // Located through the dictionary rather than typed out: the Korean option is
  // labelled in Korean in both locales, and this file may hold no Korean.
  const koreanOption = () => screen.queryByText(DICTIONARY.en["lang.ko"]!);
  /** Whether the panel is on screen, as a boolean. A failed `toBe(null)`
   *  against a DOM node serialises its whole subtree to build a diff, and
   *  reports a five-second timeout instead of the element it found. */
  const popoverIsOpen = () => koreanOption() !== null;

  /**
   * The document-level `mousedown` listeners live at this moment.
   *
   * Counted, because both rules the outside-click effect has are invisible in
   * the rendered tree: that the listener exists only while the popover is open,
   * and that the cleanup takes it away again. A leaked one shows nothing to
   * anybody — after unmount its ref is null and its guard simply returns — and
   * it accumulates one per open for as long as the tab is up.
   */
  type Listener = Parameters<Document["addEventListener"]>[1];
  const trackMousedown = () => {
    const live = new Set<Listener>();
    const realAdd = document.addEventListener;
    const realRemove = document.removeEventListener;
    document.addEventListener = function (
      this: Document,
      type: string,
      listener: Listener,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "mousedown") live.add(listener);
      realAdd.call(this, type, listener, options);
    } as Document["addEventListener"];
    document.removeEventListener = function (
      this: Document,
      type: string,
      listener: Listener,
      options?: boolean | EventListenerOptions,
    ) {
      if (type === "mousedown") live.delete(listener);
      realRemove.call(this, type, listener, options);
    } as Document["removeEventListener"];
    return {
      live: () => live.size,
      restore: () => {
        // Restored on every path. `document` outlives this file the same way
        // the registration does, and a wrapper left on it would follow every
        // later file's renders around.
        document.addEventListener = realAdd;
        document.removeEventListener = realRemove;
      },
    };
  };

  it("relabels the menu out of the dictionary, and records the choice", () => {
    show();
    expect(popoverIsOpen()).toBe(false);
    openPopover();
    fireEvent.click(koreanOption()!);

    // Anchored on entries whose Korean *dictionary* value differs from the
    // Korean fallback compiled into the component, which most of them do not —
    // and that is what made this assertion vacuous. `nav.dashboard`'s entry is
    // character-for-character its own fallback, so a label that ignored the
    // dictionary entirely still read here as translated, which is precisely the
    // defect the switch exists to prevent.
    expect(aside().textContent).toContain(DICTIONARY.ko["nav.agents.desc"]!);
    // The playground's fallback is its *English* string, so this word is gone
    // only if the dictionary was consulted; a fallback render still prints it.
    expect(aside().textContent).not.toContain(DICTIONARY.en["dash.playgroundLink"]!);
    expect(aside().textContent).not.toContain(DICTIONARY.en["nav.sec.studio"]!);
    expect(localStorage.getItem(LANG_KEY)).toBe("ko");

    // And back, because "not English" is not "Korean": a component that had
    // stopped resolving anything at all satisfies every negative above, and an
    // operator who switched by accident has to be able to undo it.
    openPopover("ko");
    fireEvent.click(screen.getByText("English"));
    expect(aside().textContent).toContain(DICTIONARY.en["nav.sec.studio"]!);
    expect(aside().textContent).not.toContain(DICTIONARY.ko["nav.agents.desc"]!);
    expect(localStorage.getItem(LANG_KEY)).toBe("en");
  });

  it("offers hover feedback on whichever language is not selected", () => {
    const hoverCallbacks = (button: HTMLButtonElement) => {
      const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
      const props = propsKey
        ? (button as unknown as Record<string, Record<string, unknown>>)[propsKey]
        : undefined;
      if (typeof props?.onMouseEnter !== "function" || typeof props?.onMouseLeave !== "function") {
        throw new Error("the language option has no hover callbacks");
      }
      return { enter: props.onMouseEnter, leave: props.onMouseLeave };
    };

    show();
    openPopover();

    const korean = koreanOption()?.closest("button") as HTMLButtonElement | null;
    if (!korean) throw new Error("the language popover has no Korean option");
    const koreanHover = hoverCallbacks(korean);
    const koreanTarget = { style: { background: "" } };
    koreanHover.enter({ currentTarget: koreanTarget });
    if (koreanTarget.style.background !== "var(--color-bg-surface-hover, #F8FAFC)") {
      throw new Error(`the inactive Korean option did not show its hover affordance: ${JSON.stringify(koreanTarget.style.background)}`);
    }
    koreanHover.leave({ currentTarget: koreanTarget });
    if (String(koreanTarget.style.background) !== "transparent") {
      throw new Error("the inactive Korean option kept its hover affordance after the pointer left");
    }

    fireEvent.click(korean);
    openPopover("ko");
    const english = screen.getByText("English").closest("button") as HTMLButtonElement | null;
    if (!english) throw new Error("the language popover has no English option");
    const englishHover = hoverCallbacks(english);
    const englishTarget = { style: { background: "" } };
    englishHover.enter({ currentTarget: englishTarget });
    if (englishTarget.style.background !== "var(--color-bg-surface-hover, #F8FAFC)") {
      throw new Error(`the inactive English option did not show its hover affordance: ${JSON.stringify(englishTarget.style.background)}`);
    }
    englishHover.leave({ currentTarget: englishTarget });
    if (String(englishTarget.style.background) !== "transparent") {
      throw new Error("the inactive English option kept its hover affordance after the pointer left");
    }
  });

  it("leaves the popover open when the mousedown is inside it", () => {
    // "Outside" is the whole rule, and nothing here checked it: closing on any
    // mousedown anywhere — the guard replaced by a bare `setIsLangOpen(false)`
    // — satisfies a test that only ever presses the body, while taking the
    // panel out from under the pointer of somebody reading the two options.
    show();
    openPopover();
    fireEvent.mouseDown(koreanOption()!);
    expect(popoverIsOpen()).toBe(true);
  });

  it("closes the popover on a click outside it, and stops listening once it is shut", () => {
    const mousedown = trackMousedown();
    try {
      show();
      // Nothing attached while the popover is shut. A listener installed
      // unconditionally is one the shell carries on every screen, for a panel
      // that is not open.
      expect(mousedown.live()).toBe(0);

      openPopover();
      expect(popoverIsOpen()).toBe(true);
      expect(mousedown.live()).toBe(1);

      fireEvent.mouseDown(document.body);
      expect(popoverIsOpen()).toBe(false);
      // And the cleanup ran. Without the `removeEventListener` the listener
      // survives, one more per open, and nothing on the screen would say so.
      expect(mousedown.live()).toBe(0);
    } finally {
      mousedown.restore();
    }
  });

  it("opens and closes the same language popover from the collapsed footer", () => {
    show();
    fireEvent.click(aside().querySelector<HTMLButtonElement>(
      `button[title="${DICTIONARY.en["nav.collapse"]!}"]`,
    )!);

    const trigger = aside().querySelector<HTMLButtonElement>(
      `button[title="${DICTIONARY.en["nav.lang"]!}"]`,
    );
    if (!trigger) throw new Error("the collapsed footer has no language control");
    fireEvent.click(trigger);
    expect(popoverIsOpen()).toBe(true);
    fireEvent.click(trigger);
    expect(popoverIsOpen()).toBe(false);
  });
});

describe("Sidebar sign-out", () => {
  /** How many sign-out controls the footer is drawing. A count rather than the
   *  node, because a failed `toBe(null)` against a DOM element serialises the
   *  whole subtree to build its diff: the run that proved this assertion can
   *  fail took thirteen seconds to say so, and reported a timeout instead of
   *  the button it had found. */
  const signOutControls = () => aside().querySelectorAll('[data-testid="logout"]').length;

  it("calls back exactly once, at either width", () => {
    // Both widths, because they are two different buttons in two different
    // branches and only the wide one had ever been pressed here. Cutting the
    // narrow one's handler left every test in this file green while the only
    // sign-out reachable from a collapsed menu did nothing at all.
    const onLogout = mock(() => {});
    show({ onLogout });
    fireEvent.click(screen.getByTestId("logout"));
    expect(onLogout).toHaveBeenCalledTimes(1);

    fireEvent.click(aside().querySelector<HTMLButtonElement>(
      `button[title="${DICTIONARY.en["nav.collapse"]!}"]`,
    )!);
    fireEvent.click(screen.getByTestId("logout"));
    expect(onLogout).toHaveBeenCalledTimes(2);
  });

  it("keeps the sign-out control out of the expanded footer when there is nothing behind it", () => {
    // A button that ends a session has to end one. Drawing it with nothing
    // behind it teaches a person they have signed out when they have not.
    //
    // **Scoped to the expanded footer, and the scope is a defect report.** The
    // collapsed branch draws its sign-out button with no `onLogout &&` around
    // it, so a caller that passed no handler gets exactly the control this
    // comment says must not exist. The assertion that used to be here claimed
    // the rule for the whole component and only ever rendered the wide branch —
    // it read as proof of something already false. Closing the gap is a change
    // to `Sidebar.tsx`, which is not this file's to make.
    show();
    expect(signOutControls()).toBe(0);
    cleanup();

    // The other direction: a footer that had dropped the control altogether
    // satisfies the line above, and cannot be told from one that guards it.
    // Exactly one, so a second copy left behind by a branch that stopped being
    // exclusive is a failure too — the click above would then be ambiguous.
    show({ onLogout: () => {} });
    expect(signOutControls()).toBe(1);
  });
});

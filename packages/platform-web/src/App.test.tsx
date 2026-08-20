/**
 * The route table, and the two lists that have to agree with it.
 *
 * `App` is eighty-odd lines of `<Route>` and nothing rendered it, so the only
 * thing standing between a renamed path and a dead link was somebody
 * remembering both files. A path the router does not know does not error: it
 * matches `*`, redirects to `/`, and the person lands on the dashboard
 * wondering what they clicked.
 *
 * Assertions are on `location.pathname` rather than on anything a screen says,
 * because where a person ends up is what these routes decide and it is the
 * same in every language.
 *
 * Nothing is mocked but `fetch`. `mock.module` is installed on the process at
 * file top level, before bun runs any test in the run, so a shimmed router
 * here would reach every other file — that is the 435-failure shape this
 * suite already met once.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every
// matching file's top level before any test, so a second `register()` swaps
// the document out from under the file still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, cleanup, act } = await import("@testing-library/react");
const { App } = await import("./App.tsx");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  // `AuthProvider` seeds from here; a session left behind signs in the next
  // test in this file and every file after it.
  localStorage.clear();
});

/** Nobody is signed in, which is what `/auth/me` answering 401 means. */
function signedOut() {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ error: "not signed in" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

/**
 * happy-dom starts at `about:blank`, where `pushState` cannot take a path —
 * `location.pathname` reads back "blank" and every assertion below measures
 * that instead of the router. Registration is process-wide and must not be
 * repeated, so the URL is set on the window that already exists.
 *
 * **`.invalid` rather than a machine's own name.** `greppable.test.ts` refuses
 * any local address in this tree's source, test files included, because source
 * here is what reaches a screen — and it caught this file naming one. The TLD
 * is reserved and can never resolve, which is the honest host for a router
 * that only ever reads the path.
 */
const ORIGIN = "https://platform.invalid";

function goTo(path: string) {
  const dom = (window as unknown as { happyDOM?: { setURL?: (u: string) => void } }).happyDOM;
  if (dom?.setURL) dom.setURL(`${ORIGIN}${path}`);
  else window.history.pushState({}, "", `${ORIGIN}${path}`);
}

async function land(at: string): Promise<string> {
  signedOut();
  goTo(at);
  await act(async () => {
    render(<App />);
    // One turn for `/auth/me` to settle, which is what the guard waits on.
    await Promise.resolve();
  });
  return window.location.pathname;
}

describe("where the route table sends a person", () => {
  it("sends a signed-out visitor to the login gateway", async () => {
    expect(await land("/dashboard")).toBe("/login");
  });

  it("does not guard the page the guard sends people to", async () => {
    // **The one route that must stay outside the guard.** It is where the
    // guard sends anyone holding a temporary password, so putting it behind
    // the same check redirects to itself for ever — a person who cannot sign
    // in and cannot reach the page that would let them.
    expect(await land("/change-password")).toBe("/change-password");
  });

  it("does not leave a person on a path it does not know", async () => {
    // `*` rather than nothing: an unrouted path would render blank, which
    // looks like a broken screen rather than a wrong link.
    expect(await land("/in-process-no-such-page")).toBe("/login");
  });
});

describe("the two lists of paths", () => {
  /**
   * The sidebar hard-codes `href`s and `App` hard-codes `path`s, and neither
   * reads the other. A link the router does not know is silent: it matches
   * `*`, redirects, and the person lands on the dashboard.
   */
  it("routes every path the sidebar offers", () => {
    const here = new URL(".", import.meta.url).pathname;
    const sidebar = readFileSync(join(here, "components/layout/Sidebar.tsx"), "utf8");
    const app = readFileSync(join(here, "App.tsx"), "utf8");

    const offered = [...sidebar.matchAll(/href:\s*"([^"]+)"/g)].map(m => m[1]!);
    const routed = new Set([...app.matchAll(/path="([^"]+)"/g)].map(m => m[1]!));
    expect(offered.length).toBeGreaterThan(0);

    const dead = offered.filter(href => !routed.has(href));
    expect({ dead }).toEqual({ dead: [] });
  });
});

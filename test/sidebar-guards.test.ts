/**
 * The menu asks for exactly what the route asks for.
 *
 * **They kept separate copies of the vocabulary and one of them drifted.**
 * `App.tsx` took `Capability` from `@agent-mesh/contracts` and the compiler
 * corrected its guards; `Sidebar.tsx` typed the same field as `string`, so it
 * went on naming `server.inspect`, `policy.send_restrict`, `audit.read_content`
 * and `role.assign` — four names the contract does not define, across six
 * entries, all compiling.
 *
 * The symptom was not an error. A capability nobody holds hides its item from
 * everybody, so six links vanished for every role at once and the menu looked
 * identical for a platform operator, a tenant admin and an ordinary user. It
 * was found by the owner looking at the screen.
 *
 * Typing the field catches an invented name. It cannot catch a **real name that
 * disagrees with the route** — `/tenant/rbac` asking for `usage.read` compiles
 * perfectly — and disagreement in either direction is a defect:
 *
 * ```
 * menu stricter than route    the link is hidden from someone allowed to open
 *                             the page, and the page is reachable by URL anyway
 * menu looser than route      the link is offered and the route bounces them,
 *                             which teaches people the app is broken
 * ```
 *
 * So the two tables are compared. Statically, from the source, because the
 * question is whether two files agree and that is decidable without a browser.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "packages", "platform-web", "src");


/**
 * The file with its comments blanked out.
 *
 * The `admin.all` assertion below failed on the sentence explaining why
 * `admin.all` must not come back — the second time tonight a check tripped on
 * prose describing it. A guard that cannot tell code from the comment about the
 * code has to be answered by deleting the explanation, which is the wrong
 * trade.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const appSource = readFileSync(join(WEB, "App.tsx"), "utf8");
const sidebarSource = readFileSync(join(WEB, "components", "layout", "Sidebar.tsx"), "utf8");

/**
 * Every `<Route path="…">` under the authenticated shell, with the capability
 * its `GuardedRoute` requires — or `null` where it requires only a session.
 *
 * Read by splitting on `path=`, so a route's own guard is whatever appears
 * before the next route begins. A `GuardedRoute` further away belongs to
 * something else.
 */
type Guard = { capability: string | null; role: string | null };

function routeGuards(): Map<string, Guard> {
  const out = new Map<string, Guard>();
  const chunks = appSource.split(/path=\s*"/).slice(1);
  for (const chunk of chunks) {
    const path = chunk.slice(0, chunk.indexOf('"'));
    if (!path.startsWith("/") || path === "/" || path === "*") continue;
    const body = chunk.slice(0, chunk.indexOf("/>") + 1 || undefined);
    const capability = /requiredCapability=\s*"([^"]+)"/.exec(body);
    const role = /requiredRole=\s*"([^"]+)"/.exec(body);
    out.set(path, {
      capability: capability ? capability[1]! : null,
      role: role ? role[1]! : null,
    });
  }
  return out;
}

/** Every sidebar item, as `href` and the capability it demands. */
function menuItems(): Map<string, Guard> {
  const out = new Map<string, Guard>();
  const chunks = sidebarSource.split(/href:\s*"/).slice(1);
  for (const chunk of chunks) {
    const href = chunk.slice(0, chunk.indexOf('"'));
    if (!href.startsWith("/")) continue;
    // The item ends at the next `label:` — anything after that belongs to the
    // following entry, and reading into it would attribute its capability here.
    const end = chunk.indexOf("label:");
    const body = end === -1 ? chunk : chunk.slice(0, end);
    const capability = /requiredCapability:\s*"([^"]+)"/.exec(body);
    const role = /requiredRole:\s*"([^"]+)"/.exec(body);
    out.set(href, {
      capability: capability ? capability[1]! : null,
      role: role ? role[1]! : null,
    });
  }
  return out;
}

describe("the sidebar and the router", () => {
  test("both tables were actually found", () => {
    // Every assertion below is a comparison of two maps, and two empty maps
    // agree perfectly. A renamed file or a changed prop spelling would make
    // this file pass while checking nothing.
    const routes = routeGuards();
    const items = menuItems();
    expect(routes.size, "no routes parsed out of App.tsx").toBeGreaterThan(8);
    expect(items.size, "no items parsed out of Sidebar.tsx").toBeGreaterThan(6);
    expect([...routes.keys()]).toContain("/tenant/rbac");
    expect([...items.keys()]).toContain("/tenant/rbac");
  });

  test("every menu item points at a route that exists", () => {
    const routes = routeGuards();
    const dangling = [...menuItems().keys()].filter((href) => !routes.has(href));
    expect(dangling, "a menu link goes nowhere").toEqual([]);
  });

  test("every menu item asks for exactly what its route asks for", () => {
    const routes = routeGuards();
    const disagreements = [...menuItems().entries()]
      .filter(([href]) => routes.has(href))
      .filter(([href, guard]) => {
        const route = routes.get(href)!;
        return route.capability !== guard.capability || route.role !== guard.role;
      })
      .map(([href, guard]) => {
        const route = routes.get(href)!;
        return `${href}: menu ${JSON.stringify(guard)} vs route ${JSON.stringify(route)}`;
      });

    expect(
      disagreements,
      "a menu stricter than its route hides a page its holder may open; looser offers a page that bounces them",
    ).toEqual([]);
  });

  test("no item revives `admin.all`", () => {
    // Not in the contract, and § 11 exists because "is an administrator" is
    // not a capability. It was the fallback in the visibility filter, and it
    // was the only reason those six screens ever appeared.
    expect(codeOnly(sidebarSource)).not.toContain("admin.all");
    expect(codeOnly(appSource)).not.toContain("admin.all");

    // And the masking has to actually leave code behind, or this passes on an
    // empty string.
    expect(codeOnly(sidebarSource), "comment masking ate the file").toContain("requiredCapability");
  });
});

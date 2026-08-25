/**
 * The shipped browser scripts, executed rather than read.
 *
 * `test/ui-fetch.test.ts` reads `packages/http/src/ui/` as text and asserts
 * that no state-changing `fetch` throws its answer away. That is a shape, and
 * its own header says so: it cannot tell that the check which follows is
 * correct, and a determined author satisfies it with a variable nobody reads.
 * This is the harness that header calls the honest next step.
 *
 * The page's own rendered text is executed — not a copy of the handlers — with
 * `fetch`, `alert`, `confirm` and the browser objects passed in as parameters,
 * which shadow the globals for the whole script. Nothing is registered on
 * `globalThis`: a document installed here would follow the process into every
 * server suite that runs after it, which is a defect this repository has
 * already had once.
 *
 * What it does not prove: that the button is wired to the handler, and that a
 * person sees the alert. The first is asserted from the markup below; the
 * second is a browser's job.
 */

import { describe, expect, test } from "bun:test";
import { renderAdminPage } from "./admin.ts";
import { renderAgentNotFoundPage, renderChatPage, renderPendingApprovalPage } from "./chat.ts";
import { renderLandingPage } from "./landing.ts";

/** The script block of a rendered page — the one that carries `needle`. */
function scriptCarrying(html: string, needle: string): string {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const block = blocks.find((b) => b.includes(needle));
  if (!block) throw new Error(`no script block contains ${needle}`);
  return block;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A `fetch` that answers by path and keeps every call made through it. */
function recordingFetch(answers: Record<string, { status: number; body?: unknown; text?: string }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    const answer = answers[new URL(url, "http://ui.test").pathname] ?? { status: 200, body: {} };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === undefined) throw new SyntaxError("not json");
        return answer.body;
      },
      text: async () => answer.text ?? JSON.stringify(answer.body ?? {}),
    };
  };
  return { calls, fetch, posts: () => calls.filter((c) => c.method !== "GET") };
}

/**
 * Just enough browser for a script whose elements are not on the page.
 *
 * Both pages register listeners and measure the viewport as they load. None of
 * that is what is being asserted, so it is answered rather than prevented — a
 * stub that threw would only prove the script reaches the line that threw.
 */
const windowStub = (): Record<string, unknown> => ({
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1280,
  innerHeight: 900,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  scrollTo: () => {},
});

/** An element that accepts whatever a rendering script does to it. */
const elementStub = (): any => ({
  innerHTML: "",
  innerText: "",
  textContent: "",
  value: "",
  style: {},
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {},
  removeEventListener() {},
  appendChild() {},
  removeAttribute() {},
  setAttribute() {},
  scrollIntoView() {},
  focus() {},
  remove() {},
  closest: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  scrollTop: 0,
  scrollHeight: 0,
});

/** Just enough document for a script whose page is not there. */
const documentStub = (): any => ({
  cookie: "mesh_token=a-token",
  getElementById: () => elementStub(),
  querySelector: () => elementStub(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => elementStub(),
  body: elementStub(),
  documentElement: { style: { setProperty() {} } },
});

/** An `EventSource` that connects to nothing and never fires. */
class SilentEventSource {
  close() {}
  addEventListener() {}
  set onmessage(_: unknown) {}
  set onerror(_: unknown) {}
}

describe("the admin page's approve and deny", () => {
  const script = scriptCarrying(renderAdminPage(), "async function approve(");

  /**
   * Runs the shipped script with the browser objects it uses passed in, and
   * hands back the two handlers.
   *
   * The script ends by calling `loadPending()` and `loadUsers()`, which is what
   * the page does on load; those are GETs and the assertions below look at what
   * was posted.
   */
  function load(answers: Record<string, { status: number; body?: unknown; text?: string }>, confirmed = true) {
    const alerts: string[] = [];
    const net = recordingFetch(answers);
    const made = new Function(
      "document", "fetch", "alert", "confirm", "window", "setInterval", "setTimeout",
      "EventSource", "history", "location", "console",
      `${script}\n;return { approve, deny };`,
    )(
      documentStub(), net.fetch, (m: string) => alerts.push(m), () => confirmed, windowStub(),
      () => 0, () => 0, SilentEventSource,
      { pushState: () => {}, replaceState: () => {} },
      { pathname: "/admin", href: "http://ui.test/admin", search: "" },
      { warn: () => {}, error: () => {}, log: () => {} },
    ) as { approve: (login: string) => Promise<void>; deny: (login: string) => Promise<void> };
    return { alerts, net, ...made };
  }

  test("a refusal reaches the operator, with what the server said", async () => {
    const { alerts, approve } = load({
      "/api/v1/admin/approve": { status: 403, body: { error: "user.admit required" } },
    });
    await approve("someone");
    expect(alerts).toHaveLength(1);
    // Both halves matter: the status says it was refused rather than lost, and
    // the detail says which capability the operator is missing.
    expect(alerts[0]).toContain("403");
    expect(alerts[0]).toContain("user.admit required");
    expect(alerts[0]).toContain("someone");
  });

  test("a refused approval does not re-read the list as though it had worked", async () => {
    // The defect this replaced: the refusal re-rendered the same pending list,
    // so a refusal and an approval of somebody who reappears looked identical.
    const { net, approve } = load({
      "/api/v1/admin/approve": { status: 403, body: { error: "no" } },
    });
    const before = net.calls.length;
    await approve("someone");
    const after = net.calls.slice(before);
    expect(after.map((c) => c.url)).toEqual(["/api/v1/admin/approve"]);
  });

  test("an accepted approval says nothing and refreshes both lists", async () => {
    const { alerts, net, approve } = load({ "/api/v1/admin/approve": { status: 200, body: { ok: true } } });
    const before = net.calls.length;
    await approve("someone");
    const after = net.calls.slice(before).map((c) => c.url);
    // Both lists: the queue the person is looking at, and the roster the
    // approved account now belongs to.
    expect({ alerts, pending: after.includes("/api/v1/admin/pending"), users: after.includes("/api/v1/agents") })
      .toEqual({ alerts: [], pending: true, users: true });
  });

  test("a refusal with no JSON in it still names the status", async () => {
    // A proxy's HTML error page is not a body this screen can parse, and
    // "something went wrong" with no number is the sentence that gets nobody
    // anywhere.
    const { alerts, approve } = load({
      "/api/v1/admin/approve": { status: 502, body: undefined, text: "<html>gateway</html>" },
    });
    await approve("someone");
    expect(alerts[0]).toContain("502");
  });

  test("declining the confirmation posts nothing at all", async () => {
    const { net, approve, deny } = load({}, false);
    const before = net.calls.length;
    await approve("someone");
    await deny("someone");
    expect(net.calls.slice(before)).toEqual([]);
  });

  test("a refused denial is reported too, and the denial is what it names", async () => {
    const { alerts, net, deny } = load({ "/api/v1/admin/deny": { status: 403, body: { error: "no" } } });
    const before = net.calls.length;
    await deny("someone");
    expect(net.calls.slice(before).map((c) => c.url)).toEqual(["/api/v1/admin/deny"]);
    expect(alerts[0]).toContain("someone");
  });

  test("the buttons the page draws call the handlers the page defines", async () => {
    // The handlers above are reached directly, so this is the other half: the
    // markup names them, and they are declared at the script's top level where
    // an inline `onclick` can find them.
    const html = renderAdminPage();
    expect(html).toContain(`onclick="approve(`);
    expect(html).toContain(`onclick="deny(`);
    expect(script).toContain("async function approve(login)");
    expect(script).toContain("async function deny(login)");
  });
});

describe("the chat page's push subscription", () => {
  const script = scriptCarrying(renderChatPage({ github_login: "someone", role: "user" }), "setupPushNotifications");

  /**
   * The script ends by calling `setupPushNotifications()` itself. It is
   * constructed with a `window` that has neither key it looks for, so that call
   * returns immediately; the keys are added afterwards and the function is
   * called deliberately, so what is asserted is one run and not two.
   */
  function load(subscribeStatus: number) {
    // No `Notification`/`PushManager` key: the script's own call on load then
    // returns at its first line, and the run asserted below is the one this
    // test makes.
    const win = windowStub();
    const net = recordingFetch({
      "/api/v1/push/vapid-key": { status: 200, body: { publicKey: "QUJDRA" } },
      "/api/v1/push/subscribe": { status: subscribeStatus, body: { ok: subscribeStatus < 300 } },
    });
    let unsubscribed = 0;
    const subscription = {
      toJSON: () => ({ endpoint: "https://push.example/x" }),
      unsubscribe: async () => {
        unsubscribed += 1;
        return true;
      },
    };
    const registration = {
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription,
      },
      addEventListener() {},
    };
    const navigatorStub = {
      serviceWorker: {
        ready: Promise.resolve(registration),
        register: async () => registration,
        addEventListener() {},
      },
    };
    const made = new Function(
      "document", "fetch", "window", "navigator", "Notification", "console",
      "history", "location", "setInterval", "setTimeout", "EventSource", "alert", "confirm",
      `${script}\n;return { setupPushNotifications };`,
    )(
      documentStub(), net.fetch, win, navigatorStub,
      { requestPermission: async () => "granted" },
      { warn: () => {}, error: () => {}, log: () => {} },
      { pushState: () => {}, replaceState: () => {} },
      { pathname: "/chat", href: "http://ui.test/chat", search: "" },
      () => 0, () => 0,
      SilentEventSource,
      () => {},
      () => true,
    ) as { setupPushNotifications: () => Promise<void> };
    win.Notification = true;
    win.PushManager = true;
    return { net, made, subscribed: () => unsubscribed };
  }

  test("a subscription the server would not store is undone rather than left half-made", async () => {
    // A browser subscription the server never stored is worse than none: none
    // retries on the next visit, this one goes quiet and looks subscribed.
    const { made, subscribed } = load(500);
    await expect(made.setupPushNotifications()).rejects.toThrow("500");
    expect(subscribed()).toBe(1);
  });

  test("a stored subscription is kept", async () => {
    const { made, subscribed, net } = load(201);
    await made.setupPushNotifications();
    expect(subscribed()).toBe(0);
    const sent = net.posts().find((c) => c.url === "/api/v1/push/subscribe");
    expect((sent?.body as any)?.subscription?.endpoint).toBe("https://push.example/x");
  });
});

/**
 * The whole of every page this server hands a browser, parsed.
 *
 * These scripts are written inside TypeScript template literals, which means
 * the compiler reads them as text and no tool in the build looks at them as
 * code. That is exactly how a TypeScript annotation —
 * `const X: Record<string, string> = {…}` — sat in the admin console's inline
 * script: a browser refuses the entire block on it, so the console rendered,
 * drew its shell, and then did nothing at all. Every button on that page is
 * wired through this one script.
 *
 * `new Function` is the same parse a browser does, so a script that survives
 * this line runs. It says nothing about what the script then does; the suites
 * above are for that.
 */
describe("every script this server ships", () => {
  /**
   * The expected block count is part of the assertion.
   *
   * "No block refused" is trivially true of a page carrying no blocks, so a
   * page that lost its script — or an extraction that stopped matching — would
   * pass this as loudly as a page that is fine. The landing page really has
   * none, and says so here rather than by being silent.
   */
  const pages: Array<[string, string, number]> = [
    ["the admin console", renderAdminPage(), 1],
    ["the chat page", renderChatPage({ github_login: "someone", role: "user" }), 1],
    ["the pending-approval page", renderPendingApprovalPage({ github_login: "someone", role: "user" }), 1],
    ["the agent-not-found page", renderAgentNotFoundPage(), 0],
    ["the landing page", renderLandingPage(undefined), 0],
  ];

  for (const [name, html, expected] of pages) {
    test(`${name} hands the browser a script it can parse`, () => {
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(blocks).toHaveLength(expected);
      const refused = blocks
        .map((block, i) => {
          try {
            new Function(block);
            return null;
          } catch (err) {
            return `block ${i + 1}: ${(err as Error).message}`;
          }
        })
        .filter(Boolean);
      expect(refused).toEqual([]);
    });
  }
});

/**
 * The sign-in page, which takes an error code out of a query string.
 *
 * The copy lives here and the route passes a code, so the value a browser sent
 * never reaches the markup. That is the property worth pinning: the difference
 * between a code and a message is the difference between two fixed sentences
 * and whatever a link in an email decided to put in the URL.
 */
describe("the sign-in page", () => {
  test("says which of the two things went wrong", () => {
    expect({
      invalid: renderLandingPage("invalid").includes("Invalid username or password"),
      missing: renderLandingPage("missing").includes("Username and password are required"),
      crossed: renderLandingPage("invalid").includes("Username and password are required"),
    }).toEqual({ invalid: true, missing: true, crossed: false });
  });

  test("says nothing when nothing went wrong", () => {
    const quiet = renderLandingPage(undefined);
    expect(quiet).not.toContain("Invalid username or password");
    expect(quiet).not.toContain("Username and password are required");
  });

  test("does not put the query string on the page", () => {
    // `?error=` is whatever a link says it is. A page that renders the value
    // renders markup somebody else wrote.
    const hostile = renderLandingPage('"><img src=x onerror=alert(1)>');
    expect(hostile).not.toContain("onerror=alert(1)");
    expect(hostile).not.toContain("<img src=x");
  });
});

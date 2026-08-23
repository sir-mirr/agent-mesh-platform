import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Give this process a document, and leave the network types alone.
 *
 * `GlobalRegistrator.register()` copies **every** property of a happy-dom
 * window onto `globalThis` — `document` and `window`, which these tests want,
 * and `Request`, `Response`, `Headers` and `fetch`, which they do not. Those
 * four are the browser's, and the browser enforces rules a server does not: a
 * `Request` built with a `cookie` header arrives without one, a `Response`
 * built with `Set-Cookie` answers without it, and header names come back in
 * the case they were written rather than lower-cased.
 *
 * The registration is process-wide and permanent, so whether the server suites
 * see bun's types or a browser's is decided by **which file bun loads first**.
 * That is not a decision anyone made: this package's tests ran after the http
 * ones here and before them in CI, where `packages/http` then failed 275 tests
 * — every session refused, every upload `411` — for weeks, while the same
 * commit passed on the machine it was written on.
 *
 * So the window goes in and the four network globals come straight back out.
 * A React test that needs a `Response` gets bun's, which is what the code under
 * test will meet in a browser anyway; nothing here renders a real request.
 */
export function registerDom(): void {
  if ((globalThis as { document?: unknown }).document) return;

  const server = {
    Request: globalThis.Request,
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    fetch: globalThis.fetch,
  };
  GlobalRegistrator.register();
  Object.assign(globalThis, server);
}

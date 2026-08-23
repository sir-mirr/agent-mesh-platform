/**
 * The address that goes into a command somebody runs somewhere else.
 *
 * `publicApiOrigin` is not for this app's own calls — those use a relative path
 * and let the browser resolve it. It is for the `curl` lines rendered onto the
 * pairing screens, which get copied into a terminal that is not this machine.
 * They were hardcoded to `http://localhost:3100`, wrong twice over: on a
 * deployment it names the reader's own laptop, and `3100` is the hub while the
 * redeem route is served by `agent-mesh-http`, so the line worked nowhere.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { registerDom } from "../register-dom";

// Registered once per process; see GuardedRoute.test.tsx for why this is a
// condition and not a call.
registerDom();

const { ENV, publicApiOrigin } = await import("./env.ts");

describe("publicApiOrigin", () => {
  it("reads the origin the page came from when the base URL is empty", () => {
    // The same-origin deployment is the decided one, and there the host that
    // proxies `/api` is the host that served the page.
    expect(ENV.API_BASE_URL).toBe("");
    expect(publicApiOrigin()).toBe(window.location.origin);
  });

  it("never ends in a slash", () => {
    // A trailing slash here produces `https://host//api/v1/...` in a command
    // somebody pastes into a terminal.
    expect(publicApiOrigin().endsWith("/")).toBe(false);
  });
});

/**
 * Environment configuration loader.
 * In development, Vite proxy handles /api and /auth so API_BASE_URL defaults to "" (same-origin).
 */
export const ENV = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL ?? "",
} as const;

/**
 * The address to put in a command the user will run somewhere else.
 *
 * **Not for the app's own calls** — those go through `apiClient`, which uses a
 * relative path and lets the browser resolve it. This is for the `curl` lines
 * rendered into `<CodeBlock>` on the pairing screens, which are copied into a
 * terminal that is not this machine and not this browser.
 *
 * They were hardcoded to `http://localhost:3100`, and that was wrong twice
 * over. On a deployment it names the reader's own laptop rather than the
 * server, and if a hub happens to be running there the command binds an agent
 * to the wrong mesh. And `3100` is the hub, while `/api/v1/pairing-codes/redeem`
 * is served by `agent-mesh-http` — so the line did not work anywhere, including
 * on the machine it was written on. `docs/running-locally.md` opens by naming
 * that exact confusion.
 *
 * `API_BASE_URL` is empty in the same-origin deployment, which is the decided
 * one, so this reads the origin the page came from — the host that proxies
 * `/api`. When the absolute-URL branch is used instead, that value is already
 * the answer.
 */
export function publicApiOrigin(): string {
  if (ENV.API_BASE_URL) return ENV.API_BASE_URL.replace(/\/$/, "");
  return typeof window === "undefined" ? "" : window.location.origin;
}

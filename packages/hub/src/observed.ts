/**
 * Where a request actually came from (SPEC § 8.11).
 *
 * The attestation this feeds is deliberately the narrow kind: **the hub's own
 * observation, never the peer's claim.** A holder of a stolen key can sign
 * anything it likes about its hostname or MAC; it cannot make packets arrive
 * from an address it does not control. That difference is the whole value, and
 * everything in this file exists to keep it from quietly becoming a claim
 * again.
 *
 * Which is exactly what happens behind a reverse proxy. The socket address
 * becomes the proxy's, the real one moves into `X-Forwarded-For`, and a header
 * is a string the client wrote. Two deployment properties keep it evidence:
 *
 *   1. **The hub is not reachable except through the proxy.** Otherwise an
 *      attacker connects directly and writes the header themselves. The hub
 *      cannot check this — nothing inside a process can tell whether something
 *      else can also reach it — so it is a claim the deployment makes and the
 *      capability document reports.
 *
 *   2. **The value is taken from the right.** `X-Forwarded-For` accumulates
 *      left to right, oldest first, so the leftmost entry is whatever the
 *      original client sent — forgeable, and the one every naive
 *      implementation picks because it is conventionally "the client".
 *
 * The second is the trap. It fails *open*: the check keeps running, the feature
 * still reports itself as enabled, and it compares a string the attacker chose.
 */

/**
 * How this deployment learns a peer's address.
 *
 * Reported in `GET /api/v1/capabilities` because a control that is configured
 * off looks identical to one that is on until somebody asks.
 */
export type ObservedSourceMode = "socket" | "forwarded";

export interface ObservedConfig {
  mode: ObservedSourceMode;
  /** Addresses whose `X-Forwarded-For` contributions are believed. */
  trustedProxies: ReadonlySet<string>;
}

/**
 * `AGENT_MESH_TRUSTED_PROXIES` — comma-separated addresses.
 *
 * Empty means `socket`: the header is **ignored entirely** rather than used as
 * a fallback. A fallback would mean an unconfigured deployment silently trusts
 * a header, which is the failure this whole file is about.
 */
export function readObservedConfig(env: Record<string, string | undefined>): ObservedConfig {
  const raw = (env.AGENT_MESH_TRUSTED_PROXIES ?? "").trim();
  if (!raw) return { mode: "socket", trustedProxies: new Set() };
  const trusted = new Set(
    raw.split(",").map((s) => normalizeAddress(s.trim())).filter((s): s is string => !!s),
  );
  return trusted.size === 0
    ? { mode: "socket", trustedProxies: new Set() }
    : { mode: "forwarded", trustedProxies: trusted };
}

/**
 * One address, in the form comparisons can use.
 *
 * `::ffff:127.0.0.1` and `127.0.0.1` are the same host and Bun hands back the
 * first from both transports. Stored one way and observed the other, every
 * comparison fails and every agent is refused — the difference between this
 * working and it being a denial-of-service against the whole mesh.
 *
 * A port is stripped for the same reason: it changes per connection, so
 * comparing it would fire on every reconnect.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // `[::1]:443` — bracketed IPv6 with a port.
  const bracketed = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) s = bracketed[1]!;
  // `1.2.3.4:443`, but never `::1` — a lone colon count of one means a port.
  else if ((s.match(/:/g) ?? []).length === 1 && s.includes(".")) s = s.split(":")[0]!;

  // IPv4-mapped IPv6, in both spellings.
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) s = mapped[1]!;

  return s.toLowerCase() || null;
}

/**
 * Resolve the peer's address from the socket address and the forwarding chain.
 *
 * `socketAddress` is what the kernel saw. `forwardedFor` is the raw header, or
 * null when there is none.
 *
 * **Walks from the right.** The header reads oldest-first, so the trustworthy
 * end is the one nearest this process: entries are dropped only while they were
 * contributed by a hop we trust, and the first address that was not is the
 * answer. An attacker prepending entries adds to the *left*, where this never
 * looks.
 *
 * Returns null when the mode is `forwarded` and no untrusted entry survives —
 * a chain consisting only of trusted proxies tells us nothing about a client,
 * and inventing one would be worse than saying so.
 */
export function observedSource(
  config: ObservedConfig,
  socketAddress: string | null | undefined,
  forwardedFor: string | null | undefined,
): string | null {
  const socket = normalizeAddress(socketAddress);
  if (config.mode === "socket") return socket;

  // The immediate peer has to be a trusted proxy, or the header is not ours to
  // believe: something reached us directly and may have written the whole
  // chain. Falling back to the socket address is correct here — it is still an
  // observation, just of a peer we did not expect.
  if (!socket || !config.trustedProxies.has(socket)) return socket;

  const chain = (forwardedFor ?? "")
    .split(",")
    .map((s) => normalizeAddress(s))
    .filter((s): s is string => !!s);

  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (!config.trustedProxies.has(hop)) return hop;
  }
  return null;
}

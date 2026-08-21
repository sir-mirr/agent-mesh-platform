/**
 * Taking a socket out of every map that believes in it.
 *
 * The close handler always did this inline. It became a function because § 8.1
 * requires the hub to close a connection whose key is no longer approved, and
 * evicting there by hand would be a second copy of the same five lines — which
 * is how a socket came to be left online in the first place. A presence map
 * that still names a closed socket is a mesh that reports somebody online and
 * routes to nothing.
 *
 * **Only what this socket owns.** A contender that lost the race for an
 * identity must not evict the winner when it goes: the registry is keyed by
 * identity, and the loser's departure is not the owner's.
 *
 * This file owns the `pres-` prefix.
 */
import { describe, expect, test } from "bun:test";

import {
  connectionOwnership,
  dropConnection,
  onlineAgents,
  proxyMap,
  wsIdentities,
  wsProxies,
} from "./presence";

let n = 0;
const uniq = (p: string) => `pres-${p}-${++n}-${process.pid}`;

/** A socket registered the way `mesh.connect` registers one. */
function connected(identity: string, proxiedFor: string[] = []) {
  const ws = {};
  const claim = connectionOwnership.claim(identity, ws);
  wsIdentities.set(ws, identity);
  if (claim.ok) onlineAgents.set(identity, ws);
  if (proxiedFor.length > 0) {
    wsProxies.set(ws, new Set(proxiedFor));
    for (const pid of proxiedFor) proxyMap.set(pid, ws);
  }
  return ws;
}

describe("dropping a connection", () => {
  test("takes the identity offline and forgets the socket", () => {
    const identity = uniq("agent");
    const ws = connected(identity);
    expect(onlineAgents.get(identity)).toBe(ws);

    dropConnection(ws, identity);

    expect(onlineAgents.has(identity)).toBe(false);
    expect(wsIdentities.has(ws)).toBe(false);
  });

  test("releases every identity it was proxying for", () => {
    const identity = uniq("proxy");
    const one = uniq("user");
    const two = uniq("user");
    const ws = connected(identity, [one, two]);
    expect(proxyMap.get(one)).toBe(ws);

    dropConnection(ws, identity);

    expect(proxyMap.has(one)).toBe(false);
    expect(proxyMap.has(two)).toBe(false);
    expect(wsProxies.has(ws)).toBe(false);
  });

  /**
   * **A proxy entry another socket has since taken is left alone.** Two
   * sockets can proxy for one user in sequence; the departing one must not
   * remove a mapping that now points at the connection still serving them.
   */
  test("does not remove a proxy entry another socket now owns", () => {
    const user = uniq("user");
    const leaving = connected(uniq("proxy"), [user]);
    const staying = connected(uniq("proxy"), [user]);
    expect(proxyMap.get(user)).toBe(staying);

    dropConnection(leaving, "irrelevant");

    expect(proxyMap.get(user)).toBe(staying);
  });

  /**
   * **The loser's departure is not the owner's.** § 8.1: a second connection
   * claiming an identity that is already held does not take it, and when that
   * contender goes it must leave the working connection online.
   */
  test("leaves the identity online when a contender goes", () => {
    const identity = uniq("agent");
    const owner = connected(identity);
    const contender = {};
    expect(connectionOwnership.claim(identity, contender).ok).toBe(false);
    wsIdentities.set(contender, identity);

    dropConnection(contender, identity);

    expect(onlineAgents.get(identity)).toBe(owner);
  });

  /** Called before `ws.close()`, so the close handler runs again on nothing. */
  test("is safe to run twice", () => {
    const identity = uniq("agent");
    const ws = connected(identity);
    dropConnection(ws, identity);
    expect(() => dropConnection(ws, identity)).not.toThrow();
    expect(onlineAgents.has(identity)).toBe(false);
  });

  test("is safe on a socket that was never registered", () => {
    expect(() => dropConnection({}, uniq("never"))).not.toThrow();
  });
});

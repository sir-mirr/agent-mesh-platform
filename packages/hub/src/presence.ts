/**
 * Who is connected right now.
 *
 * All of this is in-memory and deliberately so: it describes live sockets, and
 * a socket does not survive a restart. Nothing here is persisted, and the
 * registry in `agents` is the durable half.
 *
 * A single hub process owns these maps, which is also the reason the hub does
 * not scale horizontally today — see docs/open-questions.md.
 */

import { ConnectionOwnership } from "./connection-ownership";

/** identity → WebSocket */
export const onlineAgents = new Map<string, any>();

/** ws → identity, for cleanup when a socket closes without telling us who it was */
export const wsIdentities = new WeakMap<object, string>();

/** proxied identity → the proxying agent's WebSocket */
export const proxyMap = new Map<string, any>();

/** ws → the identities it proxies, so a close can withdraw all of them */
export const wsProxies = new WeakMap<object, Set<string>>();

/**
 * The first established socket owns an identity until its own close.
 *
 * A contender never evicts a live owner — a duplicate connection is the
 * contender's problem to resolve, not a reason to drop someone already
 * working (SPEC § 8.1).
 */
export const connectionOwnership = new ConnectionOwnership<object>();

/**
 * Remove a socket from every presence map it appears in.
 *
 * The close handler has always done this inline. It is a function now because a
 * second caller needs it: § 8.1 requires the hub to close a connection whose key
 * is no longer approved, and evicting there by hand would be a second copy of
 * the same five lines — which is how the socket came to be left online in the
 * first place.
 *
 * Safe to call before `ws.close()`: the close handler runs again and finds
 * nothing to do.
 */
export function dropConnection(ws: any, identity: string): void {
  const released = connectionOwnership.release(ws);
  if (released?.wasOwner && onlineAgents.get(identity) === ws) {
    onlineAgents.delete(identity);
  }
  const proxied = wsProxies.get(ws);
  if (proxied) {
    for (const pid of proxied) {
      if (proxyMap.get(pid) === ws) proxyMap.delete(pid);
    }
    wsProxies.delete(ws);
  }
  wsIdentities.delete(ws);
}

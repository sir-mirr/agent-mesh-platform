/**
 * Liveness for connected sockets (SPEC § 3.1).
 *
 * **A ping that is not answered is the only evidence of a half-open socket.**
 * The peer is gone, no FIN arrived, and `readyState` still says `OPEN` — the
 * close handler will never run, so nothing else in the hub will ever notice.
 * That connection keeps owning its identity, which means every message routed
 * to it is written as delivered into a socket nobody is holding.
 *
 * The first version of this pinged inside a `try` and dropped the connection in
 * the `catch`. Bun reports send status as a **return value**, not an exception:
 * `ws.ping()` returns `0` on a live socket and `0` on a dead one, and throws in
 * neither case. The catch was unreachable, so the heartbeat had never dropped
 * anything since it was written — and no test noticed, because the only thing a
 * test of that code could assert is that pinging does not throw.
 *
 * So liveness is tracked from the direction that actually carries evidence: the
 * peer's own frames. A socket that has been pinged and has sent nothing back by
 * the next sweep is unreachable.
 *
 * This is a class over injected state rather than a closure over the hub's
 * module scope so that a sweep can be run to completion in a test without a
 * server, a timer or a socket — the property that the original lacked.
 */

/** The part of a socket this needs. Anything else is the caller's business. */
export interface HeartbeatSocket {
  ping(): unknown;
  close(code?: number, reason?: string): void;
}

export interface HeartbeatDeps<Socket extends HeartbeatSocket> {
  /** identity → socket. Read live; the sweep does not snapshot it. */
  online: Map<string, Socket>;
  /** Record that the identity was reachable up to now (SPEC § 3.1). */
  touchLastSeen(identity: string): void;
  /**
   * Remove the socket from every presence map.
   *
   * Injected rather than reimplemented: a socket dropped here may also be
   * proxying for others, and withdrawing the identity while leaving the proxy
   * routes wired would keep sending someone else's mail into a dead socket.
   */
  drop(socket: Socket, identity: string): void;
  log(message: string): void;
}

/** Result of one sweep, so a caller — or a test — can assert on it. */
export interface SweepResult {
  pinged: string[];
  dropped: string[];
}

export class Heartbeat<Socket extends HeartbeatSocket> {
  /**
   * Sockets pinged in the previous sweep that have not been heard from since.
   *
   * Weak on purpose: a socket dropped anywhere else in the hub must not be kept
   * alive by this bookkeeping. A `Set` would be a leak with a 30-second refresh
   * rate on a long-lived process.
   */
  private readonly awaiting = new WeakSet<Socket>();

  constructor(private readonly deps: HeartbeatDeps<Socket>) {}

  /**
   * The peer sent something — a pong, a request, anything.
   *
   * Any inbound frame is proof of life, not only a pong. Counting only pongs
   * would make a busy socket whose pong was reordered behind a large request
   * look dead, and killing a connection that is actively working is a worse
   * failure than holding a dead one for one more interval.
   */
  alive(socket: Socket): void {
    this.awaiting.delete(socket);
  }

  /** Forget a socket that closed normally, so a reused object starts clean. */
  forget(socket: Socket): void {
    this.awaiting.delete(socket);
  }

  /**
   * One pass. Ping whoever is quiet, drop whoever stayed quiet through a ping.
   *
   * A socket that connects between sweeps is not in `awaiting`, so its first
   * sweep pings it and only the second can judge it: every connection gets a
   * full interval of grace before it can be declared unreachable.
   */
  sweep(): SweepResult {
    const pinged: string[] = [];
    const dropped: string[] = [];

    // Snapshot the entries: `drop` mutates `online`, and deleting the key the
    // iterator is standing on is only safe by accident.
    for (const [identity, socket] of [...this.deps.online]) {
      if (this.awaiting.has(socket)) {
        // `last_seen` first (SPEC § 3.1): once the socket is gone the registry
        // is the only record that this identity was ever reachable, and the
        // time it stopped answering is the useful value.
        this.deps.touchLastSeen(identity);
        this.deps.drop(socket, identity);
        this.awaiting.delete(socket);
        // Closed after dropping, not before. `close` may synchronously invoke
        // the close handler, which drops it too — harmless in that order, and a
        // double-drop in the other.
        try {
          socket.close(1001, "heartbeat timeout");
        } catch {
          // Already gone. The presence maps are what mattered and they are clean.
        }
        this.deps.log(`heartbeat: ${identity} did not answer a ping, dropped`);
        dropped.push(identity);
        continue;
      }

      // The return value is deliberately ignored. Bun reports `0` for a live
      // socket as well as a dead one, so branching on it would drop healthy
      // connections — see the note at the top of this file.
      try {
        socket.ping();
      } catch {
        // Not expected from Bun, but a throw here is unambiguous: nothing is
        // going out on this socket. Leave it in `awaiting` and the next sweep
        // removes it through the one path that also cleans up proxies.
      }
      this.awaiting.add(socket);
      pinged.push(identity);
    }

    return { pinged, dropped };
  }
}

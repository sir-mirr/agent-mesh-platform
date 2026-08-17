/**
 * Refusing a dormant send from a place the key has not been (SPEC § 8.11.2).
 *
 * **What this catches, stated narrowly:** a key that went quiet and came back
 * from a different network. Not a thief on the same network, not one who kept
 * the key busy, and nothing at all about what the sender claims — the address
 * is the hub's own observation (§ 8.11), which is the only reason it is worth
 * checking.
 *
 * Dormancy is the trigger because it is when exfiltration goes unnoticed. An
 * identity sending every few minutes has an owner who would see a second
 * sender; one silent since last night does not.
 *
 * Three conditions, and every one of them has to hold:
 *
 *   1. the sender is signing for itself — `sent_by == from`. A proxied send
 *      observes the *proxy's* address, which is constant for every web send
 *      and therefore says nothing about the sender;
 *   2. it has been silent past the window;
 *   3. this place is one it has not been seen at.
 *
 * Receiving is never gated. A lane that cannot receive cannot be told why it
 * is blocked, and would go silent with no way to learn the reason.
 */

import { sources } from "@agent-mesh/store";
import type { Database } from "bun:sqlite";

import { prefixOf } from "./observed";

/**
 * `AGENT_MESH_DORMANCY_SECONDS`. Overridable for the reason
 * `AGENT_MESH_HEARTBEAT_MS` is: a test of this behaviour has to wait out the
 * window, and a test that waits three hours is one nobody runs.
 *
 * `0` disables the refusal. Observation is recorded either way, so a
 * deployment that turns this off still has the history.
 */
export const DORMANCY_SECONDS = parseInt(process.env.AGENT_MESH_DORMANCY_SECONDS ?? "10800", 10);

export interface DormancyCheck {
  /** Null when the send may proceed. */
  refusal: { code: number; message: string; data: Record<string, unknown> } | null;
}

export function checkDormantSource(
  db: Database,
  from: string,
  sentBy: string,
  observed: string | null,
): DormancyCheck {
  if (DORMANCY_SECONDS <= 0) return { refusal: null };
  // A proxy's address is the proxy's. `sent_by: http-server` is identical for
  // every web send, so comparing it would refuse on the proxy's history and
  // never on the sender's.
  if (sentBy !== from) return { refusal: null };
  if (!observed) return { refusal: null };

  const last = sources.lastSendAt(db, from);
  if (!last) return { refusal: null };
  const idleSeconds = (Date.now() - Date.parse(`${last.replace(" ", "T")}Z`)) / 1000;
  if (!Number.isFinite(idleSeconds) || idleSeconds < DORMANCY_SECONDS) return { refusal: null };

  if (sources.seenBefore(db, from, observed, prefixOf)) return { refusal: null };

  return {
    refusal: {
      code: -32017,
      message:
        `this identity has not sent for ${Math.floor(idleSeconds)}s and this request came from ` +
        `a network it has not been seen on; an operator must review it`,
      data: {
        code: "SOURCE_CHANGED",
        dormancy_seconds: DORMANCY_SECONDS,
        // The prefix, not the address. An operator comparing needs the unit the
        // decision was made in, and the full address is in `agent_sources`.
        observed_prefix: prefixOf(observed),
      },
    },
  };
}

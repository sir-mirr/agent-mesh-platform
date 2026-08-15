/**
 * Where attachment bytes live (SPEC § 15.2).
 *
 * `uploads/` under the state directory, keyed by `<sha256>[.<ext>]`. The hub
 * only ever reads: it reports what is present when issuing upload grants
 * (§ 8.9.2) and verifies existence before committing an event (§ 8.9.3). The
 * http server does the writing, because that is where the PUT route is.
 *
 * Content-addressed, so a name collision is a content match and overwriting is
 * a no-op rather than a hazard.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "@agent-mesh/store";

export const UPLOAD_DIR = join(stateDir(), "uploads");

export function blobPath(blobKey: string): string {
  return join(UPLOAD_DIR, blobKey);
}

/** Size of a stored blob, or null when it is absent. */
export function blobStat(blobKey: string): { size: number } | null {
  try {
    const s = statSync(blobPath(blobKey));
    return s.isFile() ? { size: s.size } : null;
  } catch {
    return null;
  }
}

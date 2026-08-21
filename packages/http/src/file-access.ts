/**
 * Which paths `GET /api/v1/files` will read, and why the answer is a policy
 * rather than a `startsWith`.
 *
 * Two rules, and each exists because the other missed something:
 *
 * - **A prefix is not a directory until it ends at a separator.**
 *   `startsWith` alone made `<STATE_DIR>-backup/secret` a match for
 *   `<STATE_DIR>`, so any approved session could read a sibling directory —
 *   measured on this route, which answered `200` for exactly that path.
 * - **A path written with `..` is refused, even when it lands somewhere
 *   allowed.** Resolution is the defence that matters and this is the one
 *   that says what was meant, which is worth keeping because the two fail
 *   differently: resolution is silent about intent.
 *
 * Split out of `main.ts` because the second rule was **inert there**. The
 * route resolved the path first and handed the resolved copy to the check, so
 * `resolved !== filePath` was never true and the `..` branch could not fire at
 * any input — a check that checks nothing, which this repository has a
 * decision note about (`docs/decisions/checks-that-check-nothing.md`). It was
 * found by trying to cover the line, which is the same way its cousin in
 * `test/versioning.test.ts` was found.
 */

import { resolve } from "node:path";

export function isPathAllowed(filePath: string, prefixes: readonly string[]): boolean {
  const resolved = resolve(filePath);

  // The caller's own spelling, not the resolved one: `<STATE_DIR>/a/../b` is
  // inside the allowed directory and still not a path anybody meant to write.
  if (resolved !== filePath && filePath.includes("..")) return false;

  return prefixes.some((prefix) => {
    const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return resolved === prefix || resolved.startsWith(dir);
  });
}

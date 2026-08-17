/**
 * Which tenant an identity belongs to (SPEC § 11.4).
 *
 * A column on `agents`, not a derivation from group membership. The derivation
 * was the alternative and needs a rule for an identity in no group and another
 * for one in several — and neither rule can be right, because somebody who put
 * an identity in two groups was not thereby saying which tenant its traffic
 * counts towards. **A derivation rule reads an intention nobody expressed.**
 */

import type { Database } from "bun:sqlite";

export const DEFAULT_TENANT = "default";

/**
 * An identity's tenant, or `default`.
 *
 * Unknown identities answer `default` rather than throwing. A send has already
 * been authorised by the time this is asked, so an identity missing here is a
 * race with teardown rather than a caller doing something wrong — and § 15.6's
 * rule applies: statistics must not be the thing that stops routing.
 */
export function tenantOf(db: Database, identity: string): string {
  const row = db
    .prepare(`SELECT tenant FROM agents WHERE identity = ?`)
    .get(identity) as { tenant: string | null } | undefined;
  return row?.tenant ?? DEFAULT_TENANT;
}

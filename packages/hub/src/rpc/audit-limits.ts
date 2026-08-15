/**
 * What this hub advertises (SPEC § 8.9.1).
 *
 * Its own module so it can be checked against the contract without opening the
 * database — the drift that made this necessary was invisible from inside the
 * hub, and a test that needs a state directory is a test nobody runs early.
 */

import { AUDIT_CAPABILITY_DEFAULTS, AUDIT_SCHEMA_VERSION } from "@agent-mesh/contracts";

/**
 * What this hub advertises (SPEC § 8.9.1).
 *
 * Taken from the contract rather than restated. An earlier version of this file
 * declared its own numbers and its own shape, which drifted immediately: it
 * omitted `version` — the field § 8.9.1 requires and a client must not guess —
 * and carried a larger per-event total and a longer timeout than the contract
 * describes. The client is fail-closed on an unrecognised version, so the
 * advertisement it received made audit refuse to start at all.
 *
 * A hub MAY advertise different numbers, and a deployment that wants to raises
 * them here deliberately. What it may not do is invent them by accident, which
 * is what happens when the source of truth is a second copy.
 */
export const AUDIT_LIMITS = AUDIT_CAPABILITY_DEFAULTS;


/**
 * The highest event `schema_version` this hub can validate.
 *
 * Distinct from `capabilities.audit.version`, which is the *protocol* version —
 * methods, params and the error contract. One can move without the other, and
 * collapsing them would make a new event field look like a new wire protocol.
 */
export const MAX_SCHEMA_VERSION = AUDIT_SCHEMA_VERSION;

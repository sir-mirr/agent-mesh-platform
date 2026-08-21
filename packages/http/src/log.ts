import { createLogger } from "@agent-mesh/log";

/**
 * One log line shape for this process -- see `@agent-mesh/log`.
 *
 * There were fifty-six bare `console.*` calls here, each opening with a
 * bracketed subsystem somebody had invented at the call site: `[http-server]`,
 * `[db]`, `[chat-audits/stream]`, `[audit-blobs]`, `[ai-usage/ingest]`, and
 * `agent-mesh-http:` with no brackets at all. None carried a level a filter
 * could use, none carried a clock, and the thing the line was *about* -- a
 * message id, an identity, a fingerprint -- was inside the sentence.
 *
 * The subsystem lives in the event name now (`push_failed`, `db_registry_import`,
 * `audit_gap_fetch`), which is a field, so a counter can key on it.
 */
export const log = createLogger("http");

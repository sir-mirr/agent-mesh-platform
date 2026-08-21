import { createLogger } from "@agent-mesh/log";

/**
 * One log line shape for the whole process -- see `@agent-mesh/log` for what
 * the shape is and why the counter is part of the same call.
 *
 * This was `log(...args)` writing `[hub] <ISO> <whatever>`: no level, so
 * `journalctl -p err` could not separate a refused send from a listening
 * banner, and no fields, so answering "what happened to message X" meant
 * grepping for a substring of a sentence that nobody had promised to keep.
 */
export const log = createLogger("hub");

/**
 * `node:crypto`'s stand-in for the browser build.
 *
 * The parameters are declared even though nothing reads them: this module is
 * aliased in at build time, so its callers are type-checked against the real
 * `node:crypto` and never against this — a stub that takes no arguments passes
 * a build and fails nothing until somebody imports it directly.
 */
export const createHash = (_algorithm?: string) => ({
  update: (_data?: unknown, _encoding?: string) => ({
    digest: (_encoding?: string) => "",
  }),
});

export default {
  createHash,
};

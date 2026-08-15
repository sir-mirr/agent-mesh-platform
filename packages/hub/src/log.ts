/** One log shape for the whole process, so lines interleave readably. */
export function log(...args: unknown[]): void {
  console.log(`[hub]`, new Date().toISOString(), ...args);
}

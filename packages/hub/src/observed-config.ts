/**
 * The deployment's answer to § 8.11, read once at startup.
 *
 * Its own module because both the capability route and the request path need
 * it, and importing `main.ts` from either would be a cycle.
 */

import { readObservedConfig } from "./observed";

export const OBSERVED = readObservedConfig(process.env);

#!/usr/bin/env bun
/**
 * The `Stop` hook: stdin in, a block decision out.
 *
 * The question it asks lives in `remaining-work.ts`, which is where it is
 * measured. This file stays the path `settings.json` registers — a hook entry
 * changed mid-session never reloads, so moving the registration would silence
 * the hook for every session already running.
 */

import { remainingWork } from "./remaining-work";

export { remainingWork } from "./remaining-work";

// Only when run as a hook. Importing this file must not consume stdin — the
// mailbox hook imports it, and reading stdin twice leaves the second reader
// with EOF and a `JSON Parse error` that names the wrong file.
if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text());
  if (!input.stop_hook_active) {
    const reason = await remainingWork();
    if (reason) {
      console.log(JSON.stringify({ decision: "block", reason, systemMessage: "work remains" }));
    }
  }
}

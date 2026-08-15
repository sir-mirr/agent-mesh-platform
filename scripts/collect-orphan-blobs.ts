#!/usr/bin/env bun
/**
 * Collect blobs no audit event ever referenced (SPEC § 15.6).
 *
 * Audit retention is indefinite, so references are never released and the only
 * collectable blob is one that was **never referenced at all** — bytes uploaded
 * whose `mesh.audit.append` never arrived. That is the whole job, and it is why
 * this is short: there is no reference counting to do, because nothing ever
 * drops to zero.
 *
 *   bun scripts/collect-orphan-blobs.ts [--dry-run] [--grace-hours N]
 *
 * **The grace period is the correctness condition**, not a tuning knob. § 8.9
 * uploads bytes before the event that references them, so a blob with no
 * reference is the *normal* state for as long as the client takes to append —
 * and the grace period is what separates that from an orphan. Set it too short
 * and this deletes an upload the client is about to commit, which surfaces as
 * `-32040` for bytes the client knows it sent.
 *
 * Out of process, as § 15.6 requires, and safe to run while the hub and http
 * are live: it reads `audit.db` read-only and only ever unlinks files that both
 * have no reference and are older than the grace period. Idempotent — a second
 * run finds nothing left to do.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { openStore, stateDir } from "@agent-mesh/store";

interface Args {
  dryRun: boolean;
  graceHours: number;
}

function parseArgs(argv: string[]): Args {
  // Twelve hours is comfortably longer than any upload-then-append sequence a
  // client should still be attempting: the upload timeout is 180 s and the
  // grant lives 900 s, so a client that has not appended within twelve hours
  // has given up or crashed.
  const args: Args = { dryRun: false, graceHours: 12 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--grace-hours": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error("--grace-hours must be a non-negative number");
        }
        args.graceHours = value;
        break;
      }
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const uploadDir = join(stateDir(), "uploads");
const cutoff = Date.now() - args.graceHours * 3_600_000;

// Read-only. This never writes to the audit store, so it cannot be the reason
// an append fails while it runs.
const audit = openStore("audit", { readonly: true });

let files: string[];
try {
  files = readdirSync(uploadDir);
} catch (err) {
  console.error(`[orphans] cannot read ${uploadDir}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const referenced = audit.prepare(`SELECT blob_key FROM audit_event_blobs WHERE blob_key = ?`);

let scanned = 0;
let kept = 0;
let tooYoung = 0;
let removed = 0;
let bytes = 0;

for (const name of files) {
  const path = join(uploadDir, name);

  let stat;
  try {
    stat = statSync(path);
  } catch {
    // Removed under us by a concurrent run or an operator. Not an error.
    continue;
  }
  if (!stat.isFile()) continue;
  scanned++;

  // A `.part` file is an upload that died mid-stream (§ 9.1 renames into place
  // only after the digest matches). It is never referenced and never will be,
  // so the grace period is the only thing keeping it — which is right, because
  // an upload in progress looks exactly like one that died.
  if (referenced.get(name)) {
    kept++;
    continue;
  }
  if (stat.mtimeMs >= cutoff) {
    // The normal state for a blob whose event has not arrived yet. Deleting
    // here would surface to the client as -32040 for bytes it knows it sent.
    tooYoung++;
    continue;
  }

  if (args.dryRun) {
    console.log(`would remove ${name} (${stat.size} bytes, mtime ${new Date(stat.mtimeMs).toISOString()})`);
  } else {
    try {
      unlinkSync(path);
    } catch (err) {
      // Concurrent removal, or a permission problem worth seeing. Neither
      // should stop the sweep.
      console.error(`[orphans] could not remove ${name}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }
  removed++;
  bytes += stat.size;
}

console.log(
  `[orphans] scanned ${scanned}, referenced ${kept}, within grace ${tooYoung}, ` +
    `${args.dryRun ? "would remove" : "removed"} ${removed} (${bytes} bytes)`,
);

# Folding the write-ahead logs — settled design

Status: **decided and implemented.** `checkpointForShutdown` in
`packages/store/src/open.ts`, called from `packages/hub/src/db.ts` and from each
read-write closer in `packages/http/src`. Guarded by four entries in
`scripts/mutation-check.ts` (`wal-checkpoint-inert`, `wal-checkpoint-unwired`,
`wal-http-access-log`, `wal-http-access-log-fold`).

Written down because the code now contains a deliberate omission — the hub
checkpoints its audit store and does **not** close it — and an omission with a
reason behind it is indistinguishable from a bug unless the reason is somewhere
a reader will find it.

---

## What was wrong

Both processes ended their shutdown with `db.close()`, and neither folded
anything. bun's close is a *safe* close: while any statement is still prepared
against the handle it marks the database closed to JavaScript and leaves the
file open, so nothing is checkpointed and the log outlives the process.

```
db.close()            wal 2,476,152 -> 2,476,152   main     4,096
db.close(true)        throws "database is locked"
finalise, close()     wal 2,476,152 ->         0   main   827,392
```

`packages/hub/src/db.ts` prepares thirty statements at module load and never
finalises them, so the first row is what the hub's shutdown had always done. The
standing deployment carried the fingerprint: `hub.db` at 4096 bytes — one page,
no checkpoint ever completed — beside 1.5 MB of log.

**It was not deterministic.** In one shutdown of the standing deployment,
captured live between the stop and the start, `agent-mesh.db` folded to zero
while `hub.db`, `agents.db` and `audit.db` did not.

The clearest artefact came from a fixture mesh that had been left running for
twenty-four hours on the pre-fix binary, read as it was stopped:

```
agent-mesh.db   main    73,728   wal         0   ← http's own store, folded
agents.db       main     4,096   wal 2,047,672
audit.db        main     4,096   wal 2,381,392
hub.db          main     4,096   wal 1,050,632
```

**Three main files at exactly one page each**, with 5.4 MB of the day's writes
sitting beside them in logs that no checkpoint had ever touched. Nothing was
lost — the next open recovers them — and nothing had ever complained. Whether a bare close folds
depends on whether a statement happens to be alive at exit, which is a question
about when the collector last ran. That is why the fix is not "close harder"
and why it applies to every read-write handle rather than the ones that looked
suspect.

## How it was found

agent-mesh-local-pm noticed that a restart folded two of four logs and produced
`lsof` output showing which process held which file. **Neither obvious story fit
that table** — "the last holder closes it cleanly" predicts the wrong two, and
"the leaked one stays behind" predicts the opposite of what happened to `audit`.
They said so, and stopped rather than inventing a mechanism.

That refusal is what made the answer findable: both stories were about
*shutdown*, and shutdown was not where the difference came from. The logs that
folded were the ones SQLite's own 1000-page threshold folded **during the run**.

## What it does now

`checkpointForShutdown(db, timeoutMs = 250)` sets a short busy timeout and runs
`PRAGMA wal_checkpoint(TRUNCATE)`. The log folds, the handle stays usable, and
the failure mode is that nothing happens:

```
reader pinning an older snapshot, busy_timeout 250ms   folded in 151ms
reader pinning an older snapshot, busy_timeout 0       busy:1, 2ms, no fold
```

The timeout is deliberately short. The default is five seconds **per store**,
and this runs on the way out — a shutdown that waits twenty seconds is worse
than a log that stays large for one more run, which is what happened for the
whole life of the project anyway.

## The deliberate omission

The hub opens four stores and closes three. `auditDb` is checkpointed and left
open, on purpose:

- **Closing it releases nothing.** Measured above: with statements alive, the
  close does not touch the file. The checkpoint is the whole benefit.
- **Closing it makes the handle unusable to JavaScript immediately**
  (`Database has closed`) while § 8.9 audit writes are still on the shutdown
  path.
- **The process is about to exit anyway**, and the log is already folded by the
  time it does.

So the line is not missing. It was measured, and it buys nothing.

## Where the property is checked, and why twice

`closeDatabases` takes the stores it acts on, defaulting to `hubStores()` —
the module's own. That is what lets the fold be asserted at all:

- `packages/hub/src/db-stores.test.ts` opens four stores in a directory of its
  own, fills them until each has a log, and calls the shutdown against those.
  Every log folds; `audit` folds and stays usable; the module's lazy
  `selfReminder` handle is not taken along with somebody else's. In-process, so
  a coverage run sees it.
- `packages/hub/src/close-databases.test.ts` calls it with no argument, against
  the singletons, in a **child process** — because a shutdown belongs at the end
  of a process and a test that calls one has to supply the process. What that
  file proves is the wiring: that the handles this module opens are the handles
  the shutdown acts on.

Neither one covers the other. The first would pass with `hubStores()` returning
the wrong four; the second cannot report a line as covered, because coverage is
measured in the process that runs the test and this one is not that process.

## What is *not* established, and the honest reason

Adding `auditDb.close()` was recorded in `docs/deferred.md` as turning `test/`
red — 24, 44 and 55 failures against 0 with it reverted, described as
controlled.

**That evidence was retracted.** Retried, the change gave 625 pass on one run
and 68 failures on the next, and then the *reverted* tree gave 58 under the same
conditions. Those runs measured the machine: another agent was running the full
suite on the same host, and the failures are this repository's FE browser
cascade — `Target page, context or browser has been closed`, dozens of them
behind one timeout — which has nothing to do with SQLite.

The original numbers were never controlled for a concurrent suite either. What
was controlled was the tree; the machine was not, and the uncontrolled variable
was another agent. Both sides now announce long runs before starting them.

One elimination survives the retraction, because it does not depend on the
numbers: `Database has closed` appears **zero** times in the failing output, so
whatever `test/` was doing, it was not use-after-close.

## Why this is decided rather than deferred

The question "does closing the audit store break the suite" is now a question
with no consequence attached. With the log folded, closing releases no file the
process is not about to release by exiting, and the § 8.9 record is safe either
way. Answering it would need both arms interleaved on a quiet machine, and
would change no line of code whichever way it came out.

See also [`checks-that-check-nothing.md`](checks-that-check-nothing.md): a
shutdown path whose central call is inert, under a function named
`closeDatabases`, is the same failure as a test that passes without checking —
and it survived this long for the same reason, that everybody read the name.

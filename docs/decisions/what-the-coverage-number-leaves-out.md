# What 99% leaves out — settled practice

Status: **decided and in force.** `bun scripts/gate.ts "<label>" -- bun
scripts/coverage.ts` prints the number; the lines below are the ones it does
not cover, on purpose. `test/held-uncovered.test.ts` holds the table.

---

## Why a list of *uncovered* lines is worth writing down

A percentage says how much ran. It says nothing about whether what did not run
is the part that matters, and the two ways of raising it are not equally
honest: exercising a path, or writing a test that loads the file and asserts
something the code cannot fail. The second reads identically in the report.

So the remaining lines are enumerated with the reason each is left, and the
reason is a claim somebody can disagree with. **A line in this table is not a
line to go and cover.** Covering one means either the reason stopped being
true — in which case the row is wrong and should be corrected — or the test
written for it asserts nothing, which is the defect
[checks-that-check-nothing.md](checks-that-check-nothing.md) is about.

The count is deliberately not stated here, for the reason that document gives.

## The categories, and what each rests on

**A process boundary.** `import.meta.main` blocks, `Bun.serve`, the signal
handlers. Every one of them runs in `test/`, in a process the runner spawns —
which is exactly why coverage cannot see them: bun instruments the process it
is in. These are covered by behaviour and uninstrumented, which is a different
sentence from uncovered.

**Three rows left this table by being opened rather than argued.** The audit
poller's interval and the two stream watermarks were here under *a timer that
fires later than any suite waits*, and that reason was true of the timer and
not of the decision inside it. `auditPollerStartingPoint` and
`auditPollerPass` are ordinary functions the interval calls, and
`noteStreamClients` takes the count rather than reading the set — so the
branches that decide something are reachable in this process, including the
two failure branches that need a store which will not answer and could not be
reached at any price while the timer owned when it asked.

That is the distinction worth holding on to when reading the rest of this
table: *the timer* is not a reason, *waiting for a timer* is. A row whose
reason is really the second one is a row somebody can retire.

**Two more went the same way, and one of them was hiding a defect.**
`hasActiveSSE` was here because its only caller returns first unless the
deployment holds VAPID keys; the map is a parameter now. The admin-notify send
was here because the identity and the socket are both read at module load;
both are parameters now. Opening the second turned up what it could not
report: `sendViaHub` does not reject, it resolves `null` when the socket is
down, so the `.catch()` never ran and an approval nobody was told about looked
exactly like one that was. A line that cannot fire is a line that was never
checked, and *held for a good reason* is not the same as *known to work*.

**Two of the hub-link rows were a timer wearing a process boundary's clothes.**
`hubWs.onclose` and the `catch` around the dial were left as *belonging to a
running pair of processes*, and the socket does — but neither line touches it.
Both set a flag and call `setTimeout(connectToHub, 5000)`, and the real cost was
the timer: a reconnect armed in a shared runner fires during whatever file is
executing five seconds later. Owning the timer is the fix, not avoiding it, so
the schedule is a parameter with `setTimeout` as its default. `provisionSelf`
refusing went with them, since it is one `await` inside the same callback and a
`fetch` stub was already standing in for the hub's REST side.

What that turned up is the same shape as the admin notify: losing the hub said
nothing at all. `sendViaHub` answers `null` while the link is down, every caller
reads that as *sent nothing*, and a hub that went away at 3am and came back at 6
left no trace of the three hours between. The close path logs and counts now,
and `hub_dial_failed` is kept distinct from it because only one of the two is
fixed by editing configuration.

**A last-resort handler.** `app.onError` answers what every route already
catches. Reaching it needs a defect, so a test for it plants one — and then
asserts that the handler this repository would rather never run, ran.

**A timer that fires later than any suite waits.** This category is now empty,
and how it emptied is the useful part. The three SSE keepalives were here — 20
and 30 seconds, a `setInterval` whose body is one `enqueue` inside a `try` —
and the reason given was the waiting. But the rule inside them was written
three times, which is three places for it to drift, and a keepalive that
stopped keeping alive shows up as a proxy closing a stream, minutes later, on
somebody else's screen. `startStreamKeepalive(write, everyMs, setTimer)` is
one copy, and a test that fires the timer by hand does not wait for anything.

**A deployment this machine is not.** `webpush` needs VAPID keys; the
admin-notify path needs an identity to notify. Both are read at module load, so
covering them means a second process with a second environment — which is
`test/` again, and the same uninstrumented sentence.

**A failure the harness exists to report.** `test/harness.ts`'s throws are what
a broken boot says on the way out. Driving them means starting a mesh designed
not to work, per case, at seconds each.

**A branch with no producer.** There were three in the console: an avatar image
nothing set, a breadcrumb for a route that redirects before it renders, and a
mailbox depth `GET /api/v1/agents` does not report. fe-codex ruled on all three
under D-745 (T-025) and the answer was not the same for each — the first two
were deleted, because nothing was going to set them; the third stays, with the
producer named in a comment beside it. That is the distinction this category
turns on: a branch waiting for a producer somebody has decided to build is
different from one waiting for nothing.

## The table

Each row names a file, a string that must still be in it, and why the lines
around that string are left. The string is the anchor: if it is gone, the
reason no longer describes anything and the row is stale.

| File | Anchor | Why it is left |
|---|---|---|
| `packages/http/src/main.ts` | `if (import.meta.main) {` | The boot block: `Bun.serve`, the port log, the signal handlers. Runs in `test/`, in another process. |
| `packages/http/src/main.ts` | `app.onError((err, c) => {` | Last-resort handler. Every route catches what it can fail on, so the only trigger is a defect. |
| `packages/http/src/main.ts` | `webpush.sendNotification(` | This deployment's wiring around a library that talks to a push service. |
| `packages/http/src/main.ts` | `webpush.setVapidDetails(` | Same, at module load, when keys are present. |
| `scripts/lint-preview.ts` | `if (import.meta.main) {` | The CLI block. Its checks are cases in `test/preview-lint.test.ts`; this is the printing. |
| `scripts/lint-preview.ts` | `Could not read CAPABILITY from @agent-mesh/contracts` | The refusal to fall back to a hand-written capability list, which needs the contracts package to be broken. |
| `test/harness.ts` | `never became healthy:` | What a service that never opened its port says on the way out. |
| `test/harness.ts` | `--- hub output ---` | Both processes' output, appended to a boot failure. |
| `test/harness.ts` | `boot did not answer (attempt` | The port-collision retry, which needs the collision. |
| `test/harness.ts` | `with a body that is not JSON` | A route answering HTML — the shape of a route moved out from under a caller. |
| `test/harness.ts` | `could not leave the password gate` | An admitted account that cannot change its temporary password. |
| `test/harness.ts` | `no mesh_token` | A sign-in that redirects without setting a cookie. |
| `packages/hub/src/provenance.ts` | `Bun.spawnSync(["git"` | The catch around a `git` that will not spawn, on a module read once at load. |
| `packages/platform-web/src/pages/creator/AgentsPage.tsx` | `item.inboxDepth === null ?` | The non-null half. `GET /api/v1/agents` reports no queue depth, so every row takes the `— 미보고` side; kept under D-745 for the admin-mailbox producer, which is named in the comment above it. |

## What this table cannot check

That it is complete. Deciding whether a file has uncovered lines takes a
coverage run — five minutes, and the browser suite, which is why the check
beside this document holds the anchors rather than the percentages. A row that
goes stale fails; a row that is never written is invisible, and the only guard
against that is running `scripts/coverage.ts` and reading what it prints.

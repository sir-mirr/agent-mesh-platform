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

**Two more of the same shape, and both were guarding something.** The hub's
provenance read and the preview linter's capability vocabulary were here as
*read once at module load*, which was true and was not a reason: each is one
function call away from being a parameter. The git runner is a parameter now,
so a tarball with no `.git`, a detached head and a `git` that will not spawn are
all reachable without breaking the checkout the suite runs in — and the answer
that mattered, `dirty`, had never been checked in either direction. The
linter's vocabulary source is a parameter for a sharper reason: the thing it
must never do is fall back to a hand-written list, and until now the branch that
refuses to fall back was itself unreached. The mutation that makes it fall back
is in the manifest.

**A last-resort handler, which turned out to be reachable by asking.** This
category held `app.onError`, on the reasoning that getting there needs a defect.
True of the route, not of the handler: it is a function, and it is exported now,
so a four-line Hono app whose route throws runs the real one. Both of its
decisions are about what leaves the process — the caller is told a 500 happened
and nothing else, the log is told the message and the route — and neither had
been checked. The route is the pathname on purpose, because a query string is
caller input and one of them is a session token in a link somebody pasted.

Opening it also removed a line. `err instanceof Error ? err.message : String(err)`
could not run: Hono re-throws anything that is not an `Error` instead of calling
the handler, so a thrown string leaves through the framework and the guard sat
there reading as though the case were handled. The behaviour is held by a test
rather than argued in a comment, so the guard comes back if Hono ever wraps.

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
not to work, per case, at seconds each — which is true of the two that are
left, and was not true of the four that have gone. Those four were *messages*:
the health-wait sentence, the boot failure carrying both children, the retry
notice, and the one an rpc route answering HTML gets. A message is a function of
its inputs, and the boot to retry is a parameter now, so the whole policy runs
in-process with nothing started.

**And the fourth of those was hiding a branch that could not run.**
`bootRetryable` decides whether a red run is a race worth another port or an
answer, and its silence rule — *a child that said nothing never reached the
point of having an opinion* — was unreachable from the path that calls it. The
string it is handed is the boot failure message, which always carries at least
`--- hub output ---`, so what remained after stripping the harness's timeout
sentence was the harness's own section headers: not nothing. It was tested
against `""` and `"   \n\n  "`, shapes it is never handed. The rule strips its
own headers now, and the tests feed it what the caller actually builds. This is
the argument for the whole exercise in one row: the reason on it was true, and
the line behind it was wrong.

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
| `test/harness.ts` | `could not leave the password gate` | An admitted account that cannot change its temporary password — a live route answering something other than 200, which needs the mesh. |
| `packages/platform-web/src/pages/creator/AgentsPage.tsx` | `item.inboxDepth === null ?` | The non-null half. `GET /api/v1/agents` reports no queue depth, so every row takes the `— 미보고` side; kept under D-745 for the admin-mailbox producer, which is named in the comment above it. |

## The functions this table cannot name

Lines and functions are two numbers, and only one of them can be pointed at.
Bun's lcov writes `FNF` and `FNH` per file — how many functions there are and
how many ran — and **no `FN` or `FNDA` records at all**, so an uncovered
function has no name, no line, and no way to be found except by reading the
file and asking which callback cannot run. A single-line arrow makes it worse:
`x.map(v => f(v))` is one covered line whether or not the array had anything in
it, so a function can be uncovered inside a file at 100% of lines.

Measured on 2026-08-22 at `0e4b9da`: **99.03% of functions, 99.88% of lines**,
denominator A. Fourteen functions were left, and what chasing them turned up is
the argument for having chased them — every one was a place a test could not
call, which is the same thing as a place nobody had looked: two signal handlers
that could have been wired to different shutdowns, a push subscription that
could have carried one key twice, a sweep timer aimed at nothing, an upload
abandoned without a sentence, a re-declare whose failure left an approved
account unable to send, and a broken link reported as a refusal.

**The method has a failure mode, and it fired.** Reasoning from *"main.ts has
nine uncovered functions and its service-worker template holds about ten
arrows"* gave a confident, wrong answer: moving that source into a file left
the nine untouched and raised the file's function count, because a template
literal's arrows were never being counted. Two numbers being close is not
evidence. What remains after that correction — four files with one uncovered
function each, and `test/harness.ts` with four — is not being guessed at again:
whoever picks it up should expect to read code rather than a report.

## What this table cannot check

That it is complete. Deciding whether a file has uncovered lines takes a
coverage run — five minutes, and the browser suite, which is why the check
beside this document holds the anchors rather than the percentages. A row that
goes stale fails; a row that is never written is invisible, and the only guard
against that is running `scripts/coverage.ts` and reading what it prints.

## The floor, and what it does not watch

D-749 closed this track on 99 with one condition: **a measurement below 99 on
either metric reopens it, without a new instruction.** For that to be a
condition rather than a habit, something has to measure. Nothing in CI ran
`scripts/coverage.ts` at all — so `bun scripts/coverage.ts --floor 99` now exits
non-zero below the number, naming the metric that fell, and a `main`-only job
runs it. It is its own job because coverage has to run `packages/` and `test/`
in one process, which duplicates both suites: on a pull request that is latency
against a number that cannot move until the merge.

What the floor watches is the *total*. It cannot see a file that stopped being
imported — an absent file is not `0%`, it is absent, and the totals go **up**
when the hard parts leave the report. `every-module.test.ts` is what holds that,
and the file count printed beside each percentage is what makes a drop visible
to somebody reading. Nor can it see this table going stale, which is the check
beside this document.

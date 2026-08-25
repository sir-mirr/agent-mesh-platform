# Checks that check nothing — settled practice

Status: **decided and in force.** Every checker added to this repository is
mutation-tested before it is trusted, and the guards named below are in
`test/`.

---

## The shape

A check reports green. It has always reported green. It is also not checking
the thing its name says, and nothing about the report distinguishes the two.

This happened repeatedly in one working session, across two repositories, and
each time the document describing the correct behaviour was already written
and already correct.

**The count is deliberately not stated.** A sentence that counts a list below
it is wrong the first time the list grows, and fixing the number only defers
that to the next time. `client-claude` corrected an ADR reading "four rules"
above seven of them, and wrote a fresh count into the next file they touched
in the same sitting (mail #225). Three sentences in this repository had the
same defect, one of them inside the tool written for this document.

| What looked like a check | Why it wasn't |
|---|---|
| A test holding a hardcoded list of implemented scenario verbs | A second copy of what the `switch` handled, free to agree with a version of the code that no longer existed |
| SPEC § 17.3 permitting a runner to skip a verb it cannot run | Three clauses were then confirmed by one implementation while both reports read green |
| `provision` and `http` each checking `ExpectHttp` their own way | `expect.body` was added to one of them; every `provision` assertion using it passed unread |
| `scripts/` and `.claude/hooks/` absent from `tsconfig.base.json` | `bun run typecheck` reported zero about the files it was given, which excluded the harness being edited |
| A coverage predicate treating a root-anchored path as universal | Would have passed for any repository, including an empty one |

The last three were found by `client-claude` and this repository within an hour
of each other, in the same two files, having been introduced independently.

## What distinguishes the two cases

Nothing in the output. Only **breaking the behaviour on purpose and watching
the check go red.**

Every finding above came from a mutation, never from reading the code and never
from the suite passing. Reading finds the bug you are looking for; a mutation
finds the check that was never going to look.

The corollary is the part worth stating: **a new test is not evidence until it
has failed once for the reason it exists.** Adding it and seeing green is the
same observation as adding nothing and seeing green.

## What is in force

- A checker is mutation-tested when written. Break what it covers; confirm it
  goes red, and that the failure names the right thing.

  ```bash
  bun run mutation-check
  ```

  `scripts/mutation-check.ts` holds every one, each entry naming the defect that
  reached this repository and the test that now stands between it and a release.
  Adding a guard means adding a line there — otherwise "this was mutation-tested"
  is a claim about work that happened once, which outlives the guard it
  describes.
- Prefer one call site to two that agree. Both duplication defects above were a
  second copy that learned something the first did not — `assertHttp` and the
  `switch` default exist to have no second copy.
- A guard that decides coverage carries a case proving it can still say no —
  **and that the configuration it reads has not gone vacuous.** A coverage check
  compares a set of files against a set of patterns, and it reports green if
  either side collapses: patterns that match everything, or a file walk that
  finds nothing. `test/typecheck-scope.test.ts` refuses a project anchored at
  the repository root and asserts the walk finds named files, because those are
  the two collapses.

  Both were found the same way and neither by the author. This repository saw
  the pattern side (a `.` prefix treated as universal); `client-claude` saw it as
  a full `**/*.ts` glob answering for any path; and the file side went uncaught
  in both until one of us mutated the walk to return nothing and watched every
  case pass.
- **A check that passes by luck is a check nobody can tell from a sound one.**
  `E2E-AUDIT-001` caught an ignored audit filter only while another event sorted
  first; on a mesh where it ran alone, its own read was the oldest row and the
  assertion held against a route that filtered nothing. Measured, not supposed —
  a probe on a solo mesh returned the read as row zero.

  `client-claude` hit the same thing for real, and worse: their equivalent
  mutation came back NOT CAUGHT for the reason their own comment had predicted
  one commit earlier. It was committed anyway, because it was green at the time.
  A check known to be fragile is indistinguishable from a sound one until the
  day it isn't.

  The fix is to ask a question whose answer does not depend on ordering — here,
  the same filter asked for something that cannot match.

- **Evidence names the check, not the container.** A mutation counted as caught
  because the scenario id appeared in the output is counted on a run that may
  never have reached the assertion — the id is in the test name whether the
  check fired or the mesh refused to start. Eleven entries here accepted that,
  and `client-claude` had one recorded as caught while its scenario had not run
  once (mail #229).

  Each entry now requires the assertion too, and the messages were collected by
  running the mutations rather than by predicting them. Verified by breaking
  mesh startup: the entry reports which evidence is missing instead of a pass.

  Step numbers stay out of it. They shift when a step is inserted, which
  happened one tag ago, and an expectation pinned to one fails for a reason
  unrelated to its guard.

- A rule that permits a gap is a rule that hides one. § 17.3 was rewritten to
  forbid the skip it used to allow, because "visibly skipped" turned out to
  mean "skipped, and reported faithfully, and acted on by nobody".

## The harness is a checker too

The mutation tool that found the five failed the same way once, in the middle of
using it.

It kept one backup slot. Applying two mutations before restoring overwrote the
backup with the already-mutated file, so the first "restore" returned to the
first mutation rather than to the original — leaving a guard deleted in
`test/typecheck-scope.test.ts`, which then reported four passes. **The tool for
detecting checks that check nothing produced one.**

Caught by reading `git status` rather than the test output, which is the habit
worth keeping: a mutation round ends with a clean tree or it did not end.

It now refuses to stack, and asserts its pattern matched before writing — a
`sed` edit that matches nothing otherwise reports the mutation as uncaught,
which is a false finding rather than a missed one.

Then the replacement had the shape twice more.

**Its reporting branch had never run.** Eighteen entries were added and `18/18
caught` was observed while the code that prints a failure was dead. Proving it
by hand was not enough — that proof lives in a transcript and outlives what it
describes — so `--self-check` makes it a command.

**And `--self-check` passed for the wrong reason.** It counted failures and
inverted the result: every entry must be reported as a failure, so all-failed
means the branch works. Drift the baseline by one character and both entries are
refused for a missing pattern; refusals count as failures; it prints `2/2
correctly reported as failures` while the branch under test never ran. It now
compares the *reason* each entry failed against the reason it declares.

`client-claude` reached the same defect from the other side in the same hour: a
nested run left a dirty tree, every item was refused, refusals counted as
failures, and an inverted check read that as success (mail #221). Two tools, two
routes, one shape — refusal treated as evidence.

Both were found by measuring, not by reading. The recursion stops here because a
level deeper was tried and bit, not because a stopping point was chosen.

## Three ways, not one

Everything above is one failure — a check that saw nothing and reported a pass.
`agent-mesh-local-pm` audited the front end with a harness that failed in two
*other* ways on the same day, and the distinction is worth keeping because the
fixes are different.

**① The check saw nothing and called it a pass.** Their block rule matched
`/api/` in the URL, which also matched the dev server's own
`/src/api/client.ts` — so the application bundle died, every screen went blank,
and fourteen blank screens were recorded as fourteen passes. Every case in this
document is this one.

**② The check saw a healthy thing and called it a defect.** With no data in the
backend, a screen looked identical whether the backend was reachable or not, and
that was reported as a failure. The tool this document is about did the same to
me an hour later: a mutation entry pointed at the neighbouring test, so a guard
that fired correctly was reported as not catching it — a wrong finding, about
the wrong thing, in the tool built to prevent exactly that.

**③ The check measured a condition that was not the one that matters.** Blocking
`/auth/*` along with the API bounced the app to a login screen, so the fallback
code being hunted never got a chance to run. Nothing was broken and nothing was
misread; the question asked was the wrong question. Cutting only `/api/v1/*` and
leaving the session alive failed six screens immediately, with fabricated tenant
names and constants sitting in `catch` branches.

**③ is the hardest of the three**, and not because it is subtle. ① and ② are
the checker being wrong, and a checker can be fixed by looking at it. ③ is the
checker doing exactly what it was told while what it was told is wrong — and no
amount of reading the checker reveals that, because from inside it everything
is consistent. What revealed it was changing the condition and watching the
answer change.

The common thread is the one this whole document is about: **the result did not
say what it had looked at.** `PASS` with no account of what was exercised
carries the same weight in all three cases, and in two of them it is a lie. That
harness now prints how many numbers were identical between the two runs, and
distinguishes `INCONCLUSIVE_NO_DATA` from a failure — which is the same fix as
naming the check rather than the scenario, and naming the denominator rather
than the count.

## The checker read less than it was shown

Three of the failures above are the checker asking the wrong question. This one
is the checker never hearing the answer.

`mutation-check.ts` decides whether a guard objected by looking in the test
run's output for a string the entry names. It read that output through
``$`bun test …`.quiet()``. Measured against one suite — a failed
`expect(node).toBe(null)` on a jsdom node, which serialises the node's whole
graph:

| how the run was read | came back | `(fail)` markers in it |
|---|---|---|
| ``$`bun test …`.quiet()`` | 787 KB | none |
| `stdout`/`stderr` as pipes | 787 KB | none |
| a file descriptor | 248 MB | all of them, and the title |

bun prints `(fail) suite > title` *after* the failure's own output, so on the
first two readings the string the entry names is produced by the child and then
dropped on the way in — while the summary at the very end survives. What
arrives is `exit 1`, a summary, and no expected string, which is exactly the
shape of a guard that stayed quiet. `the-bell-moves-inside-the-trail` was
recorded that way: caught when it was run on its own, missed in a batch of 112.

It is not a fixed limit. The same three readings agree at 3 MB and at 8 MB.
What is lost depends on what the run printed, which makes the verdict depend on
it too.

Two things follow, and both are in the tool now.

**Read through a file.** Nothing is dropped between the child and the tool, and
what is dropped afterwards is dropped deliberately, by a function that says how
much went and which of the strings the verdict turns on were in it.

**Say when the output stopped rather than deciding on it.** bun prints one
marker per failing test; fewer markers than the summary's count is a run that
did not finish talking. That is `inconclusive`, not a finding — the same
distinction as `INCONCLUSIVE_NO_DATA` above, arriving by a different route.

There is a third, smaller one worth writing down because the file it broke was
the file that tests this. bun echoes a failing test's source back with an
`NNN | ` prefix, and one fixture in `test/mutation-verdict.test.ts` is the
string `"error: a beforeEach hook timed out"`. The predicate scanned for that
phrase, found the suite's own fixture, and refused to give the suite a verdict
on its own guard — the same shape as reading the first `N pass` in a run rather
than the last, which the same function had already been fixed for once. **What
a run printed and what a run quoted are not the same text**, and a checker that
cannot tell them apart is reading its own reflection.

## What a full pass finds that a filtered one cannot

The manifest is usually run one entry at a time: plant a defect, watch the named
suite object, move on. Rehearsing all 924 entries in eight shards before a
nightly turned up four things, and **every one of them passed when its entry was
run alone**.

| what it looked like | what it was |
|---|---|
| an entry not caught | its mutation flooded a poller until a `beforeEach` timed out, so the verdict stopped at "a hook died" and no run of it could ever say anything else |
| an entry not caught | the check read two agent pickers as one set, so the picker the defect had not touched answered for the one it had |
| the same entry, again | `group` holds the agent's kind, so the filter emptied the sender list — and a rule keyed on *what a picker shows* cannot see a picker showing nothing |
| an entry not caught | a later change to the verdict made the entry's direction hold either way, retiring it silently |
| five entries not caught, together | the machine lost its network mid-run; every scenario failed on `net::ERR_INTERNET_DISCONNECTED` |

The last one is the expensive shape. Five findings against five guards that were
never asked is a day spent in the wrong files, and it is produced by a tool
whose job is to prevent exactly that. It reports `inconclusive` now — but only
when the expected message is absent, because a scenario asserting what an
offline console does prints that string while working perfectly.

The fourth is the one worth remembering when reading a green manifest: **a
change to the tool can retire an entry without touching it.** Nothing in the
entry moved, nothing in the code it mutates moved, and it stopped measuring
anything. Only a full pass noticed.

## Text nothing parses

The admin console shipped a browser script that no browser could parse, for
four months, and every check the repository has was green throughout.

```js
const SUMMARY_WINDOW_MOBILE_LABEL: Record<string, string> = { … }
```

A TypeScript annotation, in JavaScript, inside a TypeScript template literal.
The compiler reads that block as a *string*, so nothing in the build looked at
it as code; the route answered 200 with the bytes intact; the page rendered its
shell. A browser refuses the whole block on that line, and every control on the
page — approve, deny, the tabs, the audit tail, the usage panel — is wired
through it. The console drew and did nothing.

Three separate mechanisms each had a reason not to catch it:

| | |
|---|---|
| the type checker | the script is a string, and a string is well-typed |
| `ui-fetch.test.ts` | reads that string with a regex; a regex has no opinion on whether text parses |
| the coverage floor | `packages/http/src/ui/` is excluded from the denominator by the owner's decision |

The last is the one to sit with. The exclusion is a deliberate choice and this
does not overturn it — but the region *behind* it is where a four-month defect
matured, and that is the argument the choice has to answer. Exclusions are not
neutral: they decide where rot is allowed to be quiet.

The guard is three lines and belongs beside the render, not in a browser:
`new Function(block)` is the same parse a browser does, so a script that
survives it runs. `/sw.js` already had exactly this test, written for exactly
this reason — *no compiler sees it, so a stray bracket ships green* — and the
five rendered pages simply had not been given one. Where a check like that
exists for one file, ask what else is the same shape.

Parsing is the floor, not the ceiling. The same harness executes the script
with `fetch`, `alert` and `confirm` passed in as parameters, which shadow the
globals for the whole block, so what a refused approval does is a question with
an answer now: the operator is told the status and the server's reason, and the
list is not re-read as though the write had worked.

## What stays unnamed, and why that is not a backlog

A handful of source files carry no entry at all, and counting them as debt
would be the wrong reading — for most of them, an entry is not possible in the
form this harness takes, which is *a mutation that makes a named suite go red*.

(How many there are moves with the manifest, and stating it here would be a
second declaration of something already true elsewhere — the failure mode this
document is about. `comm` against the manifest's `file:` values answers it in
one line. What is worth keeping is the sorting below.)

| | |
|---|---|
| barrels, type-only files, `vite.config.ts` | the compiler is the checker. Deleting an export or widening a type fails `tsc`, and no suite goes red — `typecheck-scope.test.ts` reads the project's `include` globs on purpose rather than running a second compile, which would double the slowest check in CI |
| `standing-order.ts` | the test imports the constant it asserts, so a mutation moves both sides at once. That is not a weak test: the same file also asserts each hook *uses* the constant and holds no second copy of the sentence, which is the property worth having |
| `test-state-dir.ts` | the mutation's blast radius is somebody's real mesh. It exists so a suite cannot write to the default state directory, and the mutation that proves it works is the one that lets a suite do exactly that. Left unplanted deliberately |
| browser entry points (`main.tsx`) | no process under test reaches those lines, and the answer where such glue was worth measuring was to split the question out of the entry point — see [what the coverage number leaves out](what-the-coverage-number-leaves-out.md) — not to plant against a line that never runs |

**A hook's `import.meta.main` block was in that row, and did not belong there.**
The reasoning was borrowed from `main.tsx` and does not transfer: a hook *is* a
process, so a test can spawn it and hand it stdin, and coverage failing to see
the lines is a fact about the instrumented process rather than about whether
anything runs them. `more-work.ts` sat unnamed on that borrowed reason while
`settings.json` registered it and `mailbox.ts` imported it, and the twelve
lines it holds decide whether a continuation is blocked again, whether an empty
answer is still spoken, and what shape the block takes. All three fail quietly,
and a hook that says nothing is indistinguishable from a repository with
nothing left to do. It is spawned and named now, and the same question is worth
putting to any entry point that is a process rather than a page.

**The last one left was sorted by what it looks like.** `ui/theme.ts` was held
here as *a table of constants whose only honest assertion would be a second
copy of the table*, and that describes its shape rather than its contents. It
holds a decision — `NODE_ENV === 'development'` — a badge that must render in
exactly one of two environments, and the build stamp the service worker caches
under. The values between those are what makes it read as a table.

The check that is not a copy asks for **properties**: that the two environments
disagree about which they are, that the badge appears in dev and nowhere else,
and that no palette entry is shared between them. A colour copy-pasted until
dev matches production fails that without any hex being written down twice. Two
of the five entries it now carries land on a check that already existed and had
nothing pointing at it, which is its own small lesson: *unnamed* sometimes
means the anchor is missing, not the test.

So the rule that survives both corrections is to sort a file by what it
decides, not by what it looks like. Every file still on this list decides
nothing — the compiler, the importing test, or a deliberate refusal to plant is
what stands behind each.

The distinction worth keeping: *unnamed because nothing can go red* is a fact
about the harness, and *unnamed because nobody looked* is debt. Both this
section's list and the two defects above came out of asking which one a given
file was.

## What this does not say

It does not say tests are unreliable, or that coverage is worthless. The
scenarios in `@agent-mesh/contracts` caught real mesh defects throughout the
same session and are the reason the mesh side of the ledger is short.

It says the checker is code like any other, and the only code in the repository
that nothing else checks. That is the whole of the argument.

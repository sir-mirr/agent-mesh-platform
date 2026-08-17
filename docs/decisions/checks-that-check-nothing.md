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

## What this does not say

It does not say tests are unreliable, or that coverage is worthless. The
scenarios in `@agent-mesh/contracts` caught real mesh defects throughout the
same session and are the reason the mesh side of the ledger is short.

It says the checker is code like any other, and the only code in the repository
that nothing else checks. That is the whole of the argument.

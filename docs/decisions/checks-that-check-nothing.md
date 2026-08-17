# Checks that check nothing — settled practice

Status: **decided and in force.** Every checker added to this repository is
mutation-tested before it is trusted, and the guards named below are in
`test/`.

---

## The shape

A check reports green. It has always reported green. It is also not checking
the thing its name says, and nothing about the report distinguishes the two.

This happened five times in one working session, across two repositories, and
each time the document describing the correct behaviour was already written and
already correct.

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
- A rule that permits a gap is a rule that hides one. § 17.3 was rewritten to
  forbid the skip it used to allow, because "visibly skipped" turned out to
  mean "skipped, and reported faithfully, and acted on by nobody".

## What this does not say

It does not say tests are unreliable, or that coverage is worthless. The
scenarios in `@agent-mesh/contracts` caught real mesh defects throughout the
same session and are the reason the mesh side of the ledger is short.

It says the checker is code like any other, and the only code in the repository
that nothing else checks. That is the whole of the argument.

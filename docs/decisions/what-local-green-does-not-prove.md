# What a green local run does not prove — settled

Status: **fixed and recorded.** The defect is repaired
(`packages/platform-web/src/register-dom.ts`, and `wal-growth.test.ts`'s
measurement); this document is the account of how three green commands sat next
to fifteen consecutive red CI runs, and what that gap is made of.

Written down because the conclusion is a *habit*, not a patch: this repository
had a standing line saying platform CI was not worth watching, and that line was
true only while CI checked nothing anybody relied on.

---

## The state it describes

`bun run typecheck`, `bun test packages/` and `bun test test/` were green on this
machine, on every one of those pushes. On the runner, `check` failed with 276
unit failures and a test count that did not match: **1928 tests on CI against
2074 here**. A count that differs is a different suite, and a different suite is
not a flake.

## What it was

`GlobalRegistrator.register()` from happy-dom replaces the fetch family
**process-wide** — `Request`, `Response`, `Headers`, `fetch`, `Blob`, `File`,
`FormData`, `AbortSignal` and the stream types. The replacements are
browser-strict: they drop forbidden headers (`cookie`, `set-cookie`,
`content-length`), and their `Blob`/`File`/`FormData`/`AbortSignal` are rejected
by the native `Request` a server route is holding.

Thirty-nine files under `packages/platform-web/src` registered it, each guarded
by `if (!document)`. Whether a *server* suite saw the replacement therefore
depended on whether one of those files had run first in the same process — and
**bun does not honour test-file argument order**; it uses its own discovery
order, which differs by platform. On the runner, `main.in-process.test.ts` died
in `beforeAll` and took 147 tests with it. Here, it ran first and never met the
registration.

The repair is `registerDom()`: snapshot the server globals, register, put them
back. One place, called by all thirty-nine.

The second failure underneath it was `wal-growth.test.ts` asserting that the
write-ahead log **shrank**. An automatic checkpoint rewinds the log and writes
over it; the file shortens only with `TRUNCATE` or a `journal_size_limit`. It
shrank on this filesystem and did not on the runner's — see
`folding-the-write-ahead-logs.md`.

## Three wrong causes, said out loud first

Each was stated to `agent-mesh-local-pm` before it was checked, and each had to
be retracted:

| Claim | What killed it |
|---|---|
| A bun defect on Linux generally | PM's own repro: macOS arm64, docker linux/arm64 and docker linux/amd64 on the runner's exact revision — 6/6 shapes kept the cookie |
| The lab VM's login is broken | Same repro, and the VM was never the subject |
| That runner's binary — `bun-linux-x64-baseline` vs modern | Plausible, and moot: the suite dying was load order, not header handling |

The third one is worth keeping rather than deleting. It is a real hazard — the
baseline, modern and musl builds all print the same `1.3.13+bf2e2cecf` — and the
next platform-only failure should still check it. It was simply not this one.

**The pattern in all three: a mechanism proposed to explain a difference before
the difference had been narrowed.** PM narrowed it by running the thing rather
than reasoning about it, twice, and both times the answer disagreed with mine.

## What local green cannot see, and what to do about each

| Difference | What it costs | What closes it |
|---|---|---|
| File discovery order | Cross-file global leakage becomes platform-dependent | Do not leak: `registerDom()` restores what it replaced |
| Filesystem behaviour | An assertion about *file size* passes on one and not the other | Assert the property (bounded growth), not an artefact of it |
| Empty state directory | A fresh boot's seeding path is exercised only there | The `test/` harness makes its own state; a fixture that assumes a populated one is a defect |
| Same version string, different binary | baseline/modern/musl print identically | Print `process.execPath` and check the asset name before blaming a runtime |

## A path nothing had ever taken

The night the sharded mutation pass first ran, every shard came back red and
**nothing was filed**. The step that files a report on a red shard had existed
for weeks, was described in `CLAUDE.md` as the thing each session should read,
and had never executed once: nothing had gone red on that path before.

It failed twice, for two independent reasons, and both look identical from
outside:

    could not add label: 'nightly-mutation' not found     ← a label nobody had created
    default_workflow_permissions=read                     ← a token that cannot open an issue

Fixing the first did not fix the second. That was found only by dispatching a
run *while the tree was still red* and watching the step fail again — the
demonstration `agent-mesh-local-pm` asked for, in the one window where a real
failure was still available to demonstrate with.

**A check that has never failed has never run.** Its success path is exercised
by every green build; its failure path is prose until something makes it fire.
The same is true of a `catch` block, a retry, an alert, and a rollback.

## The first full pass measures what has accumulated, not what changed

That same night, 17 of 777 manifest entries came back *not caught* — spread
across subjects, one to four per shard, which is why all eight shards were red
at once. None of it was a regression from that day. The anchors check had been
green throughout, because an anchor asks whether the text an entry plants into
still exists, not whether the guard still notices.

Six of the seven cheapest reproduced locally on the first try. So the shape was
not *CI versus local* at all: it was **a measurement taken for the first time**,
and the backlog it found was the ordinary drift of guards and their subjects
moving apart. Three kinds, in the order they were common:

| Kind | Example |
|---|---|
| The expectation quoted prose that moved | `"has 2 ids"` — the family has seven now; `"untranslated strings, up from"` — gained *or lines* |
| The guard read something adjacent to its subject | the testid sweep read `*.test.tsx` as the product; the gate check took the first `app.use('*')`, which stopped being the gate |
| The scenario outlived the behaviour | the console stopped printing the capability, so the scenario that watched the screen could no longer see the field being dropped |

The second kind is the one worth fearing: those guards were green, specific,
and measuring the wrong thing. A count inside an expectation is the cheapest
version of the first kind and the easiest to avoid — quote the stable half of a
sentence.

## Why CI is watched now

`coverage-floor` runs `bun scripts/coverage.ts --floor 99` on `main`. From the
commit that added it, CI holds a number nothing local holds, and a red run there
is a fact about the repository rather than about the runner. `agent-mesh-local-pm`
put it as D-752: **when local and CI disagree, the disagreement is the finding**,
and green says nothing about it.

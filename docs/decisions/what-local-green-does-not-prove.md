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

## Why CI is watched now

`coverage-floor` runs `bun scripts/coverage.ts --floor 99` on `main`. From the
commit that added it, CI holds a number nothing local holds, and a red run there
is a fact about the repository rather than about the runner. `agent-mesh-local-pm`
put it as D-752: **when local and CI disagree, the disagreement is the finding**,
and green says nothing about it.

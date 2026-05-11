# Contributing to agent-mesh-platform

PRs are welcome at any time. This is still an early PoC, so contributions of
any size — typo fixes, new runtime-adapters, new channel-drivers, sharper
docs, even just "this confused me" issues — are genuinely helpful.

No CLA, no strict gatekeeping. Be kind, keep PRs focused, and we'll work
through it together.

## Quick dev loop

```bash
git clone https://github.com/sir-mirr/agent-mesh-platform.git
cd agent-mesh-platform
bun install
bun run typecheck   # workspace-wide; should exit 0 before you push
```

Per-package typechecks (`bun run typecheck:core`, `:discord`, `:codex`, etc.)
are listed in `package.json` if you want a tighter loop while iterating on
one package.

## What to know before opening a PR

- **Keep PRs small and focused.** One concern per PR makes review fast and
  revert cheap. If you're tempted to bundle "while I'm in here" cleanups,
  consider splitting them out.
- **Wire-protocol changes need `SPEC.md` updates.** The SPEC is the single
  source of truth for the JSON-RPC envelopes, channel-driver contracts (§4),
  runtime-adapter contracts (§5), and the discovery / handoff flows (§10,
  §11). If your change touches behavior another adapter would need to match,
  please update the SPEC alongside the code in the same PR.
- **Commit messages.** Internally we use a `DG-NN-N` / `β-NN cycle` audit
  trace convention because this repo has a heavily-audited SPEC. External
  contributors are welcome to use plain
  [Conventional Commits](https://www.conventionalcommits.org/) — anything
  readable and scoped works.

## Good places to start

- `packages/runtime-adapters/codex/` — reference implementation of the SPEC §5
  runtime-adapter contract. A good template if you want to add a new runtime.
- `packages/channel-drivers/discord/` — reference implementation of the SPEC
  §4 channel-driver contract. A good template for a new channel.
- `SPEC.md` itself — read the section you're touching end-to-end before
  editing code. Drift between SPEC and code is the #1 thing reviewers will
  flag.

## Code style

- TypeScript strict mode. Match existing patterns in the package you're
  editing.
- No linter / formatter enforced yet. We'll add one before declaring the
  repo "post-PoC" — until then please just keep things consistent with
  surrounding code.

## What's not here yet (heads-up)

This is a PoC. CI, automated tests, issue templates, a richer contributor
guide, and a public release license/governance setup will all land in later
phases. If you hit something missing, an issue noting it is itself a useful
contribution.

Thanks for stopping by. 🌱

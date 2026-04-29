# Agent-Mesh Platform

Private monorepo skeleton for the reset architecture:

- `agent-mesh` is the channel fabric
- channel integrations live under channel drivers
- model-specific integration lives under runtime adapters

This skeleton is intentionally private-first. It is designed to be copied into
the lab LXC and then filled in during the first migration pass.

## Layout

```text
packages/
  agent-mesh-core/
  channel-drivers/
    discord/
  runtime-adapters/
    codex/
docs/
.github/
```

## Package Roles

### `@agent-mesh/core`

Owns the shared contract:

- normalized channel envelope
- action proxy contract
- capability matrix
- normalized history strategy
- ownership validation for `proxy_for` and `from`

### `@agent-mesh/channel-discord`

Owns Discord-specific behavior:

- bot client lifecycle
- inbound envelope conversion
- outbound `reply`, `react`, `edit_message`
- attachment fetch / policy / gating
- live Discord history fallback

### `@agent-mesh/runtime-codex`

Owns Codex runtime integration:

- Codex app-server client
- thread / turn lifecycle
- envelope to turn-input conversion
- adapter-side routing and handoff logic

## Dependency Rule

```text
@agent-mesh/channel-discord -> @agent-mesh/core
@agent-mesh/runtime-codex -> @agent-mesh/core
```

Direct dependency between channel drivers and runtime adapters is intentionally
forbidden.

## Status

This directory is a scaffold, not the final migrated repo.

- workspace definitions are present
- project references are wired
- package stubs are present
- real source files, build scripts, and dependencies land in migration step 1-4

## Next Steps

1. create `src/` trees inside the three packages
2. move `plugins/agent-mesh` concerns into `@agent-mesh/core`
3. absorb `discord-patched` and `kongming-discord-gateway` into `@agent-mesh/channel-discord`
4. rename and shrink `agent-mesh-codex-bridge` into `@agent-mesh/runtime-codex`

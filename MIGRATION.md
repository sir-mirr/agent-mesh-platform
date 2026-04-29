# Initial Migration Memo

This memo assumes the reset architecture is already agreed:

- `agent-mesh` = channel fabric
- Discord becomes a channel driver, not a separate plugin surface
- Codex integration remains, but only as a runtime adapter

## Source Mapping

| Current path | New package | First move |
|-------------|-------------|------------|
| `/home/ubuntu/ai/plugins/agent-mesh` | `packages/agent-mesh-core` | extract envelope, tool contract, history, hub logic |
| `/home/ubuntu/ai/plugins/discord-patched` | `packages/channel-drivers/discord` | port tool surface and access policy behavior |
| `/home/ubuntu/ai/plugins/kongming-discord-gateway` | `packages/channel-drivers/discord` | port worker-style Discord ingress/egress runtime |
| `/home/ubuntu/ai/plugins/agent-mesh-codex-bridge` | `packages/runtime-adapters/codex` | rename to codex adapter and remove Discord-specific assumptions |

## Migration Order

### 1. Core First

Move the shared contracts before moving implementations:

- channel envelope type
- action proxy interface
- capability matrix
- normalized history abstraction
- ownership validation points

Reason:

- once the contracts live in `@agent-mesh/core`, the Discord and Codex moves
  become implementation-only migrations

### 2. Discord Driver Second

Combine two current lines into one package:

- `discord-patched` tool/API surface
- `kongming-discord-gateway` worker/inbound/outbound flow

The result should be one Discord package with:

- shared driver library
- one-worker-per-bot runtime model
- a single envelope/action contract upward into core

### 3. Codex Adapter Third

Rename and shrink `agent-mesh-codex-bridge`:

- keep Codex app-server JSON-RPC integration
- keep thread/turn/handoff logic
- remove the assumption that Discord is its own parallel plugin
- replace hardcoded route ideas with core-owned action proxies

### 4. Runtime Docs And Units Last

Only after package boundaries are stable:

- rewrite systemd templates
- rewrite spawn checklists
- rewrite env layout docs
- define per-worker port maps if still needed

## First Code Extraction Targets

### From `agent-mesh`

- `mesh.message` envelope normalization
- MCP tool list / contract ideas
- history and registry ownership
- `proxy_for` / `from` validation entry points

### From `discord-patched`

- `reply`
- `react`
- `edit_message`
- `download_attachment`
- `fetch_messages`
- access / gate model

### From `kongming-discord-gateway`

- `<channel source="discord" ...>` wrapping logic
- attachment summary and file-guard behavior
- outbound worker endpoints and Discord send flow

### From `agent-mesh-codex-bridge`

- Codex thread lifecycle
- turn enqueue / steer rules
- handoff / rotation behavior
- route freeze logic

## Guardrails

- do not keep a direct dependency between Discord code and Codex code
- do not move `proxy_for` ownership checks out of core
- do not reintroduce a "Discord plugin + agent-mesh MCP side-by-side" model
- do not publish before the private lab migration proves the new package seams

## Deliverables After This Skeleton

1. create `src/index.ts` stubs in each package
2. wire minimal package-level dependencies
3. move envelope and tool contracts into core
4. start the Discord driver merge

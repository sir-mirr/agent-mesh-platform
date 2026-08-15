# Working in this repository

## Agent mailbox

Development on Agent Mesh is split across two repositories and two agents. They
coordinate through a local mailbox rather than through a human relaying
messages.

| | |
|---|---|
| **My identity** | `platform-claude` |
| **Codex, building the client** | `client-codex` |
| **Mailbox** | `http://localhost:3100` |
| **Repositories** | this one (platform), `agent-mesh-client`, `agent-mesh-contracts` |

### Check at the start of a turn

```bash
curl -s "http://localhost:3100/api/mail?agentId=platform-claude"
```

**Reading does not consume.** The same messages come back on every call, so an
inbox that is never cleared replays its whole history each turn. After acting
on what arrived:

```bash
curl -s -X DELETE "http://localhost:3100/api/mail?agentId=platform-claude"
```

`DELETE` clears the whole inbox, not the messages just read — anything that
arrived between the `GET` and the `DELETE` is lost. Messages carry an
incrementing `id`, so when a turn is long, act on the ids you fetched and clear
only once you are done.

### Send

```bash
curl -s -X POST http://localhost:3100/api/mail \
  -H 'content-type: application/json' \
  -d '{"from":"platform-claude","to":"client-codex","body":"..."}'
```

Bodies are plain strings up to 10 MB, so a diff, a schema or a full error
transcript can go in one. Response shape is
`{id, from, to, body, createdAt}`.

### What is worth sending

The mailbox is for things the other side cannot discover by reading the repos:

- **A contract changed.** A new `agent-mesh-contracts` tag, and what moved.
  The other side pins a tag and will not notice otherwise.
- **A SPEC section landed, or its status changed.** `SPEC.md`'s table says what
  is built; a change there changes what the other side can rely on.
- **A blocking question about the other side's half.** Anything that would
  otherwise sit unanswered while both sides guess.
- **An interface disagreement**, before either side builds on it.

Not worth sending: progress narration, anything already visible in a commit
message, or a question answerable by reading `SPEC.md`.

When something needs a decision from Lyong rather than from Codex, say so here
rather than mailing it — the mailbox is agent-to-agent.

---

## Port 3100 collides with the hub

The mailbox listens on `3100`. So does `agent-mesh-hub` by default
(`AGENT_MESH_HUB_PORT`).

Integration tests are unaffected: `test/harness.ts` asks the OS for ephemeral
ports. But `bun run start:hub` with no port set will fail to bind while the
mailbox is up. Pass a port explicitly:

```bash
AGENT_MESH_HUB_PORT=3200 bun run start:hub
```

---

## Before finishing a change

```bash
bun run typecheck
bun test packages/
bun test test/
```

CI runs all three. `test/` starts real hub and http processes, so a failure
there usually means wiring rather than logic.

---

## Where to read

| | |
|---|---|
| `docs/architecture.md` | what runs, what owns which data, and why |
| `docs/implementation-plan-0.2.md` | what is being built next, in order |
| `SPEC.md` | the normative contract, and its build-status table |
| `docs/decisions/` | settled design, with the reasoning |
| `docs/open-questions.md` | what is undecided |

`SPEC.md` is the contract any implementation satisfies;
`docs/architecture.md` is how this one is built. When they disagree, SPEC wins
and the architecture document is wrong.

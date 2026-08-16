# Proposal — two operator roles, and what separating them can actually enforce

Status: **proposed**. Nothing below is built.

Today there is one authenticated role that does everything: `admin` approves
keys, tears identities down, reads the audit trail and reads inbox depth. The
proposal splits it.

| | |
|---|---|
| **Platform operator** | runs the mesh — processes, ports, storage, upgrades |
| **Agent operator** | owns specific agents and is answerable for them |

Three rules follow from the split:

1. **Key approval belongs to the agent operator.** It is their agent.
2. **The platform operator has no audit rights.**
3. **An agent operator's audit reach is their own agents and no further.**

## Rule 2 is a policy boundary, not a security boundary

This has to be said before anything else is designed on top of it.

The platform operator runs the host. `agent-mesh-http` opens
`~/.agent-mesh-local/state/audit.db`; anyone with a shell on that machine
reads it with `sqlite3` and never touches the role check. They can also read
`agents.db`, restart the process with the check patched out, or set
`JWT_SECRET` and mint themselves any role — that value is an environment
variable on the same host.

So "the platform operator cannot read the audit trail" is enforceable only as
far as the platform operator's own restraint, unless one of these is also true:

- **The audit store lives somewhere they do not administer.** A separate host,
  a managed database, an append-only log service — different blast radius,
  different people.
- **Events are encrypted to the owning operator's key**, and the hub writes
  ciphertext it cannot read back. This is the only version that survives a
  hostile platform operator, and it costs the audit query API: you cannot
  filter server-side on fields you cannot read.
- **Writes are mirrored out** to something with independent retention, so
  tampering is detectable even if reading is not preventable.

None of that is in this repository today. **The role check is worth building
anyway** — it removes accident, makes intent explicit, and puts the access on
record — but the SPEC must not claim it prevents a determined platform
operator, because it does not. Documenting a control as stronger than it is, is
how it ends up load-bearing.

## Where ownership goes

`users` has `role`. `policies` maps `(github_login, allowed_agent)` and already
exists — but it means **"may send messages to"**, which is a different grant.
Merging them would mean granting message access silently grants approval and
audit rights over the same agent.

So a separate relation:

```sql
CREATE TABLE agent_owners (
  identity   TEXT NOT NULL,
  owner      TEXT NOT NULL,          -- users.github_login / local_users.username
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (identity, owner)
);
```

Plural on purpose. One agent with exactly one owner means the owner leaving
strands it, and the recovery is a platform operator editing the table — which
is the thing rule 2 was trying to avoid.

## The ordering problem, and what it fixes

An agent operator cannot approve their own agent's key if nothing yet says the
agent is theirs, and `POST /api/v1/agents` is unauthenticated (§ 9.2 †), so
registration cannot assert an owner — anyone reaching the port could claim
anyone's agent.

That inverts the current onboarding:

```
now       agent registers itself + key   ->  admin approves
proposed  operator claims the name       ->  agent registers its key
          (authenticated, on http)           against a name that has an owner
                                          ->  that owner approves
```

**This also closes an open question.** Unauthenticated hub provisioning is
recorded in `open-questions.md`; making the name-claim authenticated removes
the anonymous route's ability to create anything an operator did not ask for.
`POST /api/v1/agents` keeps working for the key half — a lane must be able to
propose its key without holding a human's credential, which is the whole reason
that route is open.

Names nobody claimed keep the old behaviour or are refused, and that is a
decision to make rather than one this document should make quietly.

## Self-approval does not break § 10.2

The obvious objection is that the operator approving is now the same person who
runs the lane, so the second pair of eyes is gone.

**§ 10.2's control was never a second person.** It is a second *channel*: the
lane logs its fingerprint at startup, the approval surface displays the
fingerprint it is about to approve, and the operator compares two paths that an
attacker would have to compromise both of. One person comparing two channels
still catches a substituted key. What it does not catch is that person being
careless or hostile, which was already true.

What genuinely changes: nobody outside is checking that this operator should
have an agent at all. That is a platform-operator question — they grant
ownership — and it is the one thing rule 1 leaves them.

## Rule 3 has a shape problem worth deciding early

`audit_events.identity` is **the sending identity**. Scoping by it is one
`WHERE` clause, and it produces the wrong answer:

```
alice owns agent-a          bob owns agent-b
agent-a  ---- message ---->  agent-b
event.identity = agent-a
```

Bob cannot see a message his own agent received. An operator who cannot audit
what arrived at their agent has no audit worth the name.

Scoping by participant — `from` **or** `to` — fixes that and immediately leaks
the other way: the event carries the message body (§ 8.9.4, deliberately), so
Bob reading his agent's inbound events reads what Alice's agent sent, and Alice
did not agree to that.

Three answers, none obviously right:

- **Participant scope, full body.** Simple and honest about what a mesh is:
  if you send to someone, they can read it. Cross-owner sends become a
  disclosure decision made at send time.
- **Participant scope, body only for events your agent produced.** The
  recipient sees that a message arrived, from whom, when, how big — not the
  content. Consistent with what `admin/inbox` already does for depth.
- **Owner scope with an explicit share.** Alice grants Bob visibility on the
  pair. Correct and nobody will configure it.

The second matches decisions already taken in this repository and is the one to
argue against first.

## What this does not answer

- **Who onboards the agent operators.** Presumably the platform operator, which
  means they can create an operator account, hold it, and read audit through
  it. Rule 2 does not survive that unless account creation is separated too —
  see the boundary section.
- **Teardown.** § 9.3 destroys an identity. Owner's call, platform's call, or
  both?
- **Cross-owner proxying.** `sent_by` may belong to a different owner than
  `from`. Whose audit does a proxied send land in?
- **The `admin` role's fate.** Splitting it in place breaks every existing
  caller of `/api/v1/admin/*`; keeping it as a superset makes rule 2 a comment.

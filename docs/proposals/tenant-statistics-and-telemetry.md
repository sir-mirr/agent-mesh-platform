# Tenant statistics, and what an operator actually watches — draft

Status: **draft for the PM.** Two requirements arrived together
(`/platform/tenants`, `/platform/telemetry`) and are answered together because
the same question decides both: *what does an operator do differently after
reading this number?*

Both screens exist already and were built before either requirement. Neither
design below is derived from them — the screens are what happens when the order
is reversed, and `Acme, Nova, Fin, Edge` and `memory_total_mb: 1024` are what
that produces.

---

## 1. Tenant statistics — the data model does not support the question yet

**`tenant` is not on anything that carries traffic.** It exists on exactly two
tables, both from § 11 and § 12:

```
role_grants   tenant, subject, capability, scope
groups        tenant, group_id
group_members tenant, group_id, identity
```

It is **not** on `agents`, not on `messages`, not on `audit_events`. So "traffic
per tenant" cannot be computed today by any query, and no endpoint can be
written that answers it honestly.

This is worth stating plainly rather than working around, because the
work-arounds all quietly invent something:

- **Deriving tenancy through group membership** gives an answer, and it is the
  answer to a different question. An identity in no group has no tenant; an
  identity in two would have two. Both are legal today.
- **Assuming `default`** makes every deployment single-tenant and the screen a
  constant, which is what the hardcoded one already was.
- **Adding `tenant` to `messages`** is the real fix and is a schema change with
  a rule attached — *who* sets it, and what happens to a message between two
  tenants. That rule does not exist yet.

### What can be answered today, honestly

**Per group**, from `messages` joined through `group_members`:

| | source | § |
|---|---|---|
| messages sent, received | `messages.from_agent` / `to_agent` | § 8.2 |
| still waiting | `messages.status = 'pending'` | § 8.10.1 |
| identities, and how many hold an approved key | `agents`, `agent_keys` | § 10.2 |
| egress refusals | `audit_events` | § 12 |

That is a real "traffic isolation" view — it shows what crossed a group boundary
and what was refused at one, which is what § 12 is *for*. It is also what the
screen appears to want, under a different word.

### Recommendation

**Either** rename the requirement to per-group and I build it now against data
that exists, **or** decide the tenancy model first — specifically what `tenant`
means on a message whose sender and recipient are in different ones — and I
build per-tenant on top of it.

The second is more work and is the one that makes the word "tenant" mean
something. The first is available this week. **This is a decision, not a
preference**, so it goes back rather than me picking.

---

## 2. Telemetry — start from the decision, not from the process

The requirement asked for CPU, RSS, heap and event-loop lag. Taking the brief
seriously — *what does an operator do differently after reading it?* — those
four do not survive the question on this system.

There is no autoscaler here, no capacity plan to revise, and one hub process by
design (`docs/architecture.md`). An operator reading `RSS: 412MB` on a mesh they
cannot scale horizontally learns something true and acts on none of it. That is
the same shape as a check that reports green without checking: information that
looks like grounds for a decision and is not.

### What an operator actually decides here

Every one of these has a § behind it and data already stored:

| Decision | Signal | Source | § |
|---|---|---|---|
| Somebody is waiting on me to approve a key | pending keys, oldest first | `agent_keys` | § 10.2 |
| A participant has stopped draining | oldest unacknowledged message age per identity | `messages` | § 8.10.1 |
| Something is failing to get in | signature refusals, by reason, recent | `audit_events` | § 8.1 |
| A limit is actually firing | rate-limit refusals | in-memory buckets | § 14 |
| A group cannot talk to who it needs | egress refusals, by pair | `audit_events` | § 12 |
| The mesh is not carrying anything | messages accepted in the last interval | `messages` | § 8.2 |

Each of those has an action attached — approve, chase the lane, look at a key,
widen a rule, raise a limit. That is the test the four process metrics fail.

### Where CPU and RSS do belong

Not nowhere. They belong to whatever runs the process — a supervisor, a
container platform, the host. Serving them from inside the process being
measured has a specific weakness worth naming: **a hub too sick to answer is a
hub that reports nothing, and nothing is what a healthy idle hub reports too.**
The reading everyone actually wants is the one taken from outside.

If a number is still wanted on the screen, `/health` already answers liveness
and is the honest place for it.

### Recommendation

Build the six above as one endpoint. Drop CPU/RSS/heap/lag from the platform
requirement, or move them to whatever supervises the process.

---

## What both of these have in common

Each requirement arrived as a screen. The screens were filled with constants —
tenant names, a memory total, a p99 — because there was nothing behind them, and
constants are indistinguishable from data until somebody blocks the backend and
watches whether the screen changes. Somebody eventually did, and none of them
did.

The order that avoids it is the one the PM asked for and the owner adopted:
**decide what is worth knowing, then serve it, then draw it.** These drafts are
the first step of that order, and going back with "the data model cannot answer
this yet" is a legitimate output of it.

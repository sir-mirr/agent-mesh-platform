# Note — what tenancy, groups and gateways will cost, written before they arrive

Status: **not a proposal.** Requirements named as upcoming: restricting who an
agent may talk to, agent groups, per-group gateways relaying between groups,
and tenant isolation. Nothing here is a design. It is what the current
architecture would have to give up, recorded now because two of these are much
cheaper to decide before the role split lands than after.

## Order matters, and tenancy comes first

These four are not independent. A group is scoped *within* a tenant; a gateway
relays *between* groups; a send policy is evaluated *inside* a tenant boundary.
Retrofitting a tenant column onto a built group model means revisiting every
query written in between, and every one that was written without it is a
cross-tenant leak waiting for a missing `WHERE`.

The role split now being designed is the first thing that would have to be
revisited, because `agent_owners` is a two-column table in a world where it
should probably be three.

## What tenant isolation actually costs here

**The stores are single files.** `agents.db`, `hub.db`, `audit.db`. Three
shapes, and they are not close:

| | |
|---|---|
| `tenant_id` column everywhere | cheapest; one forgotten `WHERE` is a cross-tenant leak, and it will be forgotten |
| database per tenant | isolation the filesystem enforces; the hub must open N stores and route by tenant before it can read anything |
| process per tenant | strongest and simplest to reason about; N× memory, N ports, and cross-tenant anything becomes a network problem |

**Presence is the part that does not shard cleanly.** `onlineAgents` is one
in-memory `Map` in one hub process, and `docs/architecture.md` already records
that this is why the hub does not scale horizontally. Per-tenant processes turn
that constraint into an advantage — each tenant gets its own map — and turn the
gateway into the only thing that has to speak across them.

Which is an argument that **process-per-tenant and group gateways want the same
architecture.** Worth noticing before choosing either.

## Gateways are proxies, and proxies here have a shape already

`can_proxy`, `proxy_for`, and `sent_by` exist (§ 8.2). A gateway relaying from
group A to group B is a participant that may send on behalf of identities it
does not own — which is exactly what the proxy entitlement is.

**But `sent_by` is a single field.** One hop fits:

```
from: agent-a          sent_by: gateway-1
```

Two hops do not:

```
agent-a → gateway-1 → gateway-2 → agent-b
from: agent-a          sent_by: ???
```

Squashing it to the last hop loses that `gateway-1` touched the message;
keeping the first loses that `gateway-2` did. Either way the audit trail
answers "who carried this" with one name when the true answer is a list.

The fix is a path rather than a field, and it is the same reasoning that
separated `from` from `sent_by` in the first place: **the sender and the
carrier are different facts, and so are two carriers.** Deciding this before
gateways exist is a schema change; deciding it after is a migration of the
audit trail, which is the one store that must not be rewritten.

A loop check comes with it. Gateways relaying to gateways will form a cycle the
first time someone misconfigures one, and a hop count is much easier to add now
than to retrofit under an incident.

## Restricting who may talk to whom

`policies (github_login, allowed_agent)` already exists for **person → agent**.
Agent → agent is a different table and should stay one; merging them means a
person's messaging grant and an agent's routing policy share a row, and the two
are revoked for different reasons at different times.

The question that decides the shape: **is the default allow or deny?** Today it
is allow — any registered identity may `mesh.send` to any other. A mesh that
ships as allow and adds restrictions is a mesh where every deployment is open
until someone configures it; one that ships as deny needs group membership to
be useful on day one, which is why groups and this arrive together.

Enforcement point matters too. Refusing at `mesh.send` tells the sender their
message was refused, which is correct and also tells an unauthorised sender that
the target exists. Accepting and dropping silently avoids that and produces a
mesh where messages vanish. The first is right; the second is the tempting one.

## The one thing to settle before the role split lands

`agent_owners (identity, owner)` should almost certainly be
`(tenant, identity, owner)` — and `identity` itself may need to be unique per
tenant rather than globally, which changes `IDENTITY_RE`, every route that
takes `{identity}` in a path, and the fingerprint-to-identity resolution in
§ 8.1.

**That last one is not obvious and is the expensive one.** `agent_keys` is
keyed on the fingerprint alone, globally. Two tenants cannot currently hold the
same identity name, and a key resolves to exactly one identity across the whole
deployment — which was fixed only today, and was a defect precisely because the
global uniqueness was not being checked.

Whether that global resolution is a property to keep or the next thing to
break is the decision this note exists to surface.

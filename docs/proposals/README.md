# Proposals

Design that has not been built. `SPEC.md` is the contract; these are arguments
about what the contract should become.

A proposal states its own status in its first line. `built` means SPEC has it
and this file survives only for the reasoning.

## The 0.3 requirement set — first draft

Four documents, one requirement each, written in the order the requirements
arrived. **Nothing in them is implemented.** They interact, so the reading order
matters more than usual: each one changes the shape of the ones after it.

| # | Document | Requirement | Settled |
|---|---|---|---|
| 1 | [`operator-roles.md`](operator-roles.md) | Split `admin` into platform operator, tenant admin, and roles inside a tenant | tenant admin is **inside** the tenant; capabilities are a grant table, not an enum; platform operator cannot read message **content** |
| 2 | [`attestation-claims.md`](attestation-claims.md) | What an attestation can prove | **Tier 2 only** — the hub's observation of the source, no self-reported values |
| 3 | [`dormancy-reattestation.md`](dormancy-reattestation.md) | Re-attest after three hours of silence | superseded in part by #2: the agent supplies nothing, so the `-32016` round trip is gone |
| 4 | [`tenancy-and-groups.md`](tenancy-and-groups.md) | Send restrictions, groups, group gateways, tenant isolation | not designed — costs recorded so the three above do not foreclose it |

### Read them in that order

#2 deletes a third of #3, and #1's boundary is what #4 has to be built inside.
Reading #3 alone gives a design that was already replaced.

### The three findings that shaped the set

**A control documented as stronger than it is becomes load-bearing.** It
recurred in all four. The platform operator cannot be blocked by an
application check on a host they administer; self-reported claims are worthless
against anyone who has read one; `sent_by` cannot name two carriers. Each is
written down as a limit rather than argued away.

**Choosing the narrower mechanism made the design smaller.** Tier 2 removed a
round trip, an error code, and a client-side claim-gathering contract — the
stronger option was also the cheaper one, which is not the usual direction.

**Two deferred items became prerequisites.** Audit-read logging was a gap in a
justification; once the tenant admin sits inside the tenant, it is the only
thing that makes their access defensible. The non-message audit event shape was
blocking three items and is now built (SPEC § 8.9.5).

### Settled

| | |
|---|---|
| Tenant admin | **inside** the tenant — a company admin. May tear down. |
| Audit scope | **participant, with content** — what your agent sent and received |
| Attestation | **Tier 2 only** — the hub's observation |
| Deployment | **behind a reverse proxy**, so the source is a header |
| Audit-read logging | owned by an **internal process**; the query side stays readonly |
| Three hours | **no derivation, and does not claim one** — configurable, and overridable so a test need not wait it out |

### Settled since

| | |
|---|---|
| Audit-read logging | written by **`agent-mesh-http` itself**, and **fail closed** — a read that cannot be recorded does not happen |
| Send restrictions | **deny by default**; an agent with no group joins a `default` agent group |
| Teardown | an agent operator may, for agents they own or where they hold `group.manage` |
| Dormancy for proxied sends | applies only where `sent_by == from`. `sent_by: http-server` is constant for every web send and carries no information; it becomes meaningful when it names a specific gateway |

### Still undecided

- **Default granularity for the observed source** — `exact`, `prefix` or `ASN`.
  The trade is how often it fires on legitimate churn against how close a thief
  has to be: `exact` catches most and fires on every DHCP renewal, `ASN` is
  quiet and misses a thief inside the same cloud. **A control that cries wolf
  gets switched off, so the strictest setting is often the weakest in
  practice.** `ASN` also needs an IP-to-ASN dataset that this deployment does
  not have; `prefix` is arithmetic.

### Two deployment properties the hub cannot check itself

Both come from assuming a proxy, and both fail open if wrong:

- The hub **must not be reachable except through the proxy**, or an attacker
  connects directly and writes `X-Forwarded-For` themselves.
- The source must be the **rightmost** address a trusted hop contributed. The
  leftmost is the conventional "original client" and is the forgeable one.

The capability document reports which mode the hub is in, because a control
configured off looks identical to one that is on.

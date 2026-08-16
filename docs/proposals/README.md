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

### What is undecided

These change what gets built, not how it is worded:

- **Is the hub behind a reverse proxy in any target deployment?** Decides
  whether #2 exists at all — `X-Forwarded-For` is a header.
- **Which process owns the audit-read write.** `agent-mesh-http` opens
  `audit.db` readonly on purpose.
- **Audit scope across owners.** Scoping by sender means a recipient cannot see
  what arrived; scoping by participant means they read the sender's content.
- **Three hours.** Taken from the requirement, not derived.
- **Whether an agent operator can tear down without the tenant admin.**
- **Dormancy for proxied sends** — the observed address is always the proxy's.

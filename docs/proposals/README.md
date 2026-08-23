# Proposals

Design that has not been built. `SPEC.md` is the contract; these are arguments
about what the contract should become.

A proposal states its own status in its first line. `built` means SPEC has it
and this file survives only for the reasoning.

## The 0.3 requirement set — first draft

Four documents, one requirement each, written in the order the requirements
arrived. **Every decision they settled is built** — the *Built* table below says
where each one landed in SPEC. What they deliberately did not settle is under
*Still undecided*. They interact, so the reading order matters more than usual:
each one changes the shape of the ones after it.


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

### Built

Every settled decision in the set is implemented and on `main`.

The paragraph at the top of this file said "Nothing in them is implemented" for
as long as this section has existed. Both sentences were written truthfully,
months apart, and a reader who stopped at the first had the opposite of the
answer — which is the whole cost, because the first is the one they reach
first. `test/readme.test.ts` compares the two now.

| | Section | |
|---|---|---|
| Observed source, recorded per request | § 8.11 | `GET /api/v1/admin/agent-sources` |
| Dormant send from an unseen network refused | § 8.11.2 | `-32017`, `prefix` granularity |
| Capabilities as a grant table, read per request | § 11 | nine capabilities, no role string |
| Message bodies withheld without `audit.read.content` | § 11.0 | redaction on the way out, and the SPEC says so |
| Content reads recorded, failing closed | § 11.0.1 | `mesh.identity.audit_read` |
| Ownership, pairing codes, scoped queues and teardown | § 11.3 | |
| Groups, deny by default | § 12 | `-32018`, seeded `default` self-rule |

### Settled: `prefix` stays (D-753)

Whether `ASN` should replace `prefix` as the observed-source granularity was
the last open item here, and it is closed on the shape of the two failures
rather than on which catches more.

**`prefix`'s false positive is loud.** A legitimate user who moves inside one
provider is refused with `-32017`, and a refusal is a thing somebody reports —
it arrives with a route to being fixed. **`ASN`'s false negative is silent, and
so is its dataset going stale.** A thief inside the same cloud account is
observed as the same provider and passes; a table that is three months old
answers confidently and wrongly. Nothing on either path signals that anything
happened. The trade being offered is loudness for quietness, and this
repository does not take that trade.

Both granularities and their costs stay written down in
[`attestation-claims.md`](attestation-claims.md), along with why vTPM — not CPU
fingerprinting — is the direction that would make the question go away. What
reopens this:

1. **A vTPM discussion starting**, which dissolves the question rather than
   answering it.
2. **Measured `-32017` false positives from legitimate users accumulating**,
   which turns the trade above from an argument into data.

### Two deployment properties the hub cannot check itself

Both come from assuming a proxy, and both fail open if wrong:

- The hub **must not be reachable except through the proxy**, or an attacker
  connects directly and writes `X-Forwarded-For` themselves.
- The source must be the **rightmost** address a trusted hop contributed. The
  leftmost is the conventional "original client" and is the forgeable one.

The capability document reports which mode the hub is in, because a control
configured off looks identical to one that is on.

# Proposal — two operator roles, and what separating them can actually enforce

Status: **proposed**. Nothing below is built.

Today there is one authenticated role that does everything: `admin` approves
keys, tears identities down, reads the audit trail and reads inbox depth. The
proposal splits it.

```
platform operator            runs the mesh — processes, ports, storage, upgrades
  └── tenant admin           owns a tenant; grants roles inside it
        ├── group manager    creates groups, moves agents between them
        └── agent manager    owns specific agents, approves their keys
        └── …                more will be added
```

**That `…` is the design constraint, not a footnote.** The current code asks
`if (payload.role !== 'admin')` in twenty-odd places, which extends to a second
role by adding a second string comparison to each of them and to a fifth role by
being wrong somewhere. A set that is expected to grow has to be a **grant table
resolved per request**, not an enum compared inline:

```sql
CREATE TABLE role_grants (
  tenant     TEXT NOT NULL,
  subject    TEXT NOT NULL,          -- the person
  capability TEXT NOT NULL,          -- 'key.approve', 'audit.read.metadata', …
  scope      TEXT NOT NULL,          -- '*' | group id | identity
  granted_by TEXT NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant, subject, capability, scope)
);
```

Routes then ask for a capability over a scope. Adding a role becomes rows;
adding a route becomes one `require(...)` call whose absence is visible.

### Capabilities are resolved per request, not carried in the token

The JWT holds `role` today, so the answer is fixed for the token's lifetime.
With one admin that is tolerable. With granular roles it means **revoking
someone's access does not revoke it** — their token keeps working until it
expires, and the one moment revocation matters is an incident, which is exactly
when nobody wants to wait out a TTL.

The token should carry identity; the grants should be read at the point of use.
That is a database read per authenticated request, on a store the process
already holds open.

Three rules follow from the split:

1. **Key approval belongs to the agent operator.** It is their agent.
2. **The platform operator cannot read message content.** Everything else an
   audit trail holds — who sent to whom, when, how much, what failed — they
   need, because that is how a mesh gets operated.
3. **An agent operator's audit reach is their own agents and no further.**

## Rule 2 is about content, and content is currently inside the event

The distinction already exists one layer up and is worth reusing rather than
reinventing. `GET /api/v1/admin/inbox` reports depth and withholds bodies, on
the reasoning that **seeing that someone has mail is a different authorisation
question from reading it.** Rule 2 is that same line drawn through the audit
trail.

The obstacle is that § 8.9.4 deliberately puts the body *in* the event:

```
payload = { message: { id, from, to, sent_by, content, reply_to }, … }
payload_digest = sha256(payload)
```

That was the right call for its own reason — audit retention and operational
retention stay independent, so rotating `messages` does not hollow out the
record. It also means there is no read of the audit trail that is not a read
of message content.

**Splitting the body out is the change.**

```sql
CREATE TABLE audit_event_bodies (
  event_id TEXT PRIMARY KEY REFERENCES audit_events(event_id),
  content  TEXT NOT NULL
);
```

with `body_sha256` moved *into* the payload. Without that the digest stops
covering the content and the body becomes a detachable, swappable blob — the
integrity property § 8.9.3 exists for would be traded away for an access
control, which is a bad trade made quietly.

Metadata queries then never join the body table, and the role check is one
join a platform operator's token never gets.

### It is still a policy boundary until the body is encrypted

The platform operator runs the host. `sqlite3 audit.db` opens both tables and
never sees the role check; `JWT_SECRET` is an environment variable on the same
machine, so they can mint any role they like.

The split is worth building regardless — it removes accident, makes intent
explicit, and puts each access on record — but it prevents a *mistake*, not a
determined administrator. What would actually prevent one:

- **Bodies encrypted to the tenant's key**, hub writing ciphertext it cannot
  read back. Costs nothing else here, because bodies are not queried — the
  metadata that filtering needs stays in the clear. **This is unusually cheap
  for what it buys, precisely because the split above already isolates the one
  column nobody filters on.** One key per tenant, not per operator — see the
  tenant-admin section for why.
- **The audit store administered by someone else** — different host, different
  people, different blast radius.
- **Writes mirrored to independent retention**, so tampering is detectable even
  where reading is not preventable.

The SPEC must not describe the unencrypted split as preventing a platform
operator from reading messages. Documenting a control as stronger than it is,
is how it ends up load-bearing.

### For a commercial deployment this stops being optional

If tenants are meant to operate independently, "the platform operator promises
not to look" is not a statement a tenant can act on. Encrypted bodies are the
version that can be stated in a contract, and the split above is what makes
them cheap. Deciding this before the audit schema is settled is much easier
than after.

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

### How the claim is proved

The claim has to bind a **person** to a **name**, and the two live on opposite
sides: the person is in a browser session, the agent is a process on some host
with a CLI. Three ways to close that gap, in increasing order of infrastructure.

**Pairing code.** The operator, already logged in, asks the platform for a
short-lived code; they type it into the CLI; the CLI redeems it and the name is
bound to that session's user. This is the device authorization grant
(RFC 8628) with the roles reversed, and it is the only option here that needs
**no new infrastructure at all** — a table, an expiry, and a rate limit.

Its properties are worth stating because they are what make it good enough: the
code is short-lived and single-use, it is only ever entered on a host the
operator already controls, and a stolen code buys one name-claim inside its
window rather than an account. Redemption should also record the host it came
from, which is the `observed` half of
[`attestation-claims.md`](attestation-claims.md) arriving for free at exactly
the moment ownership is established — the strongest moment to record it.

**Owner email at agent creation.** Cheap to add, and it is a *label* until
something verifies it. Recording an unverified email as ownership is worse
than recording nothing, because the screen then shows an owner nobody checked.
Useful as contact metadata; not as a claim.

**Email verification.** The real answer for a commercial deployment, and it is
a mail sender, a bounce path, deliverability, and an abuse surface. Deferring
it until then is the right call — provided the pairing code is built such that
email verification later *strengthens* the same binding rather than replacing
it. Concretely: the owner column holds a platform user, and email verification
becomes a property of that user, not a second ownership mechanism.

The failure to avoid is shipping the email field first, treating it as
ownership because it is there, and discovering the pairing code has nowhere to
attach.

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

## The tenant admin is inside the tenant

A company admin. That settles three things that were open, and creates one
requirement.

**Ownership is delegation, not sovereignty.** The tenant owns its identities;
the agent operator is the person answerable for them day to day. So a tenant
admin reaching an agent inside their own tenant is not a boundary violation —
it is the boundary working. An agent whose owner leaves is reassigned by the
tenant admin, and no platform operator touches a table to make that happen.

**The strong boundaries are the two that cross a tenant edge**, and only those:

```
tenant ─── tenant      never
tenant ─── platform    no message content
inside a tenant        the tenant's own policy
```

**Encryption becomes per tenant, which is simpler than what this document
first said.** An earlier draft proposed encrypting bodies to the *owning
operator's* key, which would have locked out the tenant admin too — wrong for
a company admin, and it would have made key custody a per-person problem.
One key per tenant, held by the tenant, is both easier to operate and the
thing a contract can actually describe: the platform cannot read; the company
can.

### And it makes audit-read logging a requirement

"The company admin can read your agent's messages" is acceptable in a way that
"someone can read them and nobody knows" is not. The difference is entirely
whether the access is recorded.

That is currently **not** recorded, and not by oversight: `agent-mesh-http`
opens `audit.db` with `readonly: true`, so it could not write the event if one
existed ([`deferred.md`](../deferred.md)). It was deferred as a gap in a
justification. This decision promotes it — **a tenant admin inside the tenant
is only a defensible design if reading leaves a trace**, so the deferred item
becomes a prerequisite of the role model rather than a loose end beside it.

The event shape it needs now exists (§ 8.9.5). What it still needs is a write
path to a store this process is deliberately prevented from writing to, which
is a decision about which process owns that write rather than a patch.

**And the record has to survive the person it is about.** A tenant admin is
accountable to nobody inside the system — they grant the roles — so a trail
they can delete records nothing. This is the argument for the mirrored,
append-only option that rule 2's boundary section listed as optional; here it
is the only thing making the access reviewable.

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

- **Who onboards the tenant admins.** The platform operator, presumably — which
  means they can create a tenant admin account, hold it, and read through it.
  Rule 2 survives that only in the encrypted-body version, where the grant does
  not carry the key.
- **Teardown.** § 9.3 destroys an identity. Owner, tenant admin, or both?
  Settled in outline by the section above — the tenant admin can, because
  someone has to when an owner leaves — but whether an owner can destroy
  without the tenant admin is still open.
- **Cross-owner and cross-group proxying.** `sent_by` may belong to a different
  owner than `from`. Whose audit does a proxied send land in — and once
  gateways exist, `sent_by` cannot even name all the carriers
  ([`tenancy-and-groups.md`](tenancy-and-groups.md)).
- **The `admin` role's fate.** Splitting it in place breaks every existing
  caller of `/api/v1/admin/*`; keeping it as a superset makes rule 2 a comment.
  The likely answer is that `admin` becomes a seeded grant set rather than a
  string, so existing deployments keep working and new checks are written
  against capabilities from the start.

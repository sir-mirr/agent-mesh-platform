# Tenant message statistics — design draft

Status: **draft for the PM.** Supersedes the tenant half of
`tenant-statistics-and-telemetry.md`, which said the question could not be
answered. The owner's direction resolves the part that was blocking, and this is
what it looks like built.

The owner's four constraints, kept verbatim in effect:

```
1. no `tenant` column on `messages` — a separate aggregation table
2. recorded at routing time, per message_id, minimal columns
3. attributed to the recipient — "받은 것 위주"
4. externally-originated traffic counts too
```

---

## What the recipient rule fixes

The question that stopped the first draft was: *a message between two tenants
belongs to which one?* The answer is now **the recipient's**, and it is worth
saying why that is not merely a choice.

It is a **total** rule. Every message has exactly one recipient, so every
message has exactly one tenant — no exceptions, no pairs, no nulls. A sender
rule would leave traffic that arrives in a tenant without appearing in that
tenant's view, which is the reading an operator would actually be misled by:
"nothing came in" when something did.

It also makes constraint 4 fall out rather than need a rule of its own. Whatever
reaches the mesh from outside is delivered to a mesh identity, and that identity
has a tenant. **External traffic needs no special case** — the recipient is
always inside.

---

## The blocking gap, and the smaller of the two ways to close it

The owner's premise — *"에이전트가 어느 테넌트 소속인지만 알면 되니까"* — is not
true yet. `agents` has no `tenant`. The only path to one today is
`group_members`, and that path has two holes I flagged before: an identity in no
group has no tenant, and an identity in two has two. **Both are legal now.**

Two ways to make the premise true:

**(a) `agents.tenant`, defaulting to `default`.** One column, one value, no
rules. Every identity has exactly one tenant from the moment it is provisioned,
including the ones that exist already.

**(b) Derive from group membership, plus rules for none and for several.** No
schema change, and two new rules that have to be written down, tested, and
explained — and that stay ambiguous by construction, because a person putting an
identity in two groups is not thereby saying which tenant it bills to.

**Recommend (a).** It is what "minimal information" means here: the smallest
thing that makes the premise true is a value, not a policy. (b) adds no column
and adds two rules, which is the more expensive kind of addition — a schema
change is read once, a derivation rule is reasoned about every time.

It also puts tenancy where the other tenant-scoped tables already expect it.
`role_grants` and `groups` carry `tenant` as a column; `agents` being the
exception is what forced the derivation question in the first place.

---

## Schema

```sql
CREATE TABLE message_stats (
  message_id  TEXT PRIMARY KEY,        -- one row per message, per constraint 2
  tenant      TEXT NOT NULL,           -- the recipient's, per constraint 3
  to_agent    TEXT NOT NULL,
  from_agent  TEXT NOT NULL,
  via         TEXT NOT NULL,           -- 'mesh' | 'mailbox' (§ 8.2a)
  ts          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_message_stats_tenant_ts ON message_stats(tenant, ts);
```

**What is deliberately not here.**

No `content`, no size, no `sent_by`. § 11.0 draws the line at metadata for the
platform operator, and a statistics table is exactly where content leaks in
under the name "just a length". Anything wanting the body can read `messages`
under the audit rules that already govern it.

No `status`. Delivery outcome changes after the row is written, and a statistics
table that has to be updated is a statistics table that can disagree with the
thing it counts. This records **that a message was accepted for a recipient**,
which is what "traffic" means and what does not change afterwards.

`message_id` is the primary key, so the retry a `client_message_id` collapses
(§ 8.2) counts once — the idempotent path returns the original id and never
reaches the insert.

**Which database.** `hub.db`, beside `messages`. It shares that table's
retention: statistics about messages that have rotated away are statistics
nobody can check against anything, and `docs/architecture.md` splits the files
by retention precisely so this kind of decision is available.

---

## Where it is written

**One place: `accept()` in `packages/mailbox`.** Verified rather than assumed —
every path that writes a message goes through it:

```
socket  mesh.send            → handleSend → accept()
HTTP    POST /api/v1/rpc     → handleSend → accept()
mailbox POST /api/v1/mailbox/out → handleSend → accept()
web     POST /api/v1/messages    → http proxies as the person → handleSend → accept()
```

That last one is constraint 4's answer: traffic originating outside the mesh
reaches it through the http server acting as a proxy (§ 8.2), and lands in the
same transaction as everything else.

**In the same transaction as the message.** `accept()` already takes an
`alsoInTransaction` hook for the dormancy clock, for the same reason: a count
that commits when the message does not is a count of things that did not happen.

## What the mailbox is allowed to know

The mailbox must not learn what a tenant is — it does not know the hub exists,
and it certainly should not know § 11. So the tenant arrives the way `status`
and `via` already do: **decided by the caller, passed in.**

The hub resolves the recipient's tenant and hands it over. That is the same
boundary rule that made `replyChannel` take presence as an answer rather than
asking for it — *anything the mailbox can ask, it depends on.*

---

## Where it attaches in the SPEC

**§ 11.4**, under tenants. Not § 12: groups are an egress-policy mechanism, and
attaching statistics there would tie a count to a policy that can be rewritten
without the traffic changing.

The read route is `GET /api/v1/admin/tenants` on the http server, gated on a
capability. `audit.read.metadata` is the closest existing one and is the right
shape — this is metadata about messages and contains no content — but a
`tenant.read.stats` of its own is defensible if an operator should be able to
see traffic without seeing the audit trail. **That is a decision, and it goes
back rather than me picking.**

---

## What this does not do

It does not backfill. Rows exist from the migration onward, and a tenant's
history starts when the table does. Backfilling would mean assigning a tenant to
old messages from today's group membership, which is a guess wearing a number's
clothes.

It does not aggregate on write — no counters, no rollups. Counting rows in a
window is fast at this scale, and a maintained counter is a second copy of a
fact that can drift from the rows it counts. If volume ever makes that false,
the rows are still there to roll up from.

# Open questions — identity and authentication

Status: **everything numbered here has been ruled on.** What follows is the
record of those rulings and, in two places, the condition that would make a
question live again. Items 1-4's design lives in
[`decisions/identity-and-authentication.md`](decisions/identity-and-authentication.md).

| # | Question | Where it stands |
|---|---|---|
| 1-4 | Identity and authentication | decided; see the decision document |
| 5 | Attachment download is unauthenticated | ruled — parties to the message (SPEC § 15.3) |
| 6 | One token guards the whole lane HTTP surface | ruled for the deployment; **the SPEC § 4.5 contract question is still open** |
| 7 | HTTP server hardening | closed — all three fixed |
| 8 | Where the http admin surface's refusal codes are named | settled for now (D-740); **reopens the moment any repository reads one** |
| 9 | What the audit console's search box means | closed — a literal substring (D-743) |

**The heading said "what follows are the items still open" while four of the
five below carried `~~closed~~` in their own titles.** Nothing was hidden — a
reader who got as far as the headings saw it — but the first three lines of a
document are what a reader in a hurry takes away, and those said this file was
a list of live questions. It is a ledger with two conditions in it.

The four resolved items were, in short: hub connect carried no credential;
`proxy_for` entitlement was unenforced; `mesh.send` accepted a caller-supplied
`from`; and the hub REST control plane, including the destructive identity
teardown, was unauthenticated. They shared one question — what authority says
an identity is who it claims to be — and were answered together with registered
Ed25519 public keys, an operator approval procedure, and per-message
signatures.

Teardown took two changes, and reading them as one is a mistake this paragraph
made for a while. It became a **soft delete** because the signature decision
requires it — discarding a key makes every past signature unverifiable — and
that is a different fix from **authenticating it**, which happened later:
`DELETE /api/agents/{identity}` on the hub was reachable by anyone who could
reach the port until teardown moved to `agent-mesh-http` behind the admin JWT
(§ 9.3). Until then a single unauthenticated request revoked every key an
identity held, and § 9.3 forbids re-registering the name afterwards.

The items below are independent of that work. Each states what was ruled and,
underneath, the original entry as it was written — the reasoning is the record,
so nothing is deleted when a question closes.

**This file holds questions nobody has ruled on.**
[`deferred.md`](deferred.md) holds the opposite: things that were decided and
deferred deliberately. An item in both goes stale in one, so each lives in
exactly one — line numbers are omitted for the same reason.

---

## 5. Attachment download is unauthenticated — ~~closed~~

**Ruled:** the parties to the message carrying it — sender or recipient, agent
or person. Implemented in SPEC § 15.3.

The capability-by-digest argument was the one on the table, and it loses for a
reason worth keeping: an unguessable id is a capability only while it stays
unguessed, and this one travels *inside the thing it protects* — in the
`download_url` of every message carrying it, in audit events, in logs. A
capability nobody can withdraw is not one.

Participation reads `messages` rather than the audit trail, so access expires
with the operational record instead of with the permanent one. `sent_by` does
not count: carrying a message is not being party to it.

### Original entry

## 5. Attachment download is unauthenticated

`GET /api/v1/attachments/:id` (`packages/http/src/main.ts`) serves
bytes to anyone who can reach the port. SPEC § 15.3 states this explicitly and
tells clients to tolerate a future `401`.

Attachment ids are sha256 digests, so they are unguessable in practice — this
is capability-style access, not open listing. Whether that is sufficient
depends on whether attachment ids ever leak into logs or third-party channels.

Decisions needed:

- Keep capability-by-digest, or require a mesh bearer token?
- If tokens: lane VMs fetch on demand (§ 15.4) and would each need one.

## 6. One token guards the whole lane HTTP surface — ~~ruled, not changed~~

**Ruled:** the internal network keeps its unauthenticated arrangement. The
server binds `127.0.0.1`, so this is an intra-host boundary, and splitting the
credential buys separation between two things already inside the same trust
boundary.

Left recorded rather than deleted: the ruling holds while the binding does, and
the day that server listens on anything else this becomes live again.

### Original entry

## 6. One token guards the whole lane HTTP surface

A single `isAuthorized` gate covers every path on the adapter's HTTP server —
both `/ingress/channel` and `/actions/mesh`.

The token is `CODEX_ADAPTER_HTTP_TOKEN`, which the Discord driver holds as
`CHANNEL_INGRESS_TOKEN` (SPEC § 4.5). So the channel driver's ingress
credential now also authorises mesh sends and reminder writes — a wider grant
than the driver needs.

Mitigating: the server binds `127.0.0.1` only, so this is an intra-host
boundary, not a network one.

Decisions needed:

- Split the surfaces (separate token for `/actions/mesh`), scope per-path, or
  accept that everything inside a lane is one trust domain?
- The same single-gate shape exists on the driver side — should both change
  together?

Note: the adapter and driver have left this repository, so the fix lands in
the lane repository. The *contract* question — what SPEC § 4.5 requires of a
conformant lane — stays here.

## 7. HTTP server hardening — ~~closed~~

All three are fixed. `JWT_SECRET` has no fallback and the process refuses to
start without it; CORS is an allowlist from `AGENT_MESH_ALLOWED_ORIGINS`,
empty by default; the ingest bearer is compared in constant time over hashes of
both sides.

**The whole suite passed before any of them**, which is the part worth keeping.
A published fallback secret, a wildcard CORS policy on a cookie-authenticated
server, and a `===` on a token are all invisible to tests about behaviour —
nothing was checking them because nothing they broke was a behaviour.

The CORS one was the live risk: this server authenticates with a **cookie**, so
a page on any site could make an authenticated request on a visitor's behalf
and read the answer. The browser attaches the session; the page never needs the
token.

### Original entry

## 7. HTTP server hardening

Smaller items, same theme:

- `packages/http/src/auth.ts` — `JWT_SECRET` falls back to
  `'lab-fallback-secret-change-me'`. An unset secret should fail startup, not
  silently sign tokens with a published constant.
- `packages/http/src/main.ts` — `app.use('/*', cors())` allows every
  origin, marked "Phase 1". Combined with cookie-borne JWT sessions this
  deserves an allowlist.
- Bearer comparisons are plain string equality (`packages/http/src/main.ts`
  ai-usage ingest, and the same shape in the lane components). Timing-safe
  comparison is cheap; the practical risk here is low.

## 7a. Why this host has periods where everything runs ten times slower

**Open, and deliberately not chased.** On 2026-08-22 the same commit measured
`bun test packages/` at 24 s and at 262 s within the hour, and
`test/fe-render.test.ts` — 30 s in the morning — took 1154 s in the afternoon
with its timeout raised. Between them, `bun test packages/http/src/db-store.test.ts`
ran 22 tests in 1.07 s with a load average of 2.7, so the machine is not slow
*as a rule*; it has periods.

What it costs is measurement. A browser scenario that exceeds bun's five-second
default has its async work cut, the playwright pipe goes with it, and **every
scenario after it fails with `browser has been closed`** — a hundred failures
naming nothing, from one slow navigation. That is a red suite produced by a
machine and indistinguishable, from the report, from one produced by a defect.

`test/fe-render.test.ts` raises its timeout to twenty seconds so a red there
means a defect (`agent-mesh-local-pm`, 2026-08-22). That is a decision about
what to call a failure, not an answer to this question. The question — thermal
throttling, a background process, the sleep/wake cycle the machine went through
at 12:45, or something else — is left here rather than pursued, because the
time it would take is time the work costs more than the answer is worth today.

**What would settle it** is a measurement nobody has taken yet: the same suite,
same commit, on an otherwise idle host, sampled across a day with `powermetrics`
or equivalent beside it. Written down so the next person finds a method rather
than a mood.

## 8. Where the http admin surface's refusal codes are named

Eleven codes leave this repository in REST bodies and are named nowhere in
`agent-mesh-contracts`:

| code | route | since |
|---|---|---|
| `TYPE_EXISTS` | `POST /api/v1/admin/agent-types` | § 10.3 |
| `TYPE_IN_USE` | `DELETE /api/v1/admin/agent-types/:type` | § 10.3 |
| `AUDIT_AGENTS_UNAVAILABLE` | `GET /api/v1/admin/chat-audits/agents` | D-736 |
| `AUDIT_READ_UNRECORDABLE` | any content read whose record failed | § 11.0.1 |
| `LAST_GRANTOR` | `DELETE /api/v1/admin/grants` | § 11.3 |
| `PROTECTED_ACCOUNT` | `DELETE` the same | D-746 |
| `PLATFORM_ADMIN_ONLY` | the four `/api/v1/admin/tenants` routes | T-026 |
| `TENANT_EXISTS` | `POST /api/v1/admin/tenants` | T-026 |
| `DEFAULT_TENANT` | `DELETE /api/v1/admin/tenants/{id}` | T-026 |
| `TENANT_NOT_YOURS` | `POST /api/v1/admin/users` | T-026 |
| `NO_SUCH_TENANT` | the same | T-026 |

They are not JSON-RPC `error.data.code`. Nothing on the mesh wire carries
them, so a client pinning a contracts tag never sees one — but an operator
console switches on them, and it is a different codebase from this one.
`PROVISION_ERROR` (§ 10.1) is the same shape and already has its own constant
in contracts, which is the precedent pointing at a third one.

**How it stayed invisible is the more useful half.** `test/versioning.test.ts`
has checked "every code the services emit has a name in contracts" for as long
as the codes have existed, and it was green over all four: it grepped
`code: "X"` and `main.ts` writes `code: 'X'`. The rule was right and the reader
could only see half the file. It surfaced because a refactor moved two of them
into a file that happens to use double quotes — luck, not process. The scan
reads both quote styles now, and the eleven are carved out by name in
`HTTP_ADMIN_ONLY` so a twelfth cannot join them quietly.

**A fifth joined anyway, and the carve-out is not what let it.** `LAST_GRANTOR`
reached `main` with `test/versioning.test.ts` red: the commit that added it ran
`bun test packages/` and not `bun test test/`, so the check that exists for
exactly this caught it and nobody read the answer. It surfaced when D-746 added
`PROTECTED_ACCOUNT` beside it and the suite was run in full. The list is doing
its job; the run is the part that has to happen.

**Settled for now (D-740): no tag.** Measured on 2026-08-21, no repository
reads any of the four as a string — `packages/platform-web` references none of
them, calls neither route, and its `ApiError` keeps `message`, `status` and
`capability` while discarding `errorData.code`, so the console cannot branch on
one even if it wanted to. The client classifies by status. Cutting a tag for a
vocabulary nobody reads buys the ceremony and the re-pin and nothing else.

**Promote when somebody reads one.** The moment any repository branches on one
of these code *strings* — the likeliest trigger being the front end teaching
`ApiError` to keep `code` — they follow `PROVISION_ERROR` into contracts under
their own constant and a tag gets cut. Written here so the next person finds a
condition rather than an open question.

**Close to that condition, and worth stating precisely (2026-08-22).** D-746
gave the grants matrix a second string vocabulary — `immutable_reason`, values
`last_grantor` and `protected_account` — and the console on
`origin/fe-wa-wb-honesty` asserts `data-immutable-reason` is exactly
`"last_grantor"`. That is a second repository depending on a spelling this one
chooses, which is the shape D-740 said would trigger promotion. It is not yet
the trigger as written: `immutable_reason` is a *field of a `200` body*, not an
`error.data.code`, and the console still discards `code` on the `409`. Two
vocabularies with one question between them; whether they go into contracts
together, separately, or not at all is the PM's, since a tag moves three
repositories.

**Measured again once the console landed (2026-08-22, `863f23a`).** The trigger
D-740 named — the front end teaching `ApiError` to keep `code` — still has not
happened: `api/client.ts` reads `error`, `message`, `status` and `capability`
off a refusal and drops `code`, so no console branches on one of the eleven.

What the merge did add is a *third* string vocabulary this repository chooses
and another one now depends on, and both arrive the same way `immutable_reason`
did — as fields of a `200`, not as a refusal code:

- `action`, on `DELETE /api/v1/admin/tenants/{id}`: the console types it as
  `"deleted" | "already-deleted" | "not-found"`, which is this repository's
  spelling of three outcomes.
- the tenant id `"default"`: the screen disables the delete control by
  comparing against it, because the server answers `409 DEFAULT_TENANT` and a
  console that offers the button teaches an operator the platform is broken.
  `DEFAULT_TENANT` — the code — is still not read; the *id* is.

So the count of vocabularies crossing the boundary is three and the count of
refusal codes anybody reads is nought, which is the same answer D-740 gave with
more places for it to change. The material is written up for the PM rather than
decided here.

## 9. What the audit console's search box means — ~~closed~~

**Settled (D-743): a literal substring.** `search` was built as
`content LIKE '%' || ? || '%'` with the operator's text bound but `LIKE`'s own
wildcards left unescaped, so `%` matched any run and `_` any single character —
over-matching rather than injection, and an operator searching for `50%` was
handed every message in the audit.

Three readings were open: substring, an advertised pattern syntax, or full text
over an FTS index. The console's owner (fe-codex) decided substring on
2026-08-22 and the PM adopted it as D-743, on the grounds that `%` and `_`
occur naturally in message bodies and an audit screen is the wrong place to
fail in the direction of *more content than was asked for* — the capability
gating this route exists to keep it narrow.

Implemented in `packages/http/src/chat-audits.ts` (`likeContains`, with
`ESCAPE '\\'`), pinned by `chat-audits.test.ts` and by the registered mutation
`chat-audits-search-is-a-pattern-again`. Full text stays a separate feature and
a migration; nothing here forecloses it.

---

## What is still live

Two conditions, and no open question.

**Item 6, the contract half.** Per-message signatures landed (SPEC § 8.1, built),
so the reasoning this note used to carry — *wait, because the signature work
will replace whatever mechanism you pick* — has expired. What survives is what
it always said would: **what SPEC § 4.5 should require of a conformant lane.**
The lane components are in another repository; the contract is here, and this
is the only thing on this page nobody has ruled on.

**Item 8, the promotion condition.** The four http-admin refusal codes stay out
of `agent-mesh-contracts` while nobody reads them as strings. The moment any
repository branches on one — most likely the front end teaching `ApiError` to
keep `code` — they follow `PROVISION_ERROR` into contracts and a tag is cut.

Item 5's retention entanglement went with the ruling: access is now decided by
participation rather than by an unguessable id, so an unbounded blob write is a
capacity question and not an access one. Size and retention caps still do not
exist, and that belongs with [`deferred.md`](deferred.md) rather than here.

# Open questions — identity and authentication

Status: **items 1-4 are now decided.** Their design lives in
[`decisions/identity-and-authentication.md`](decisions/identity-and-authentication.md).
What follows are the items still open.

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

The remaining items below are independent of that work and can move at any
time. Nothing here should be treated as agreed.

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

## 8. Where the http admin surface's refusal codes are named

Four codes leave this repository in REST bodies and are named nowhere in
`agent-mesh-contracts`:

| code | route | since |
|---|---|---|
| `TYPE_EXISTS` | `POST /api/v1/admin/agent-types` | § 10.3 |
| `TYPE_IN_USE` | `DELETE /api/v1/admin/agent-types/:type` | § 10.3 |
| `AUDIT_AGENTS_UNAVAILABLE` | `GET /api/v1/admin/chat-audits/agents` | D-736 |
| `AUDIT_READ_UNRECORDABLE` | any content read whose record failed | § 11.0.1 |

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
reads both quote styles now, and the four are carved out by name in
`HTTP_ADMIN_ONLY` so a fifth cannot join them quietly.

Deciding this means cutting an `agent-mesh-contracts` tag, which is not this
repository's to do alone.

---

## Sequencing note

Item 6 partly resolves itself: once per-message signatures land, a lane
authenticates itself and the shared-token shape stops being the only option.
Deciding it now would produce a mechanism the signature work replaces, so it is
worth leaving until then — the question that survives either way is what
SPEC § 4.5 should require of a conformant lane, and that stays here even after
the lane components left the repository.

Items 5 and 7 depend on nothing and can move whenever someone wants them.

Item 5 is also entangled with retention: an unauthenticated blob write is only
bounded by whatever size and retention caps exist, and there are none yet.

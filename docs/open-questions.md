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

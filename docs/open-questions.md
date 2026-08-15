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
signatures. The teardown became a soft delete, which is what the signature
decision requires: deleting a key makes every past signature unverifiable.

The remaining items below are independent of that work and can move at any
time. Nothing here should be treated as agreed.

---

## 5. Attachment download is unauthenticated

`packages/shared/http/src/main.ts:4817` — `GET /api/v1/attachments/:id` serves
bytes to anyone who can reach the port. SPEC § 15.3 states this explicitly and
tells clients to tolerate a future `401`.

Attachment ids are sha256 digests, so they are unguessable in practice — this
is capability-style access, not open listing. Whether that is sufficient
depends on whether attachment ids ever leak into logs or third-party channels.

Decisions needed:

- Keep capability-by-digest, or require a mesh bearer token?
- If tokens: lane VMs fetch on demand (§ 15.4) and would each need one.

## 6. One token guards the whole lane HTTP surface

`packages/runtime-adapters/codex/src/http-server.ts:119` — a single
`isAuthorized` gate covers every path on the adapter's HTTP server. Since the
mesh tools merge, that includes both `/ingress/channel` and `/actions/mesh`.

The token is `CODEX_ADAPTER_HTTP_TOKEN`, which the Discord driver holds as
`CHANNEL_INGRESS_TOKEN` (SPEC § 4.5). So the channel driver's ingress
credential now also authorises mesh sends and reminder writes — a wider grant
than the driver needs.

Mitigating: the server binds `127.0.0.1` only, so this is an intra-host
boundary, not a network one.

Decisions needed:

- Split the surfaces (separate token for `/actions/mesh`), scope per-path, or
  accept that everything inside a lane is one trust domain?
- The same single-gate shape exists on the driver side
  (`packages/channel-drivers/discord/src/http.ts:33`) — should both change
  together?

Note: `runtime-adapters/` is slated to leave this repository, so the fix may
land in the lane repository rather than here. The *contract* question — what
SPEC § 4.5 requires of a conformant lane — stays here.

## 7. HTTP server hardening

Smaller items, same theme:

- `packages/shared/http/src/auth.ts:11` — `JWT_SECRET` falls back to
  `'lab-fallback-secret-change-me'`. An unset secret should fail startup, not
  silently sign tokens with a published constant.
- `packages/shared/http/src/main.ts:519` — `app.use('/*', cors())` allows every
  origin, marked "Phase 1". Combined with cookie-borne JWT sessions this
  deserves an allowlist.
- Bearer comparisons are plain string equality
  (`packages/runtime-adapters/codex/src/http-server.ts:19`,
  `packages/channel-drivers/discord/src/http.ts:17`,
  `packages/shared/http/src/main.ts` ai-usage ingest). Timing-safe comparison
  is cheap; the practical risk here is low.

---

## Sequencing note

Item 6 partly resolves itself: once per-message signatures land, a lane
authenticates itself and the shared-token shape stops being the only option.
Deciding it now would produce a mechanism the signature work replaces, so it is
worth leaving until then — the question that survives either way is what
SPEC § 4.5 should require of a conformant lane, and that stays here even after
`runtime-adapters/` leaves the repository.

Items 5 and 7 depend on nothing and can move whenever someone wants them.

Item 5 is also entangled with retention: an unauthenticated blob write is only
bounded by whatever size and retention caps exist, and there are none yet.

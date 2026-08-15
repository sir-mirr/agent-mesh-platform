# Open questions — identity and authentication

Status: **unresolved.** This file records the identity and authentication
decisions the project has not made yet. It is not a fix list and nothing here
should be treated as agreed. Several entries are deliberate v0.1 choices that
only become problems under a different trust model.

SPEC § 14.2 states the v0.1 position plainly: hub auth is *identity-only*, over
plain `ws://`, on a trust-bounded internal network. Every item below is
consistent with that position. The open question is what replaces it — and each
answer has a different blast radius across the wire contract, the deployment
profile, and out-of-tree lane implementations.

---

## 1. Connecting to the hub proves nothing

`mesh.connect` takes an identity string and no credential. The hub checks the
identity is pre-registered (`agents` row exists) and then trusts the socket.

Anything that can reach `AGENT_MESH_HUB_PORT` can connect as any provisioned
identity. The `DUPLICATE_IDENTITY` guard means it cannot displace a live owner,
but it can claim any identity that is currently offline.

Decisions needed:

- Per-identity bearer token at `mesh.connect`, or mTLS, or neither?
- If tokens: where do they live, who issues them, how are they rotated? The
  identity provisioning endpoint (§ 10.1) is the natural issuer, but it is
  itself unauthenticated today (see item 4).
- Does the wire contract change (new `mesh.connect` param) or does auth move to
  the WebSocket upgrade (`Authorization` header)? The former is a SPEC § 8.1
  change visible to every lane; the latter is transport-level and cheaper for
  existing clients.

## 2. `proxy_for` is unenforced

`packages/shared/hub/src/main.ts:336` — any connected socket may pass
`proxy_for: [...]` and the hub writes each entry into `proxyMap`, overwriting
whatever was there. There is no check that the connecting identity is entitled
to speak for the proxied ones.

Consequence: a connected identity can claim another identity's inbound route
and receive envelopes addressed to it.

`packages/agent-mesh-core/src/ownership.ts` already models exactly this —
`OwnershipPolicy`, `assertProxyRegistration`, `resolveEffectiveSender` — and
the hub does not import it. The contract exists; the enforcement point was
never wired up.

Decisions needed:

- What is the source of truth for "identity A may proxy identity B"? A column
  on `agents`, a separate table, or configuration outside the DB?
- Who writes it — `POST /api/v1/agents`, or a new endpoint?
- What happens to existing deployments that rely on unchecked `proxy_for` when
  enforcement turns on? Codex lanes use `CODEX_PROXY_FOR` today.

## 3. `mesh.send` accepts a caller-supplied `from`

`packages/shared/hub/src/main.ts:422` — `params.from` overrides the socket's
registered identity with no validation. SPEC § 8.2 documents this as intended,
for proxy senders such as the HTTP server forwarding on a user's behalf.

It is the same hole as item 2 from the sending side: any connected socket can
originate an envelope as any identity.

Decisions needed:

- Restrict `from` to the socket's identity plus its *validated* `proxy_for`
  set (this is what `resolveEffectiveSender` is for), or keep it open and
  authenticate at the edge instead?
- The HTTP server is the main legitimate user of the override. Does it get a
  privileged service identity, or a different mechanism entirely?

## 4. Hub REST control plane is unauthenticated

`packages/shared/hub/src/main.ts:1002,1012,1022` — `POST /api/agents`,
`POST /api/v1/agents`, and `DELETE /api/agents/{identity}` have no auth.

`DELETE` is the sharp one: it removes the identity row *and every message row
referencing it*, in one transaction (SPEC § 9.3). Unauthenticated destructive
history deletion is fine behind a trusted bridge and not fine anywhere else.

SPEC § 10.1 already says public-internet deployments MUST gate these routes
before exposing them. It does not say how.

Decisions needed:

- One shared admin token, or per-caller credentials?
- Is the read/write split worth it (provisioning is idempotent and low-risk;
  teardown is not)?
- Does the bootstrap script (`ops/bin/bootstrap-hub-service-identities.sh`),
  which POSTs over loopback at hub start, get an exemption or a credential?

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

Items 1–4 are one design, not four fixes. Identity authentication (1), proxy
entitlement (2), sender validation (3), and provisioning auth (4) share a
single question: **what is the authority that says an identity is who it
claims to be, and where is it stored?** Answering that once settles all four.
Answering them separately will produce four mechanisms that do not compose.

Items 5–7 are independent and can move at any time.

Any change to items 1–3 alters the § 8 wire contract and therefore breaks
out-of-tree lanes. That argues for settling them before 1.0 freezes the wire
format (SPEC § 13), and for doing them in one breaking revision rather than
several.

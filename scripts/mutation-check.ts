#!/usr/bin/env bun
/**
 * Break each guarded behaviour on purpose and check the suite notices.
 *
 *   bun run mutation-check              # every mutation
 *   bun run mutation-check -- egress    # ids containing "egress"
 *
 * ## Why this is a script and not a note in a document
 *
 * "This was mutation-tested" is a claim about work that happened once, and a
 * reader has no way to check it. Worse, the claim survives the guard: a
 * expectation deleted six months from now leaves the sentence in the commit
 * message exactly as true-sounding as it was.
 *
 * Most entries below are a defect that reached this repository, and the test
 * named beside it is what now stands between that defect and a release. Running
 * this re-establishes both facts in about two minutes.
 *
 * **The rest never were defects**, and are marked `swept: true`. They are
 * invariants — signature freshness, an entitlement, a single-use code — checked
 * by hand once, found guarded, and then existing only in a transcript. A guard
 * verified once and never again is the state this whole file was written
 * against, so "it was fine when I looked" is not a reason to leave one out. The
 * distinction is kept because the two carry different information: a defect
 * entry says *this broke*, a swept entry says *this was never allowed to*.
 *
 * ## Refusals, and what each is for
 *
 * The refusals here are not about the tool failing to answer. They are about
 * the tool answering **wrongly**, which is worse, because a wrong answer here
 * gets acted on.
 *
 * **A dirty tree aborts.** Restoring is `git checkout --`, which is only safe
 * when the mutation is the sole difference. This is also the caveat that makes
 * `git checkout` acceptable at all: uncommitted work has been destroyed that way
 * in this repository before.
 *
 * **A pattern that matches nothing is a failure, not a skip.** The unmutated
 * source then runs, the suite passes, and it reads as "the guard did not catch
 * it" — a false finding rather than a missed one. That happened here with a
 * `perl` edit whose pattern had drifted.
 *
 * **A dirty tree afterwards is a failure.** The harness that found the defects
 * in `docs/decisions/checks-that-check-nothing.md` produced one itself: it kept
 * a single backup slot, so applying twice before restoring left a guard deleted
 * in a file that then reported four passes. There is no backup slot here — git
 * holds the original, which is the same reasoning that removed the hand-written
 * ignore list from `test/typecheck-scope.test.ts`. A copy is a second thing that
 * can be wrong.
 */

import { $ } from "bun";

import { holdTree } from "./tree-lock";

interface Mutation {
  id: string;
  /** The defect being reintroduced, in the words of the commit that fixed it. */
  defect: string;
  /**
   * True when this was never a defect here — an invariant swept by hand once and
   * entered so the sweep does not have to be trusted twice. See the header.
   */
  swept?: true;
  file: string;
  from: string;
  to: string;
  /** Test file to run. */
  suite: string;
  /**
   * Every substring the failure must contain.
   *
   * **A scenario id alone is too weak.** It appears in the test name whether the
   * assertion caught the defect or the mesh refused to start, so a run that
   * never reached the check is recorded as though it had. `client-claude` hit
   * exactly that: their lease entry was `caught` while the scenario had not run
   * once, because the harness applied a lease the scenario never asked for and
   * the runner died before reporting (mail #229).
   *
   * So each entry names the *check* as well: not "something failed in
   * E2E-CAP-001" but "the assertion on `body.mailbox.receive_lease_seconds`
   * failed there".
   *
   * **Step numbers are deliberately excluded.** They shift the moment a step is
   * inserted, which happened to E2E-AUDIT-001 one tag ago — an expectation
   * pinned to `step 2` would then fail for a reason having nothing to do with
   * the guard it protects.
   */
  expect: string[];
  /**
   * Self-check entries only: the **reason** this must be reported as a failure.
   *
   * Without it the inversion below passes for the wrong reason. Drift the
   * baseline so neither pattern matches and both entries are refused; refusals
   * count as failures; "2/2 correctly reported as failures" is printed while the
   * branch under test never ran. Measured, not imagined.
   */
  expectFailure?: FailureKind;
}

/** Why an entry was not counted as caught. */
type FailureKind = "no-match" | "not-caught" | "inconclusive";

const MUTATIONS: Mutation[] = [
  {
    id: "egress-deny",
    defect: "A group with no egress rule could send anyway (§ 12).",
    file: "packages/hub/src/rpc/send.ts",
    from: "if (!egress.ok) {",
    to: "if (false) {",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-EGRESS-001", "(send): error code"],
  },
  {
    id: "ack-settle",
    defect: "An acknowledgement reported success without settling the batch (§ 8.10.1).",
    // Moved with the code it guards: settling a batch is store-and-forward and
    // now lives in the mailbox package. The manifest refused rather than
    // reporting caught, which is the one thing a stale entry must do.
    file: "packages/mailbox/src/receive.ts",
    from: "const settled = stmt.ackMessage.run(messageId, identity);",
    to: "const settled = { changes: 1 };",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-RECEIVE-002", "(receive): message count"],
  },
  {
    id: "key-gate",
    defect: "An unapproved key could open a lane (§ 10.2).",
    file: "packages/hub/src/signature.ts",
    from: 'if (outcome.reason === "no-approved-key") {',
    to: "if (false) {",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-KEY-001", "(connect): error code"],
  },
  {
    id: "connect-replay",
    defect:
      "Connecting stopped delivering what had accumulated while the identity was away (§ 8.1). A lane that only listens — client-claude's does, and never calls mesh.receive — would then sit with a full mailbox and no symptom, because nothing it does would tell it.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "  deliverPending(identity, ws);",
    to: "  void identity;",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-CONNECT-001", "messages pushed on connect"],
  },
  {
    id: "lease-advert",
    defect:
      "`/api/v1/capabilities` advertised the default receive lease while the hub used a configured one, so clients sized their retry loop on a number nobody honoured.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "        receive_lease_seconds: LEASE_SECONDS,",
    to: "        receive_lease_seconds: MAILBOX_CAPABILITY_DEFAULTS.receive_lease_seconds,",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-CAP-001", "body.mailbox.receive_lease_seconds"],
  },
  {
    id: "restart-response",
    defect:
      "Re-presenting an approved key answered `pending`. The row was untouched, so the lane worked — and a lane that reads the response waits for an operator forever.",
    file: "packages/store/src/keys.ts",
    from: "    return { fingerprint, status: existing.status, created: false };",
    to: '    return { fingerprint, status: "pending", created: false };',
    suite: "test/scenarios.test.ts",
    expect: ["E2E-KEY-003", "body.key.status"],
  },
  {
    id: "recall-handover",
    defect: "Recall succeeded after the recipient had taken the message (§ 8.10.1).",
    file: "packages/hub/src/rest/mailbox.ts",
    from: 'if (outcome === "already-delivered") {',
    to: "if (false) {",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-RECALL-001", "(http) status"],
  },
  {
    id: "readback-hides",
    defect: "The key read-back omitted pending keys, which is the only state worth reading it for.",
    file: "packages/hub/src/rest/agents.ts",
    from: "    keys: rows.map((k) => ({",
    to: '    keys: rows.filter((k: any) => k.status !== "pending").map((k) => ({',
    suite: "test/scenarios.test.ts",
    expect: ["E2E-KEY-004", "body.keys.0.fingerprint"],
  },
  {
    id: "event-type-filter",
    defect:
      "The audit query ignored `event_type`. E2E-AUDIT-001 caught that only while another event sorted first — measured on a solo mesh, its own read is the oldest row and the positive assertion passes against a route filtering nothing. The scenario's second query asks for an event type that cannot exist, which fails regardless of order.",
    file: "packages/http/src/audit-query.ts",
    from: "  if (q.event_type) {",
    to: "  if (false) {",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-AUDIT-001", "body.events.0.event_type"],
  },
  {
    id: "content-read-trace",
    defect: "A content read left no record (§ 11.0.1).",
    file: "packages/http/src/main.ts",
    from: "    recordContentRead({ actor, target, query })",
    to: "    void 0",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-AUDIT-001", "body.events.0.event_type"],
  },
  {
    id: "type-change-event",
    defect:
      "Changing an identity's type recorded nothing, so the trail said it always was what it now is (§ 8.9.5).",
    // **What this depends on**, written down because it came back not caught once
    // and never again. The query filters on identity *and* event_type and reads
    // row zero, so with the event unwritten no row can match — whatever else the
    // mesh holds, in whatever order. Sort order is not a dependency here, unlike
    // the audit filter beside it.
    //
    // That exonerates the scenario by construction and points the next
    // occurrence at this tool or the run around it. `inconclusive` exists for
    // the most likely of those.
    file: "packages/hub/src/rest/agents.ts",
    from: '    recordIdentityEvent("mesh.identity.type_changed", {',
    to: '    if (false) recordIdentityEvent("mesh.identity.type_changed", {',
    suite: "test/scenarios.test.ts",
    expect: ["E2E-TYPE-001", "body.events.0.event_type"],
  },
  {
    id: "record-source",
    defect: "The observed source was never recorded, which the rest of § 8.11 rests on.",
    file: "packages/store/src/sources.ts",
    from: "export function recordSource(db: Database, identity: string, observed: string | null): void {",
    to: "export function recordSource(db: Database, identity: string, observed: string | null): void {\n  if (true) return;",
    suite: "test/scenarios.test.ts",
    expect: ["E2E-SOURCE-001", "body.sources.0.identity"],
  },
  {
    id: "provision-rate-limit",
    defect:
      "The unauthenticated provisioning route stopped consulting its limiter (§ 14). Found by sweeping fourteen core invariants: the bucket arithmetic was covered and its use by the route was not, so both limits could be deleted without a single test noticing.",
    file: "packages/hub/src/main.ts",
    from: 'const verdict = PROVISION_LIMIT.take(observed ?? "unknown-source");',
    to: "const verdict = { ok: true, retryAfter: 0, remaining: 1 };",
    suite: "test/ratelimit.test.ts",
    expect: ["provisioning route", "every request was served"],
  },
  {
    id: "signed-rate-limit",
    defect: "The signed routes stopped consulting their limiter (§ 14).",
    file: "packages/hub/src/rest/signed.ts",
    from: "const budget = SIGNED_LIMIT.take(identity);",
    to: "const budget = { ok: true, retryAfter: 0, remaining: 1 };",
    suite: "test/ratelimit.test.ts",
    expect: ["signed routes", "every signed request was served"],
  },
  {
    id: "verb-unimplemented",
    defect:
      "A scenario verb the runner did not handle fell out of the `switch`, did nothing, and reported green (§ 17.3).",
    file: "test/scenarios.test.ts",
    from: '    case "sleep":\n      await Bun.sleep(step.seconds * 1000);\n      return;\n',
    to: "",
    suite: "test/scenarios.test.ts",
    expect: ["verb not implemented"],
  },
  {
    id: "reply-channel",
    defect:
      "A reply to mail was pushed over the mesh because the recipient happened to be holding a socket (§ 8.2a). That puts half a thread on a socket a correspondent was briefly holding and leaves them to find the rest; one end present is exactly the case the mailbox exists for.",
    file: "packages/mailbox/src/channel.ts",
    from: "  return input.recipientLive && input.senderLive ? \"mesh\" : \"mailbox\";",
    to: '  return input.recipientLive ? "mesh" : "mailbox";',
    suite: "packages/mailbox/",
    expect: ["only the recipient is live", "mailbox"],
  },
  {
    id: "reply-channel-scenario",
    defect:
      "The same defect as `reply-channel`, but stated where both implementations check it (§ 8.2a, § 17.3). It was held by unit tests here alone until the scenario vocabulary could express one end present and one absent.",
    file: "packages/mailbox/src/channel.ts",
    from: '  return input.recipientLive && input.senderLive ? "mesh" : "mailbox";',
    to: '  return input.recipientLive ? "mesh" : "mailbox";',
    suite: "test/scenarios.test.ts",
    // Named for what the arrangement actually asserts. The first version wanted
    // "message count", which is the step *after* the one that matters — and the
    // scenario itself was arranged so nothing failed at all.
    expect: ["E2E-REPLY-001", "messages pushed since the last check"],
  },
  {
    id: "reply-channel-overreach",
    defect:
      "The both-live condition was applied to every send, not only to replies. A mailbox participant sending to an agent holding a socket stopped being delivered — behaviour the socketless transport was built to have and nobody asked to change. The first version of the rule did this, and two tests said so immediately.",
    file: "packages/mailbox/src/channel.ts",
    from: '  if (!isReply) return input.recipientLive ? "mesh" : "mailbox";',
    to: '  if (!isReply) return input.recipientLive && input.senderLive ? "mesh" : "mailbox";',
    suite: "packages/mailbox/",
    expect: ["answers nothing", "mesh"],
  },
  {
    id: "auth-local-enumeration",
    defect:
      "Sign-in distinguished an unknown username from a wrong password, which turns the route into a way to enumerate accounts. The JSON shape made it easy to do by accident, because a JSON caller wants to be told what went wrong and two of the three answers are safe to give.",
    file: "packages/http/src/main.ts",
    from: "    return fail(401, 'invalid username or password', '/?error=invalid')",
    to: "    return fail(401, verifyLocalUser ? `no such user: ${username}` : 'bad password', '/?error=invalid')",
    suite: "test/auth-local-json.test.ts",
    expect: ["not told which of the two"],
  },
  {
    id: "key-proposal-stream",
    defect:
      "An agent asking to join produced no notification. Registration starts on the agent's side and stops until a human compares a fingerprint, and the only way to learn one was waiting was to poll from a screen somebody had already opened — nobody looking meant nobody knew.",
    file: "packages/http/src/key-proposals.ts",
    from: "        if (reported.has(p.fingerprint)) continue",
    to: "        if (true) continue",
    suite: "test/key-proposals.test.ts",
    expect: ["nothing was pushed"],
  },
  {
    id: "tenant-attribution",
    defect:
      "Traffic was attributed to the sender's tenant instead of the recipient's (§ 11.4). A sender rule leaves traffic that arrived in a tenant absent from that tenant's view — 'nothing came in' when something did, which is the reading an operator is actually misled by.",
    file: "packages/hub/src/rpc/send.ts",
    from: "      tenant: tenantOf(agentsDb, to),",
    to: "      tenant: tenantOf(agentsDb, effectiveSender),",
    suite: "test/tenant-stats.test.ts",
    expect: ["cross-tenant message counts once"],
  },
  {
    id: "tenant-stats-via",
    defect:
      "The transport was recorded as `mesh` whatever route a message arrived on (§ 11.4), so mailbox and mesh traffic became indistinguishable in the statistics. The test asserted `via_mailbox: 0` for a long time without a single message having taken that route — a zero nobody can make non-zero says nothing about a counter.",
    file: "packages/mailbox/src/accept.ts",
    from: "    stmt.insertStats.run(opts.id, opts.tenant, opts.to, opts.from, opts.via);",
    to: '    stmt.insertStats.run(opts.id, opts.tenant, opts.to, opts.from, "mesh");',
    suite: "test/tenant-stats.test.ts",
    expect: ["a mailbox send was not recorded as one"],
  },
  {
    id: "tenant-stats-not-atomic",
    defect:
      "The statistics row was written outside the message transaction (§ 11.4). A count that commits when the message did not is a count of something that did not happen.",
    file: "packages/mailbox/src/accept.ts",
    from: "    stmt.insertStats.run(opts.id, opts.tenant, opts.to, opts.from, opts.via);",
    to: "",
    suite: "test/tenant-stats.test.ts",
    expect: ["recipient's tenant"],
  },
  {
    id: "grant-author",
    defect:
      "A grant recorded an author the caller stated rather than the session that made it (§ 11). A grant whose author is self-reported records whatever the author wanted recorded, which makes the trail agree with anybody who writes to it.",
    file: "packages/http/src/main.ts",
    from: "  grants.grant(agentsDb(), { subject, capability, scope, grantedBy: actor })",
    to: "  grants.grant(agentsDb(), { subject, capability, scope, grantedBy: body?.grantedBy ?? actor })",
    suite: "test/grants-routes.test.ts",
    // Named for the test that actually catches it. The first version pointed at
    // the neighbouring round-trip test, which passes under this mutation — the
    // guard bit correctly and the manifest reported it uncaught, which is the
    // wrong finding, about the wrong thing, in the tool built to avoid exactly
    // that.
    expect: ["the caller's claim was recorded as the author"],
  },
  {
    id: "capabilities-provenance",
    defect:
      "A running instance stopped saying which checkout it is (§ 7.1). Two investigations days apart began with a 404 and ended at the same cause — a long-running hub on a branch ninety-three commits behind — and neither could be diagnosed from outside without reasoning backwards from missing routes.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "      platform: PROVENANCE,",
    to: "",
    suite: "test/provenance.test.ts",
    expect: ["says which commit it is"],
  },
  {
    id: "mailbox-boundary",
    defect:
      "The mailbox imported the hub. The arrangement this package replaced reached hub presence, the hub's database handle and three RPC handlers — faking a WebSocket so the handlers would accept the caller — and every one of those imports was reasonable on the day it was added. Nothing forbade them, which is the only reason they were there.",
    file: "packages/mailbox/src/receive.ts",
    from: 'import type { Database, Statement } from "bun:sqlite";',
    to: 'import type { Database, Statement } from "bun:sqlite";\nimport { onlineAgents } from "../../hub/src/presence";',
    suite: "test/mailbox-boundary.test.ts",
    expect: ["must not know the hub exists", "receive.ts"],
  },
  {
    id: "covers-always-true",
    defect: "The coverage predicate could become a constant, passing for any repository.",
    file: "test/typecheck-scope.test.ts",
    from: "const covers = (prefixes: string[], file: string): boolean =>\n  prefixes.some((p) => file === p || file.startsWith(`${p}/`));",
    to: "const covers = (prefixes: string[], file: string): boolean => true || !!prefixes || !!file;",
    suite: "test/typecheck-scope.test.ts",
    expect: ["capable of failing"],
  },
  {
    id: "root-anchored",
    defect: "A project anchored at the repository root makes every file vacuously covered.",
    file: "test/tsconfig.json",
    from: '    "**/*.ts"',
    to: '    "../**/*.ts"',
    suite: "test/typecheck-scope.test.ts",
    expect: ["vacuously covered"],
  },
  {
    id: "empty-enumeration",
    defect:
      "The other way a coverage check collapses: with no files enumerated, nothing can be reported as uncovered.",
    file: "test/typecheck-scope.test.ts",
    from: "function everyTsFile(): string[] {",
    to: "function everyTsFile(): string[] {\n  if (true) return [];",
    suite: "test/typecheck-scope.test.ts",
    expect: ["no source at all"],
  },
  {
    id: "narrow-pathspec",
    defect: "Asking git a narrower question hides whole directories from the check.",
    file: "test/typecheck-scope.test.ts",
    from: '"--exclude-standard", "*.ts"',
    to: '"--exclude-standard", "packages/*.ts"',
    suite: "test/typecheck-scope.test.ts",
    expect: ["actually finds this repository"],
  },
  {
    id: "git-fails-loudly",
    defect: "A failed enumeration must name its cause rather than return nothing.",
    file: "test/typecheck-scope.test.ts",
    from: '"--exclude-standard", "*.ts"],',
    to: '"--not-a-flag"],',
    suite: "test/typecheck-scope.test.ts",
    expect: ["cannot enumerate"],
  },
  {
    id: "scope-project-removed",
    defect:
      "`scripts/` sat outside the typecheck since it existed, so every `typecheck 0` reported while editing the harness excluded the harness.",
    file: "tsconfig.base.json",
    from: '    {\n      "path": "./scripts/tsconfig.json"\n    },\n',
    to: "",
    suite: "test/typecheck-scope.test.ts",
    expect: ["scripts/e2e-harness.ts"],
  },

  {
    id: "capability-not-role",
    defect:
      "An admin route gated on `payload.role === 'admin'` instead of a capability (\u00a7 11). Nothing noticed, because both models answer 401 to a stranger and 403 to a non-admin — every existing gate test asks exactly those two questions. Found by mutating the route and watching all 601 tests stay green.",
    file: "packages/http/src/main.ts",
    from: "  const actor = await requireCapability(c, CAPABILITY.KEY_APPROVE)\n  if (typeof actor !== 'string') return actor",
    to: "  const payload = await extractJwt(c)\n  if (!payload) return c.json({ error: 'Unauthorized' }, 401)\n  if (payload.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)\n  const actor = payload.github_login as string",
    suite: "test/auth-sweep.test.ts",
    // The caller that separates the two models: a token whose `role` is admin
    // and whose subject holds no grant. Role-checking lets it in.
    expect: ["a session claiming the admin role but holding no grant is refused"],
  },

  {
    id: "tsx-enumeration",
    defect:
      "The typecheck-scope enumeration asked git for `*.ts` and not `*.tsx`. It reported everything covered because this branch has no `.tsx` at all — and the front-end package waiting on a branch is 44 `.tsx` to 16 `.ts`, so the day it merged three quarters of it would land outside the check written to guarantee nothing lands outside the check.",
    file: "test/typecheck-scope.test.ts",
    from: '"--exclude-standard", "*.ts", "*.tsx"],',
    to: '"--exclude-standard", "*.ts"],',
    suite: "test/typecheck-scope.test.ts",
    // A probe file, because a count would pass at zero — which is the state
    // being guarded against.
    expect: ["the walk asks for .tsx as well as .ts"],
  },

  {
    id: "retry-after-floor",
    defect:
      "A refused caller could be told to retry in 0 seconds, which it does immediately, forever — the tight loop the limiter exists to stop. The guard against it (\u00a7 14) was unchecked: the only test used a whole-token deficit, where ceil, floor and the `Math.max(1, ...)` floor all agree on 10.",
    file: "packages/hub/src/ratelimit.ts",
    from: "Math.max(1, Math.ceil(deficit / this.config.refillPerSecond))",
    to: "Math.floor(deficit / this.config.refillPerSecond)",
    suite: "packages/hub/src/ratelimit.test.ts",
    // A partial refill, where the roundings stop agreeing. Removing the
    // `Math.max` alone is equivalent under `ceil` — a positive deficit never
    // rounds to zero — so the entry mutates the rounding with it.
    expect: ["nor when the bucket is a fraction of a token short"],
  },

  // ---------------------------------------------------------------------------
  // Swept by hand, entered here so the sweep does not have to be trusted twice.
  // ---------------------------------------------------------------------------

  {
    id: "sig-freshness",
    swept: true,
    defect: "A signed request was accepted whatever its `iat` said (§ 8.1), so a captured envelope stayed valid forever.",
    file: "packages/hub/src/signature.ts",
    from: "if (Math.abs(now - iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {",
    to: "if (false) {",
    suite: "test/signature.test.ts",
    expect: ["an iat outside the window is refused"],
  },
  {
    id: "nonce-replay",
    swept: true,
    defect: "A nonce already spent inside the window was accepted again (§ 8.1) — replay with no forgery required.",
    file: "packages/hub/src/signature.ts",
    from: "if (!nonces.claim(identity, nonce, iat)) {",
    to: "if (false) {",
    suite: "test/signature.test.ts",
    expect: ["a replayed nonce inside the window is refused"],
  },
  {
    id: "send-idempotent-retry",
    swept: true,
    defect: "A retry carrying a known `client_message_id` sent a second message instead of returning the first (§ 8.2). The failure mode is invisible on the sending side and duplicated on the receiving one.",
    file: "packages/hub/src/rpc/send.ts",
    from: "if (prior) {",
    to: "if (false) {",
    suite: "test/mailbox.test.ts",
    expect: ["a retry with the same key returns the original message"],
  },
  {
    id: "send-key-reuse-conflict",
    swept: true,
    defect: "A `client_message_id` reused for *different* content returned the original message rather than SEND_CONFLICT — the second send silently vanishes, which is worse than either sending or refusing.",
    file: "packages/hub/src/rpc/send.ts",
    from: "if (prior.request_digest === digest) {",
    to: "if (true) {",
    suite: "test/mailbox.test.ts",
    expect: ["reusing a key for a different message is permanent"],
  },
  {
    id: "proxy-entitlement",
    swept: true,
    defect: "An identity could send as anyone by naming them in `from`, with no grant (§ 8.11.2).",
    file: "packages/hub/src/rpc/send.ts",
    from: "if (!verdict.ok) {",
    to: "if (false) {",
    suite: "test/entitlement.test.ts",
    expect: ["an identity without the grant cannot speak for anyone"],
  },
  {
    id: "proxy-declared",
    swept: true,
    defect: "A socket spoke for an identity it had not declared in `proxy_for` — the grant was checked, the declaration was not, so a gateway's whole grant was reachable from any socket it happened to hold.",
    file: "packages/hub/src/rpc/send.ts",
    from: "if (!wsProxies.get(ws)?.has(effectiveSender)) {",
    to: "if (false) {",
    suite: "test/entitlement.test.ts",
    expect: ["a gateway cannot speak for a person it did not declare"],
  },
  {
    id: "pairing-single-use",
    swept: true,
    defect: "A pairing code could be redeemed more than once (§ 10.4). Single-use is the whole of what makes a short code safe to hand over a gap.",
    file: "packages/store/src/ownership.ts",
    from: "WHERE code = ? AND redeemed_at IS NULL AND expires_at > datetime('now')",
    to: "WHERE code = ? AND expires_at > datetime('now')",
    suite: "test/keys.test.ts",
    expect: ["a pairing code is issued, redeemed once, and establishes ownership"],
  },
  {
    id: "audit-redaction",
    swept: true,
    defect: "The audit query returned secret-bearing keys verbatim (§ 11.0). An audit route is exactly where a stored credential gets read back by someone entitled to metadata and nothing more.",
    file: "packages/http/src/audit-query.ts",
    from: "REDACTED_KEYS.has(k.toLowerCase())",
    to: "false",
    suite: "test/audit.test.ts",
    expect: ["never returns secrets, however they were stored"],
  },
  {
    id: "attachment-participation",
    swept: true,
    defect: "Any signed-in caller could download any attachment (§ 15.3), rather than only the parties to a message carrying it.",
    file: "packages/http/src/attachment-access.ts",
    from: "WHERE (from_agent = ? OR to_agent = ?)",
    to: "WHERE (from_agent = ? OR to_agent = ? OR 1 = 1)",
    suite: "test/http.test.ts",
    // NOT "a party to no message carrying it" — that one passes under this
    // mutation and did. Its attachment had never been sent, so the `content
    // LIKE` half refused on its own and the identity clause was never reached:
    // a negative test that proves the wrong half. The mutation found the hole,
    // which is what it is for.
    expect: ["a stranger to a conversation carrying it is refused"],
  },
  {
    id: "reregister-deleted",
    swept: true,
    defect: "A torn-down identity could be re-registered (§ 10.2), which resurrects a name whose history says it was withdrawn.",
    file: "packages/hub/src/rest/agents.ts",
    from: "if (existing?.deleted_at) {",
    to: "if (false) {",
    suite: "test/identity.test.ts",
    expect: ["re-registering a deleted identity is refused"],
  },
  {
    id: "dormancy-proxy-exempt",
    swept: true,
    defect: "The dormancy check ran on proxied sends too. `sent_by: http-server` is the same address for every web send, so it would refuse on the proxy's history and never on the sender's — a check that fires on the wrong party is worse than one that does not fire.",
    file: "packages/hub/src/dormancy.ts",
    from: "if (sentBy !== from) return { refusal: null };",
    to: "if (false) return { refusal: null };",
    suite: "packages/hub/src/dormancy.test.ts",
    expect: ["a proxied send, because the address observed is the proxy's"],
  },
];

/**
 * Two entries that MUST be reported as failures.
 *
 * **The reporting branch had never run.** The manifest was filled, every entry
 * reported caught, and the code that says `✗` was dead the whole time — a
 * check whose failure path is untested is a check nobody has seen work, which is
 * the subject of `docs/decisions/checks-that-check-nothing.md` appearing inside
 * the tool written for it.
 *
 * Proving it once by hand was not enough for the same reason the manifest
 * exists: the proof outlives what it describes and lives only in a transcript.
 * `--self-check` makes it a command.
 *
 * One for each way a mutation can fail to be evidence — the guard not noticing,
 * and the pattern no longer matching. The second is the more dangerous: it
 * produces a *false* finding rather than a missed one, and `client-claude`
 * reached the same conclusion independently (mail #219).
 */
const SELF_CHECK: Mutation[] = [
  {
    id: "self-check/not-caught",
    defect: "An edit no guard could object to. Must be reported as not caught.",
    file: "test/typecheck-scope.test.ts",
    from: 'const ROOT = resolve(import.meta.dir, "..");',
    to: 'const ROOT = resolve(import.meta.dir, ".."); // self-check, reverted immediately',
    suite: "test/typecheck-scope.test.ts",
    expect: ["this string never appears in any output"],
    expectFailure: "not-caught",
  },
  {
    id: "self-check/no-match",
    defect: "A pattern that cannot match. Must be a failure, never a skip.",
    file: "test/typecheck-scope.test.ts",
    from: "THIS_STRING_IS_DEFINITELY_NOT_PRESENT",
    to: "x",
    suite: "test/typecheck-scope.test.ts",
    expect: ["irrelevant — the pattern check fires first"],
    expectFailure: "no-match",
  },
];

/**
 * Where a failing run's output is kept.
 *
 * Ids carry a `/` (`self-check/not-caught`), which `Bun.write` reads as a
 * directory — the first version created `mutation-check-self-check/` rather than
 * a file, and the `.gitignore` entry added alongside it did not match the
 * result. Flattened, and in one function so the call sites cannot disagree.
 */
const evidenceName = (id: string) => `mutation-check-${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.log`;

const dirty = async (): Promise<string> => (await $`git status --porcelain`.quiet().text()).trim();

const argv = process.argv.slice(2).filter((a) => a !== "--");
const selfCheck = argv.includes("--self-check");
const filter = argv.filter((a) => !a.startsWith("--"));
const selected = selfCheck
  ? SELF_CHECK
  : filter.length
    ? MUTATIONS.filter((m) => filter.some((f) => m.id.includes(f)))
    : MUTATIONS;

if (selected.length === 0) {
  console.error(`no mutation matches ${filter.join(", ")}`);
  process.exit(2);
}

// A run inside another mutation measures a baseline somebody else moved, and
// `git checkout --` then restores to *their* mutation rather than to the
// original. A marker rather than a process-name check: it holds however the
// nesting happens, including through a committed outer mutation, which the
// dirty-tree refusal below cannot see.
if (process.env.AGENT_MESH_MUTATING) {
  console.error("cannot run inside another mutation — nothing here would be measuring itself");
  process.exit(2);
}

const before = await dirty();
if (before) {
  console.error("refusing to run with uncommitted changes — restoring is `git checkout --`:\n" + before);
  process.exit(2);
}

// Held for the whole loop, not per entry. Restores happen between entries, so
// the tree is only wrong inside a window — but another process starting has no
// way to know which window it landed in, and asking it to retry is asking it to
// guess.
const releaseTree = holdTree(`mutation-check (${selected.length} entr${selected.length === 1 ? "y" : "ies"})`);

let missed = 0;
/** Why each failure happened — the self-check needs the reason, not just the count. */
const kinds = new Map<string, FailureKind>();
for (const m of selected) {
  const path = Bun.file(m.file);
  const src = await path.text();
  if (!src.includes(m.from)) {
    // Loud, and counted as a failure. A pattern that no longer matches runs the
    // unmutated source, which passes, which reads as the guard missing it.
    console.error(`✗ ${m.id}: pattern no longer present in ${m.file} — this mutation checks nothing`);
    missed++;
    kinds.set(m.id, "no-match");
    continue;
  }

  await Bun.write(m.file, src.replace(m.from, m.to));
  const run = await $`bun test ${m.suite}`.env({ ...process.env, AGENT_MESH_MUTATING: "1" }).quiet().nothrow();
  const output = run.stdout.toString() + run.stderr.toString();
  await $`git checkout -- ${m.file}`.quiet();

  const after = await dirty();
  if (after) {
    console.error(`✗ ${m.id}: tree still dirty after restore:\n${after}`);
    process.exit(2);
  }

  // **A run with no summary decided nothing.** `caught` reads a non-zero exit and
  // the expected text; if the child died before reporting — a crashed runtime, a
  // truncated pipe, an out-of-memory kill — both are absent, and the entry was
  // being recorded as though the guard had not noticed. That is a false finding
  // about the guard rather than a true one about the run, which is the
  // distinction this tool exists to keep.
  if (!/\d+ (pass|fail)/.test(output)) {
    console.error(`✗ ${m.id}: the run reported no test summary — inconclusive, not a verdict`);
    await Bun.write(evidenceName(m.id), `exit ${run.exitCode}\n\n${output}`);
    missed++;
    kinds.set(m.id, "inconclusive");
    continue;
  }

  const caught = run.exitCode !== 0 && m.expect.every((e) => output.includes(e));
  if (caught) {
    console.log(`✓ ${m.id}`);
  } else {
    console.error(`✗ ${m.id}: not caught, or caught by the wrong check (wanted ${m.expect.map((e) => JSON.stringify(e)).join(" + ")})`);
    // **Keep what the run said.** `type-change-event` came back not-caught once
    // and passed on every rerun; the output that would have explained it had
    // already been discarded, so the investigation started from nothing and the
    // obvious explanation — a second writer of that event — turned out on
    // inspection to be a type signature.
    //
    // An intermittent this tool cannot describe is one somebody will eventually
    // guess a cause for, and a guessed cause in the place findings go is worse
    // than no entry at all. `docs/deferred.md` has one that had to be withdrawn
    // for exactly that.
    const evidence = evidenceName(m.id);
    await Bun.write(evidence, `exit ${run.exitCode}\nexpected: ${m.expect}\n\n${output}`);
    console.error(`  output kept in ${evidence}`);
    missed++;
    kinds.set(m.id, "not-caught");
  }
}

if (selfCheck) {
  // Inverted, and **by reason rather than by count**. Every entry must be
  // reported as a failure *for the reason it declares*. Counting alone passed
  // once with both entries refused for a missing pattern, printing "2/2
  // correctly reported as failures" while the branch under test never ran.
  const wrong = selected.filter((m) => kinds.get(m.id) !== m.expectFailure);
  for (const m of wrong) {
    console.error(
      `  ${m.id}: expected to fail as "${m.expectFailure}", got "${kinds.get(m.id) ?? "caught"}"`,
    );
  }
  console.log(
    wrong.length === 0
      ? `\nself-check: ${selected.length}/${selected.length} failed for the declared reason`
      : `\nself-check FAILED: ${wrong.length} did not fail the way it must — the reporting branch is untested`,
  );
  process.exit(wrong.length === 0 ? 0 : 1);
}

// **The denominator is what ran; the manifest total is named beside it.**
// A filtered run printed `2/2 caught` with nothing to say it was two of
// twenty-six, which reads as a clean full run — the same shape as quoting a
// `bun test` case count as a scenario count, which happened twice here.
// `client-claude` found it in their runner first (mail #278) and it was in this
// one too.
const scope =
  selected.length === MUTATIONS.length
    ? ""
    : ` — filtered to ${filter.join(", ")}, of ${MUTATIONS.length} in the manifest`;
console.log(`\n${selected.length - missed}/${selected.length} caught${scope}`);
process.exit(missed === 0 ? 0 : 1);

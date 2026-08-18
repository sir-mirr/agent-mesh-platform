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

// The verdict predicate lives in its own module because importing a script
// runs it: this one refuses on a dirty tree and exits, so a test that imported
// it to check `readVerdict` never got as far as a test.
import { markFor, readVerdict, summarise, verdictsAgree, type Verdict } from "./mutation-verdict";

export { markFor, readVerdict, summarise, verdictsAgree, type Verdict };

/** Why an entry was not counted as caught. */
type FailureKind = import("./mutation-verdict").FailureKindName;

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
    // **Aimed at `provision`, not at `sleep`.** The first version deleted the
    // `sleep` case, and `sleep` is used by exactly two of eighteen scenarios —
    // both of which ask for a bespoke mesh (`receiveLeaseSeconds: 2`). When one
    // of those failed to come up in CI the suite reported that instead, the
    // expected string never appeared, and the entry read `not caught`.
    //
    // The tool was right and the entry was fragile: it depended on the most
    // failure-prone step in the run to reach the branch it was testing.
    // `provision` appears twenty-four times, on the shared mesh, in the first
    // step of nearly every scenario — so an unhandled verb throws before
    // anything else can go wrong instead.
    from: '    case "provision": {',
    to: '    case "provision-disabled-by-mutation": {',
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
    // Anchored past the file globs, which move. The first version ended at
    // `"*.ts"],` and stopped matching the moment `"*.tsx"` was added beside it —
    // and the tool said so, out loud, rather than reporting the entry as
    // caught. That refusal is the whole reason a no-match is a failure here.
    from: '"--cached", "--others", "--exclude-standard"',
    to: '"--not-a-flag"',
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

  {
    id: "orphan-readonly",
    defect:
      "The orphan sweep opened the audit store read-write. It does not write, so nothing observable changes and the whole suite stayed green — but § 15.6 requires a sweep that is safe beside a live core, and a handle that *could* write is one an edit six months from now will write through.",
    file: "scripts/collect-orphan-blobs.ts",
    from: 'openStore("audit", { readonly: true })',
    to: 'openStore("audit")',
    suite: "test/orphans.test.ts",
    // A source check, because there is nothing to observe from outside the
    // process: SQLite refuses the write inside the connection, and no test
    // holds it. The mtime test beside this one passes under the mutation.
    expect: ["and could not, because the handle is read-only"],
  },

  {
    id: "blob-base-url-advert",
    defect:
      "`/api/v1/capabilities` did not report the upload address the hub hands out, so a deployment that forgot `AGENT_MESH_BLOB_BASE_URL` served `http://127.0.0.1:3000` URLs pointing at whatever else held that port — and nothing observable disagreed until the first attachment. The same shape as the receive lease beside it, which is advertised for exactly this reason.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "        blob_base_url: BLOB_BASE_URL,",
    to: '        blob_base_url: "http://127.0.0.1:3000",',
    suite: "test/blobs.test.ts",
    // A harness on ephemeral ports is never legitimately 3000, which is what
    // separates reporting the configuration from reporting the constant.
    expect: ["capabilities reports the configured one, not the default"],
  },

  {
    id: "spec-capability-drift",
    defect:
      "§ 11's capability table in SPEC.md listed eight names while the code enforced twelve, and one of the eight — `inbox.read.depth` — had been renamed to `mailbox.read.depth` and never followed. The normative document named a capability nobody could grant and omitted four that existed.",
    file: "SPEC.md",
    from: "| `usage.read` | AI usage figures |\n",
    to: "",
    suite: "test/capability-vocabulary.test.ts",
    // Parsed out of the document rather than restated, the way auth-sweep reads
    // the § 9.1 route table — a third copy would go stale silently.
    expect: ["names exactly what the code enforces"],
  },

  {
    id: "telemetry-constant",
    defect:
      "A screen of constants is what this route replaces — 139 sessions, 1024 MB, 99.99% — and no typecheck or build ever objected, because a constant is perfectly well typed. The only check that separates a reported number from an invented one is whether it follows the mesh.",
    file: "packages/http/src/main.ts",
    from: "    keys_awaiting_decision: { waiting: keys.waiting, oldest: keys.oldest },",
    to: "    keys_awaiting_decision: { waiting: 0, oldest: null },",
    suite: "test/telemetry.test.ts",
    // The test provisions a key and asserts the count moved. On an empty mesh
    // every field here is legitimately zero, so asserting on a fresh mesh alone
    // would pass against a hardcoded response.
    expect: ["provisioning a key did not move the count"],
  },
  {
    id: "telemetry-limits-asked",
    defect:
      "The rate-limit buckets live in the hub process and nowhere else, so this route asks rather than computes. Answering from here — with anything, including an empty list — reports on a process it cannot see.",
    file: "packages/http/src/main.ts",
    // Re-anchored after the block grew a `refusals` field. The first anchor
    // spanned the whole `if (res.ok)` line and stopped matching the moment the
    // body was destructured — reported as `checks nothing`, not as caught,
    // which is the second time today this refusal caught the manifest itself
    // rather than the code.
    from: "      limiters = body.limiters",
    to: "      limiters = []",
    suite: "test/telemetry.test.ts",
    expect: ["the limits come from the hub"],
  },

  {
    id: "refusals-counted",
    defect:
      "§ 8.1 refused a bad signature and forgot it — an RPC error and a line on stdout, nothing queryable. So 'is something failing to get in' meant grepping a process, and 'has this ever happened' had no answer. Counting turned out to need four call sites, not the one the code reads as having.",
    file: "packages/hub/src/rpc/dispatch.ts",
    from: '    recordRefusal("signature", `key-${keyStatus ?? "unknown"}`);\n',
    to: "",
    suite: "test/telemetry.test.ts",
    expect: ["a refused signature was not counted"],
  },

  {
    id: "truncation-disclosed",
    defect:
      "A list capped at ten rows was served with no total beside it, so a screen drawing ten lanes out of two hundred reported that the problem was small and nothing in the response disagreed. Written an hour before it was noticed, in the route added to replace a screen of constants.",
    file: "packages/http/src/main.ts",
    from: "    lanes_not_draining_total: lanesTotal,",
    to: "    lanes_not_draining_total: lanes.length,",
    suite: "test/telemetry.test.ts",
    // Not the shape check — `total === shown` agrees with itself for every
    // input. The one that adds a lane and watches the total move.
    expect: ["the total did not follow a new lane"],
  },

  {
    id: "audit-digest-recomputed",
    defect:
      "The audit route returned `payload_digest` beside the row it describes and never compared them. A row edited afterwards carries a digest edited with it, or a mismatch nobody evaluates — and an audit store whose rows can change without detection is a log.",
    file: "packages/http/src/audit-query.ts",
    from: "createHash('sha256').update(row.payload, 'utf8').digest('hex') === row.payload_digest,",
    to: "true,",
    suite: "test/audit-integrity.test.ts",
    // The test edits the stored bytes behind the API and expects the route to
    // notice. Asserting `true` on a fresh mesh passes against a constant.
    expect: ["the payload changed and the route still said it matched"],
  },

  {
    id: "ack-settles-over-rest",
    defect:
      "Nothing checked that acknowledging over `/api/v1/mailbox/in` settles a message. The assertion that looked like it did read `remaining`, which counts leasable rows only — so a 300-second lease made it zero whatever the acknowledgement did, and removing `ack_ids` left the suite green.",
    file: "packages/mailbox/src/receive.ts",
    from: "      const settled = stmt.ackMessage.run(messageId, identity);",
    to: "      const settled = { changes: 0 };",
    suite: "test/mailbox-routes.test.ts",
    // A one-second lease, so the batch comes back if it was never settled. The
    // manifest catches a deleted guard; it cannot catch a weakened test, which
    // is why the first version of this entry — removing the lease wait — was
    // wrong: that mutation makes the assertion vacuous and therefore green.
    expect: ["an acknowledged message came back after the lease"],
  },
  {
    id: "bootstrap-observes-registry",
    defect:
      "`repeated invocations change nothing` compared two empty lists. Its helper fetched a route the hub answers 405 to, then returned `[]` under a comment promising a fallback nobody wrote — so a script that wiped the registry on its second run passed.",
    file: "test/bootstrap.test.ts",
    from: '  const probe = ["http-server", "self-reminder", "not-provisioned-by-bootstrap"];',
    to: "  const probe: string[] = [];",
    suite: "test/bootstrap.test.ts",
    expect: ["the first run provisioned no identity"],
  },

  {
    id: "row-payload-agree",
    defect:
      "Five fields sit on the audit row and inside the payload it stores, and nothing compared them. The payload is what the producer signed; the columns are the hub's projection of it. A projection that drifts means the row contradicts its own signed bytes, and from outside it looks like a healthy row.",
    file: "packages/http/src/audit-query.ts",
    from: "    event_type: row.event_type,",
    to: '    event_type: row.event_type + "-desynced",',
    suite: "test/audit-integrity.test.ts",
    expect: ["row.event_type and payload.event_type disagree"],
  },

  {
    id: "redaction-withholds",
    defect:
      "\u00a7 11.0's redaction was unreachable by any account and therefore unchecked: admin holds every capability and a stranger holds none, so the state the audit screen advertises — content withheld from a metadata-only reader — had no caller who could stand on it.",
    file: "packages/http/src/audit-query.ts",
    from: "      if (k === 'content') {",
    to: "      if (false) {",
    suite: "test/audit-integrity.test.ts",
    // Needs `capabilityViewer`, which makes an account holding exactly
    // `audit.read.metadata`. Before it existed this branch could not be entered
    // by any caller the suite could produce.
    expect: ["content reached a metadata-only reader"],
  },

  {
    id: "carrier-not-sender",
    defect:
      "The audit row recorded the carrier as the sender. \u00a7 8.2 keeps them apart — `from` is who the message is from, `sent_by` is who carried it — and on a mesh where nothing is ever proxied the two are equal in every row, so overwriting one with the other was invisible.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "      sent_by: fields.sentBy,",
    to: "      sent_by: fields.from,",
    suite: "test/audit-integrity.test.ts",
    // Needs a proxied send, which needs a keyless subject: § 8.2 refuses a
    // proxy for an identity that holds its own key. No other test in this
    // repository produces a row where the two differ.
    expect: ["the carrier was not recorded"],
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
  {
    id: "death-announced",
    defect:
      "A spawned service that exited on its own said why, into a buffer nothing read. CI run 32059573317 reported fifteen failures reading `Unable to connect`; one test had exceeded its budget, Bun signalled the shared mesh, and the hub's own account of its shutdown sat in `output()` where only a test that thought to ask would find it. Nothing asked.",
    file: "test/harness.ts",
    from: "  void proc.exited.then((code) => {",
    to: "  void Promise.resolve().then((code?: number) => { if (1) return;",
    suite: "test/harness-death.test.ts",
    expect: ["says so, and repeats what it said on the way out"],
  },
  {
    id: "orderly-exit-silent",
    defect:
      "The announcement above has to tell an exit somebody asked for from one nobody did. Without the `stopped` flag it fires after every suite that shuts down cleanly, a reader learns to skip it, and it costs exactly what not printing it would on the run where it mattered.",
    file: "test/harness.ts",
    from: "    if (stopped) return;",
    to: "    if (false) return;",
    suite: "test/harness-death.test.ts",
    expect: ["but stop() is silent, because that exit was asked for"],
  },
  {
    id: "dead-service-unaddressable",
    defect:
      "Every test after a dead shared mesh failed with `Unable to connect` — true about the socket, wrong about the subject. Those tests reached nothing and measured nothing, and a reader who cannot tell debris from cause cannot see a second real failure hiding in the debris. A rerun then comes back red with nothing to say about which red it is.",
    file: "test/harness.ts",
    from: "      const epitaph = svc.died();",
    to: "      const epitaph = null;",
    suite: "test/harness-death.test.ts",
    expect: ["is told it measured nothing, not that a socket was unreachable"],
  },
  {
    id: "dropped-frame-not-a-delivery",
    defect:
      "`ws.send` reports a dropped frame by returning 0 rather than throwing, and `mesh.send` decided `delivered` from the presence of a socket before sending. A message to a socket that had gone away was written `delivered` in the row and in § 8.9.4's audit event, and a row that is not pending is never replayed — so the claim that the recipient got it is also the reason it is unrecoverable.",
    file: "packages/hub/src/jsonrpc.ts",
    from: "  return ws.send(frame) !== 0;",
    to: "  ws.send(frame); return true;",
    suite: "packages/hub/src/rpc/delivery-landing.test.ts",
    expect: ["is recorded pending when the socket drops the frame"],
  },
  {
    id: "backpressure-is-not-a-loss",
    defect:
      "Bun returns -1 when a frame is buffered behind backpressure — queued, and about to flush. Reading any non-positive return as a loss would leave the row pending and replay it on the next connect, handing the recipient a duplicate of a message it was already receiving. The fix for a loss would have manufactured one.",
    file: "packages/hub/src/jsonrpc.ts",
    from: "  return ws.send(frame) !== 0;",
    to: "  return ws.send(frame) > 0;",
    suite: "packages/hub/src/rpc/delivery-landing.test.ts",
    expect: ["backpressure is a delivery, not a loss"],
  },
  {
    id: "replay-stops-at-a-drop",
    defect:
      "The replay loop's `break` was unreachable: it sat in a `catch`, and a send to a closed socket returns 0 instead of throwing. A reconnect into a closing socket walked the entire queue, marking every message delivered and writing an audit event for each.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "      if (!landed) {",
    to: "      if (false) {",
    suite: "packages/hub/src/rpc/delivery-landing.test.ts",
    expect: ["leaves the queue pending when the socket drops the frame"],
  },
  {
    id: "health-counts-agents",
    defect:
      "`GET /api/v1/health` answered `agent_count` from `agent_registry`, the http server's messaging directory, whose only writers are a legacy JSON import and one that inserts a person. It reported 1 — the `admin` human — on a deployment holding fourteen mesh identities: a number that moves when somebody logs in and not when an agent is provisioned.",
    file: "packages/http/src/main.ts",
    from: "    .prepare('SELECT count(*) AS n FROM agents')",
    to: "    .prepare('SELECT 1 AS n')",
    suite: "test/http.test.ts",
    expect: ["`agent_count` counts mesh identities, and moves when one is provisioned"],
  },
  {
    id: "refused-send-written-back",
    defect:
      "`POST /api/v1/messages` corrected a refused message's status on the object it answers from and never on the row. No UPDATE of that table existed in the package, so the response said `failed` and the record said `pending` — and the record is what the history route, the conversation view and search all serve, for the rest of the message's life.",
    file: "packages/http/src/main.ts",
    from: "    if (!updateMessageStatus(msg.id, 'failed')) {",
    to: "    if (false) {",
    suite: "test/message-status.test.ts",
    expect: ["is recorded as failed, not left pending for ever"],
  },
  {
    id: "real-error-category",
    defect:
      "Three sites caught with `catch {`, discarded the error, and filed the outcome as `hub_rpc_failed` — the fallback `hubErrorCategory` returns when it has nothing better. One of the three is read back into the recovery alert's `last_error_category=`, so an operator asking why an outage happened was answered with a constant.",
    file: "packages/self-reminder/src/scheduler.ts",
    from: "          const category = hubErrorCategory(error);",
    to: '          const category = "hub_rpc_failed";',
    suite: "packages/self-reminder/src/error-category.test.ts",
    expect: ["records the hub's own category, not a constant"],
  },
  {
    id: "transient-push-keeps-subscription",
    defect:
      "Every rejected push deleted the subscription. A 500, a 429 or a DNS failure unsubscribed the device as surely as a browser that had gone away, silently — so a person's phone went quiet and the repair was for them to notice. Only 404 and 410 mean the endpoint is gone.",
    file: "packages/http/src/push.ts",
    from: "  if (typeof status === \"number\" && GONE.has(status)) {",
    to: "  if (true) {",
    suite: "packages/http/src/push.test.ts",
    expect: ["a push service outage unsubscribed the device"],
  },
  {
    id: "push-status-must-be-a-number",
    defect:
      "An error with no `statusCode` — a DNS failure, an abort — read as `undefined`, and the old code deleted anyway. An error whose status is unknown is not a subscription known to be gone.",
    file: "packages/http/src/push.ts",
    from: "  if (typeof status === \"number\" && GONE.has(status)) {",
    to: "  if (GONE.has(status as number) || status === undefined) {",
    suite: "packages/http/src/push.test.ts",
    expect: ["an error with no status at all keeps it"],
  },
  {
    id: "bootstrap-retries-usable",
    defect:
      "`for (( attempt = 1; attempt <= MAX_RETRIES; … ))` with MAX_RETRIES=0 never enters its body, falls off the end returning 0, and the hub unit's ExecStartPost reports success having registered nothing. Bash reads any non-numeric string as 0, so a typo in a unit file is the same defect with no number in sight.",
    file: "ops/bin/bootstrap-hub-service-identities.sh",
    from: 'if ! [[ "$MAX_RETRIES" =~ ^[1-9][0-9]*$ ]]; then',
    to: "if false; then",
    suite: "test/bootstrap.test.ts",
    expect: ["was accepted"],
  },
  {
    id: "wal-checkpoint-inert",
    defect:
      "The shutdown path folded no write-ahead log at all. `db.close()` with statements still prepared against the handle is a *safe* close in bun: it marks the database closed to JavaScript and leaves the file open, so nothing is checkpointed. The standing deployment showed it as a `hub.db` of 4096 bytes — one page, no checkpoint ever completed — beside 1.5 MB of log. Two years of `close()` calls doing nothing, with every suite green.",
    file: "packages/store/src/open.ts",
    from: '    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");',
    to: "    void db;",
    suite: "packages/store/src/checkpoint.test.ts",
    expect: ["folds a log that close() leaves whole"],
  },
  {
    id: "wal-checkpoint-unwired",
    defect:
      "The checkpoint existed and the hub did not call it. Guarding the helper alone leaves the wiring free to be deleted, which is the state the repair started from: `closeDatabases()` opened four stores, closed three, and folded none.",
    file: "packages/hub/src/db.ts",
    from: "    if (store) checkpointForShutdown(store);",
    to: "    void store;",
    suite: "packages/hub/src/close-databases.test.ts",
    expect: ["closeDatabases folds hub, agents and audit"],
  },
  {
    id: "wal-http-access-log",
    defect:
      "`closeAuditAccessLog` was imported into the http server's shutdown and never called, so the § 8.9 access-log handle on `audit.db` — a second read-write connection — went out unfolded and unclosed. Invisible while the hub happened to stop last, because the hub folds that store too.",
    file: "packages/http/src/main.ts",
    from: "  closeAuditAccessLog()",
    to: "  void closeAuditAccessLog",
    suite: "test/wal-shutdown.test.ts",
    expect: ["stopping the hub first still folds what only the http server holds", "audit.db-wal"],
  },
  {
    id: "wal-http-access-log-fold",
    defect:
      "Closing the § 8.9 access-log handle without checkpointing it left 156 KB of log behind — measured, in the same process and run where `agent-mesh.db` folded on a bare close. Which one happens depends on whether a statement is still prepared against the handle, and that depends on when the collector last ran. A shutdown path must not rest on that.",
    file: "packages/http/src/audit-access-log.ts",
    from: "    checkpointForShutdown(_db)",
    to: "    void _db",
    suite: "test/wal-shutdown.test.ts",
    expect: ["stopping the hub first still folds what only the http server holds", "audit.db-wal"],
  },
  {
    id: "wal-reminder-unhandled",
    defect:
      "The self-reminder daemon installed no signal handler at all, so `systemctl stop` killed it mid-poll and `self-reminder.db-wal` outlived every restart. Nothing complained, because the store is written for abrupt death — `firing` rows are recovered on the way up — so 'no data is lost' was true and 'nothing is left behind' was not, and only the first was ever checked.",
    file: "packages/self-reminder/src/main.ts",
    from: 'process.on("SIGTERM", () => shutdown("SIGTERM"));',
    to: 'void shutdown;',
    suite: "test/wal-shutdown.test.ts",
    // `143` is the fact, not the log size: a process with no handler is killed
    // by the signal rather than exiting from it, and the test reaches the file
    // assertions only if it exited. Naming the log here instead would be an
    // expectation the run never gets to.
    expect: ["the self-reminder daemon folds its log on SIGTERM", '"code": 143'],
  },
  {
    id: "wal-reminder-fold",
    defect:
      "A shutdown handler that closes without checkpointing leaves the log exactly where it was — the same inert `close()` as everywhere else, now inside a handler that looks like it handles it.",
    file: "packages/self-reminder/src/main.ts",
    from: "  checkpointForShutdown(db);",
    to: "  void db;",
    suite: "test/wal-shutdown.test.ts",
    expect: ["the self-reminder daemon folds its log on SIGTERM", "self-reminder.db-wal"],
  },
  {
    id: "verdict-flap-blind",
    defect:
      "Repeated runs of one mutation were believed without being compared, so an entry whose verdict depends on GC timing read as `caught` on most runs. `wal-reminder-fold` was exactly that, and it surfaced because a full pass happened to disagree with an earlier filtered one — luck, not a mechanism. agent-mesh-local-pm asked whether this script could catch its own non-deterministic entries; it could not.",
    file: "scripts/mutation-verdict.ts",
    from: "  return new Set(kinds).size <= 1;",
    to: "  return kinds.length >= 0;",
    suite: "test/mutation-verdict.test.ts",
    expect: ["caught once and missed once is a flap, not a catch"],
  },
  {
    id: "inventory-axis-count",
    defect:
      "§ 0 of the FE coverage inventory stated per-family totals as literals — a second declaration of what the test files register — and two of them had gone quietly wrong: `SC-DOWN-*` said 8 with nine registered, `SC-WRITE-*` said 6 with eight. The inventory is the denominator for goal ②, so an undercount reads as work not yet done and gets written twice.",
    file: "packages/platform-web/COVERAGE_INVENTORY.md",
    from: "| `SC-WRITE-*` | 실패한 쓰기를 성공으로 그리지 않는가 | 8 |",
    to: "| `SC-WRITE-*` | 실패한 쓰기를 성공으로 그리지 않는가 | 6 |",
    suite: "test/scenario-ids.test.ts",
    expect: ["every count it states is the count the tests hold", "SC-WRITE-*: table says 6"],
  },
  {
    id: "inventory-axis-missing-row",
    defect:
      "A family can drift by being absent rather than by being wrong, and absence reads as `not written yet` — which is the direction that costs a rewrite. `SC-AUTH-04`, `SC-AUTH-05` and `SC-HARNESS-02` had no row at all, and `SC-BELL-01` was written twice for exactly this reason.",
    file: "packages/platform-web/COVERAGE_INVENTORY.md",
    from: "| `SC-HARNESS-*` | 하네스가 잰다고 말한 것을 실제로 재는가 | 2 |\n",
    to: "",
    suite: "test/scenario-ids.test.ts",
    expect: ["every family with more than one id has a row", "SC-HARNESS-* has 2 ids and no row"],
  },
  {
    id: "proxy-block-target",
    defect:
      "`docs/running-locally.md` opens by naming the mistake it exists to prevent — reaching for the hub's 3100 when a browser talks to the http server's 3000 — and then prints proxy blocks for an administrator to copy. A copied block with the wrong port fails as a page that renders and cannot log in: the hub answers, so nothing is refused. The document warned in prose while the block was the thing being copied.",
    file: "docs/running-locally.md",
    from: "    proxy_pass http://127.0.0.1:3000;\n    proxy_set_header Host $host;",
    to: "    proxy_pass http://127.0.0.1:3100;\n    proxy_set_header Host $host;",
    suite: "test/readme.test.ts",
    expect: ["every proxy target is the http server, never the hub", "a proxy block points at the hub"],
  },
  {
    id: "inventory-id-shape",
    defect:
      "The inventory's own count read ids as `SC-[A-Z0-9]+-[0-9]+` — **does it end in digits** rather than **is it an id** — so `SC-DOWN-ALL` was invisible. That is the same blindness that made § 0's axis table say 8 with nine registered: whoever counted read the numbered ones. A guard went blind in the same place as the thing it guards against, in the file where the other check had already been fixed for it. Found by agent-mesh-local-pm.",
    file: "test/scenario-ids.test.ts",
    from: "const ID_IN_DOC = /SC-(?:[A-Z0-9]+-)+[A-Z0-9]+\\b(?!-\\*)/g;",
    to: "const ID_IN_DOC = /SC-[A-Z0-9]+-[0-9]+/g;",
    suite: "test/scenario-ids.test.ts",
    expect: ["it reads an id whose last segment is not a number"],
  },
  {
    id: "ignore-symlinked-modules",
    defect:
      "`node_modules/` with a trailing slash is a *directory* pattern, and git does not treat a symlink as a directory — so a worktree that links its dependencies rather than installing them shows four untracked `node_modules`. `scripts/e2e-harness.ts` then reports `platform.dirty` and `mutation-check` refuses to start, both deliberately. agent-mesh-local-pm hit it from both ends in one session, and the `dirty: true` from a worktree whose `git status` was empty nearly went into the record as a defect in the documented setup.",
    file: ".gitignore",
    from: "node_modules\n",
    to: "node_modules/\n",
    suite: "test/greppable.test.ts",
    expect: ["ignores node_modules whether it is a directory or a link to one", "a symlinked node_modules is showing as untracked"],
  },
  {
    id: "screen-names-local-address",
    defect:
      "The pairing screens rendered `curl -X POST http://localhost:3100/...` into a `<CodeBlock>` for the user to copy. It runs in a terminal that is not this browser and, on a deployment, not this machine — so a proxy cannot reach it. It named the reader's own laptop, and if a hub was running there it bound the agent to the wrong mesh. `3100` is also the hub while that route is served by `agent-mesh-http`, so the line worked nowhere, including where it was written. Found by agent-mesh-local-pm building `dist` and reading it.",
    file: "packages/platform-web/src/components/feedback/AgentPairingModal.tsx",
    from: "code={`curl -X POST ${publicApiOrigin()}/api/v1/pairing-codes/redeem",
    to: "code={`curl -X POST http://localhost:3100/api/v1/pairing-codes/redeem",
    suite: "test/greppable.test.ts",
    expect: ["no source in platform-web names a local address", "a screen is naming an address only one machine has"],
  },
  {
    id: "production-api-base",
    defect:
      "`.env.production` is a tracked file and set `VITE_API_BASE_URL=https://api.mesh.enterprise.internal`, a host nobody owns. `import.meta.env` bakes it in at build time, so every API call in a production build went there — the proxy was never reached and the screen rendered while nothing behind it answered. Nothing caught it because `.env.development` is empty and every test and every local run is a dev build: the production path had never been executed. Found by agent-mesh-local-pm building `dist` and reading it.",
    file: "packages/platform-web/.env.production",
    from: "VITE_API_BASE_URL=",
    to: "VITE_API_BASE_URL=https://api.mesh.enterprise.internal",
    suite: "test/production-bundle.test.ts",
    expect: ["the production bundle asks the page's own origin for the API", "api.mesh.enterprise.internal"],
  },
  {
    id: "production-origin-at-runtime",
    defect:
      "The same line, guarded at the layer that actually answers the question. Reading the bundle proves a string; it does not prove that the app, loaded and executing, sends its requests anywhere reachable — and this defect lived exactly in that gap, with the source right, every test green and the dev build working. agent-mesh-local-pm measured the broken build in a browser: zero same-origin requests, one to `api.mesh.enterprise.internal`, and a rendered screen.",
    file: "packages/platform-web/.env.production",
    from: "VITE_API_BASE_URL=",
    to: "VITE_API_BASE_URL=https://api.mesh.enterprise.internal",
    suite: "test/production-bundle.test.ts",
    expect: ["a loaded page sends its API calls to its own origin", "the page is calling a host it was not served from"],
  },
  {
    id: "verdict-summary-folds",
    defect:
      "`✗` carried three different facts and the summary counted them as one. agent-mesh-local-pm read `✗ signed-rate-limit` as a guard that missed something when it was this tool refusing to measure — the tree had changed under it. Only `not-caught` is a statement about the code; folding `no-match`, `inconclusive` and `flapped` into it is how a tooling problem gets written down as a defect, which is the failure this script exists to prevent, in its own output.",
    file: "scripts/mutation-verdict.ts",
    from: "  if (unmeasured) parts.push(`${unmeasured} not measured`);",
    to: "  if (unmeasured) parts.push(`${unmeasured} not caught`);",
    suite: "test/mutation-verdict.test.ts",
    expect: ["a run that decided nothing is not a miss"],
  },
  {
    id: "telemetry-silent-refusal",
    defect:
      "`/platform/telemetry` rendered the same page whether its panels were refused or the mesh was idle. Two of its four endpoints are ungated — none of § 11's twelve capabilities names reading the registry — so they always answer, the `all four failed` throw was unreachable for a refusal, and the cells simply read `—`. agent-mesh-local-pm measured 999 bytes before the refusal and 999 after: the screen made no statement about the backend at all.",
    file: "packages/platform-web/src/api/telemetry.ts",
    from: "          refused.push({ panel: p.panel, capability: p.capability });",
    to: "          void p;",
    suite: "test/fe-render.test.ts",
    expect: ["names the refused panels on /platform/telemetry instead of rendering blanks"],
  },
  {
    id: "telemetry-unknown-reads-zero",
    defect:
      "An unread source drawn as `0` on the one screen where four of six metrics read `0` when all is well. No signature refusals, no egress refusals, nothing rate-limited, nothing queued — those are the answers an operator hopes for, so a zero produced by a hub that did not answer is the number nobody questions. agent-mesh-local-pm asked for this guard before the endpoint was written, having found four screens the same evening drawing what they could not know: `ONLINE`, `0`, `verified`, and `1`.",
    file: "packages/http/src/behaviour-metrics.ts",
    from: 'const unread = (why: string): Metric => ({ value: null, unavailable: why });',
    to: 'const unread = (why: string): Metric => ({ value: 0, unavailable: why });',
    suite: "packages/http/src/behaviour-metrics.test.ts",
    expect: ["a hub that did not answer produces no numbers at all"],
  },
  {
    id: "counts-without-a-window",
    defect:
      "Refusal counts served without saying when counting began. The hub holds them in memory and they reset with it, so `0 refusals` and `this hub started ninety seconds ago` are the same figure — and on a screen the second one looks like health. The window has to travel with the numbers or the numbers cannot be read.",
    file: "packages/http/src/behaviour-metrics.ts",
    from: '    if (!countingSince) return unread("hub answered without counting_since");',
    to: "    void countingSince;",
    suite: "packages/http/src/behaviour-metrics.test.ts",
    expect: ["counts without a window are not offered as counts"],
  },
  {
    id: "invented-fingerprint",
    defect:
      "Every row of `/creator` showed `sha256:verified_mesh_identity` under a column headed `Ed25519 공개키 지문`, because `GET /api/v1/agents` carries no fingerprint and three call sites defaulted to that literal. A fingerprint is what an operator compares to decide an identity is who it claims to be: a constant makes every agent match, and the word `verified` inside it invites skipping the comparison, so a genuine mismatch was invisible. A class apart from drawing nothing where nothing is known — this drew a confirmation. Found by agent-mesh-local-pm re-reading a finding they had already closed.",
    file: "packages/platform-web/src/api/agents.ts",
    from: "    fingerprint: a.fingerprint ?? null,",
    to: '    fingerprint: a.fingerprint || "sha256:verified_mesh_identity",',
    suite: "test/greppable.test.ts",
    expect: ["no literal claims to be a digest without being one", "a literal announces a digest and is not one"],
  },
  {
    id: "digest-rule-excuses-interpolation",
    defect:
      "The rule exempted any literal containing `${`, on the reasoning that a real digest is usually built by interpolation. `sha256:gw_${cfg.id}_${…}` sat in that exemption — a synthesised key on a synthesised topology node, in the same list as real agents — and agent-mesh-local-pm found it one commit after the rule was written. An interpolated digest is still hex between its holes, so the placeholders are stripped now rather than excusing the whole literal.",
    file: "test/greppable.test.ts",
    from: '  const literalParts = body.replace(/\\$\\{[^}]*\\}/g, "");',
    to: '  const literalParts = body.includes("${") ? "" : body;',
    suite: "test/greppable.test.ts",
    expect: ["the rule reads a fabrication by shape, not by spelling"],
  },
  {
    id: "invented-fingerprint-onscreen",
    defect:
      "The same line, guarded at the screen. A static rule can be satisfied while the rendered column still reads as a confirmation — the value reaching an operator's eye is the one that matters, and it is the only layer that sees the absence marker actually drawn.",
    file: "packages/platform-web/src/api/agents.ts",
    from: "    fingerprint: a.fingerprint ?? null,",
    to: '    fingerprint: a.fingerprint || "sha256:verified_mesh_identity",',
    suite: "test/fe-render.test.ts",
    expect: ["shows no fingerprint on /creator, rather than a constant that says verified"],
  },
  {
    id: "absent-status-reads-healthy",
    defect:
      "`a.status === \"inactive\" ? … : a.status === \"pending\" ? … : \"active\"` — and `GET /api/v1/agents` sends no status, so `undefined` fell to the last branch and every agent rendered ONLINE. The largest form of the shape this suite has spent the week removing: elsewhere an unknown was drawn as `0` or *none*, which a reader can at least doubt; here an unknown is drawn as *healthy*, on the screen whose job is to show which agents are not. Measured on the standing mesh drawing `admin` — a web user, not a connected agent — as ONLINE.",
    file: "packages/platform-web/src/api/agents.ts",
    from: 'a.status === "active" ? "active" : null,',
    to: '"active",',
    suite: "test/fe-render.test.ts",
    expect: ["shows no fingerprint on /creator, rather than a constant that says verified"],
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
/**
 * How many times to run each mutated suite.
 *
 * **One run cannot tell a guard from a coin.** `wal-reminder-fold` was recorded
 * caught on the run that added it and then passed three of three on the next
 * full pass: the behaviour it removed — `close()` folding a write-ahead log —
 * happens only when no prepared statement survives to exit, which is the
 * collector's timing rather than the guard's doing. It surfaced because a full
 * pass happened to disagree with an earlier filtered one, and nothing in this
 * script was looking.
 *
 * A non-deterministic entry reads as `caught` on most runs, so the manifest
 * reports the difference as a defect in whatever else changed that day. That is
 * the same false finding this script exists to prevent, one level up.
 */
const repeat = (() => {
  const flag = argv.find((a) => a.startsWith("--repeat"));
  if (!flag) return 1;
  const value = Number(flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1]);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--repeat needs a positive integer, got ${JSON.stringify(flag)}`);
    process.exit(2);
  }
  return value;
})();
const repeatValueIndex = argv.findIndex((a) => a === "--repeat") + 1;
const filter = argv.filter((a, i) => !a.startsWith("--") && !(repeatValueIndex > 0 && i === repeatValueIndex));
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
    console.error(`${markFor("no-match")} ${m.id}: pattern no longer present in ${m.file} — this mutation checks nothing`);
    missed++;
    kinds.set(m.id, "no-match");
    continue;
  }

  await Bun.write(m.file, src.replace(m.from, m.to));
  // Repeated with the mutation left in place. The suite is the expensive part,
  // and re-applying the edit between attempts would put the edit inside what is
  // being measured.
  const attempts: Array<{ output: string; exitCode: number }> = [];
  for (let attempt = 0; attempt < repeat; attempt++) {
    const r = await $`bun test ${m.suite}`.env({ ...process.env, AGENT_MESH_MUTATING: "1" }).quiet().nothrow();
    attempts.push({ output: r.stdout.toString() + r.stderr.toString(), exitCode: r.exitCode ?? 0 });
  }
  await $`git checkout -- ${m.file}`.quiet();
  const run = attempts[0]!;
  const output = run.output;

  const after = await dirty();
  if (after) {
    console.error(`${markFor("inconclusive")} ${m.id}: tree still dirty after restore — nothing here measured the guard:\n${after}`);
    process.exit(2);
  }

  // **A run with no summary decided nothing.** `caught` reads a non-zero exit and
  // the expected text; if the child died before reporting — a crashed runtime, a
  // truncated pipe, an out-of-memory kill — both are absent, and the entry was
  // being recorded as though the guard had not noticed. That is a false finding
  // about the guard rather than a true one about the run, which is the
  // distinction this tool exists to keep.
  if (!/\d+ (pass|fail)/.test(output)) {
    console.error(`${markFor("inconclusive")} ${m.id}: the run reported no test summary — inconclusive, not a verdict`);
    await Bun.write(evidenceName(m.id), `exit ${run.exitCode}\n\n${output}`);
    missed++;
    kinds.set(m.id, "inconclusive");
    continue;
  }

  // **A summary is not the same as a run.** `send-idempotent-retry` came back
  // `0 pass / 1 fail` with `a beforeEach/afterEach hook timed out` — the mesh
  // never came up, so no test in the file executed and the guard had no chance
  // to object. The regex above matched `0 pass` and the entry was recorded as
  // `not caught`, which is a finding about a guard from a run that never
  // reached it.
  //
  // The rule was `0 pass` means the file did not run, on the reasoning that one
  // mutation breaks one guard and the rest of the file still passes. That held
  // for every entry in the manifest until `message-status.test.ts`, which
  // contains **one test**: when its guard objected, the summary was `0 pass /
  // 1 fail` and a correctly caught mutation was reported as inconclusive.
  //
  // `0 pass` means two different things and the count cannot tell them apart —
  // which is the ambiguity this whole script exists to hunt, sitting in the
  // script. What separates them is *why* nothing passed:
  const verdict = readVerdict(output, m.expect, run.exitCode);
  if (verdict.kind === "inconclusive") {
    console.error(`${markFor("inconclusive")} ${m.id}: no verdict from ${m.suite} — ${verdict.why}`);
    await Bun.write(evidenceName(m.id), `exit ${run.exitCode}\n\n${output}`);
    missed++;
    kinds.set(m.id, "inconclusive");
    continue;
  }

  // **Agreement first.** A verdict that is not the same every time is not a
  // verdict about the guard; it is one about whatever else moved between runs.
  // Reported as its own kind rather than as `not-caught`, because the two ask
  // for different repairs: `not-caught` says write a guard, `flapped` says the
  // guard is measuring something it does not control.
  if (attempts.length > 1) {
    const kindsSeen = attempts.map((a) => readVerdict(a.output, m.expect, a.exitCode).kind);
    if (!verdictsAgree(kindsSeen)) {
      console.error(`${markFor("flapped")} ${m.id}: verdict flapped across ${attempts.length} runs — ${kindsSeen.join(", ")}`);
      await Bun.write(
        evidenceName(m.id),
        attempts.map((a, i) => `--- run ${i + 1} (exit ${a.exitCode}) -> ${kindsSeen[i]}\n\n${a.output}`).join("\n\n"),
      );
      missed++;
      kinds.set(m.id, "flapped");
      continue;
    }
  }

  const caught = verdict.kind === "caught";
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
console.log(`\n${summarise([...kinds.values()], selected.length)}${scope}`);
process.exit(missed === 0 ? 0 : 1);

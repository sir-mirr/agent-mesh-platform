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
    // Re-anchored when the query gained `WHERE deleted_at IS NULL`. The
    // manifest reported `not measured` rather than `caught`, which is the one
    // thing a stale entry must do — but the entry above it changed this line
    // in the same commit, so the pair is a reminder that editing a guarded line
    // means checking who else is holding on to it.
    from: "  const registered = agentsDb()",
    to: "  const registered = { n: 1 } as { n: number }; void agentsDb; if (false) agentsDb()",
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
    id: "agents-listing-drops-presence",
    defect:
      "`GET /api/v1/agents` answered five columns of the http server's own registry and none of the mesh's, so the console had no way to learn when an agent was last seen and drew `ONLINE` for everyone. The server knew — the heartbeat writes `agents.last_seen`, before the registry on a disconnect (SPEC § 3.1) — and the route did not carry it.",
    file: "packages/http/src/main.ts",
    from: "    last_seen_at: lastSeen.get(entry.id) ?? null,",
    to: "    last_seen_at: null,",
    suite: "test/http.test.ts",
    expect: ["carries what the mesh measured", "2026-01-02 03:04:05"],
  },
  {
    id: "agents-listing-invents-a-fingerprint",
    defect:
      "A synthesised `sha256:` key is the shape this repository removed from the front end twice: it reads as a measured identity and is a string built from the row's own id. Answering it from the server rather than the screen moves the invention one layer up.",
    file: "packages/http/src/main.ts",
    from: "    fingerprint: fingerprints.get(entry.id) ?? null,",
    to: "    fingerprint: `sha256:${entry.id}`,",
    suite: "test/http.test.ts",
    expect: ["says nothing rather than `offline`", "sha256:deadbeef"],
  },
  {
    id: "session-cookie-never-secure",
    defect:
      "A session cookie without `Secure` is sent over plain http as well, so a session issued behind TLS can still leave on a request that has none. The deployment terminates TLS in front, so the process only ever sees http and the proxy's header is the only evidence there was any.",
    file: "packages/http/src/main.ts",
    from: "  const secure = proto === 'https' ? '; Secure' : ''",
    to: "  const secure = ''",
    suite: "test/http.test.ts",
    expect: ["is marked Secure when the request arrived over TLS"],
  },
  {
    id: "session-cookie-always-secure",
    defect:
      "Unconditional `Secure` is worse than none here: a browser drops such a cookie arriving over http, so every local login stops working while the response still looks like a success. The failure is invisible from the server's side, which is why both halves are pinned.",
    file: "packages/http/src/main.ts",
    from: "  const secure = proto === 'https' ? '; Secure' : ''",
    to: "  const secure = '; Secure'",
    suite: "test/http.test.ts",
    expect: ["and is not, over plain http"],
  },
  {
    id: "temporary-password-said-twice",
    defect:
      "A password handed out once is only handed out once while no other route repeats it, and a route that repeats it breaks the property quietly — the test that the value works still passes. The listing is read back and searched for the exact string for that reason.",
    file: "packages/http/src/db.ts",
    from: "      `SELECT username, display_name, role, created_at,",
    to: "      `SELECT username, display_name, role, created_at, password_hash,",
    suite: "test/http.test.ts",
    expect: ["and never says it again", "the listing carried the hash"],
  },
  {
    id: "admitted-account-not-approved",
    defect:
      "`approved` is the gate for GitHub sign-in, where anybody may authenticate and a person decides who stays. An operator holding `user.admit` decided by creating the row, and no route exists to approve afterwards — so an admission that does not also approve produces an account that can never be used, and whose messages are refused by entitlement without saying so.",
    file: "packages/http/src/db.ts",
    from: "  upsertApprovedWebUser(input.username)",
    to: "  void input.username",
    suite: "test/http.test.ts",
    expect: ["can work once it has changed the password, without a second approval", "still refused after the change"],
  },
  {
    id: "admitted-account-not-flagged",
    defect:
      "An account admitted with a password nobody chose has to change it before doing anything else — that is the whole reason the password is temporary. Creating it unflagged leaves a working account on a password an operator read out loud.",
    file: "packages/http/src/db.ts",
    from: "    VALUES (?, ?, ?, ?, ?, 1)",
    to: "    VALUES (?, ?, ?, ?, ?, 0)",
    suite: "test/http.test.ts",
    expect: ["hands back a password nobody chose, and it works"],
  },
  {
    id: "login-response-omits-the-flag",
    defect:
      "The login handler's own comment says it returns the fields `/auth/me` answers with, so the two cannot describe the same user differently. The first-login flag was missing from it, which made that sentence false: a client reading the session it had just been handed finds no flag, takes the absence for `false`, and walks a locked account into a console that refuses every request.",
    file: "packages/http/src/main.ts",
    from: "        must_change_password: mustChangePassword(user.username),",
    to: "",
    suite: "test/http.test.ts",
    expect: ["is told so by the response that handed it the session", "the login response did not say the account is flagged"],
  },
  {
    id: "api-route-above-the-gate",
    defect:
      "Hono composes a request's handlers in registration order, so the password gate guards what is declared below it and nothing above. An `/api/v1` route added near the top of the file — a natural place to put one — is silently outside the gate, and every test of the gate still passes because they use routes that happen to sit below it.",
    file: "packages/http/src/main.ts",
    // A complete route, because a mutation that does not compile measures
    // nothing: the first version of this one broke the file, a hook died, and
    // the manifest answered `not measured` rather than pretending to a verdict.
    from: "app.post('/auth/logout', (c) => {",
    to: "app.get('/api/v1/gate-probe', (c) => c.json({ ok: true }))\napp.post('/auth/logout', (c) => {",
    suite: "test/http.test.ts",
    expect: ["covers every api route, which is a fact about where it is registered", "above the password gate"],
  },
  {
    id: "password-gate-only-redirects",
    defect:
      "A first-login password change enforced by the screen alone is decoration: the same cookie in `curl` reaches everything. That is the shape removed from four screens in this repository on the day this was written, and the front end declined to build against it until the server refused first.",
    file: "packages/http/src/main.ts",
    from: "  if (payload && mustChangePassword(payload.github_login)) {",
    to: "  if (false) {",
    suite: "test/http.test.ts",
    expect: ["is refused everywhere else, by the server and not by a redirect", "a flagged session reached a route it should not"],
  },
  {
    id: "password-gate-never-opens",
    defect:
      "A gate that refuses every session forever satisfies the test that it refuses one. The change has to let the session through, and the old password has to stop working — otherwise the change is a no-op that reports success.",
    file: "packages/http/src/db.ts",
    from: "    .prepare(`UPDATE local_users SET password_hash = ?, must_change_password = 0 WHERE username = ?`)",
    to: "    .prepare(`UPDATE local_users SET password_hash = password_hash, must_change_password = 1 WHERE username = ?`)",
    suite: "test/http.test.ts",
    expect: ["can change it, and is then let through"],
  },
  {
    id: "upgrade-leaves-the-default-unflagged",
    defect:
      "The seed marks the first-login flag inside the branch that runs only when no account exists, so a database written before the column never passes it. A deployment that upgraded rather than started fresh kept `admin`/`admin` with no gate — which is exactly what the decision was written to close, and was true of the standing stack when agent-mesh-local-pm signed in like a person and landed on the dashboard.",
    file: "packages/http/src/db.ts",
    from: "      if (await Bun.password.verify(initial, admin.password_hash)) {",
    to: "      if (false) {",
    suite: "test/misconfigured-boot.test.ts",
    expect: ["an account still on its initial password was left unflagged"],
  },
  {
    id: "upgrade-flags-a-chosen-password",
    defect:
      "Marking every existing account on upgrade locks out the operator who already chose a password, and satisfies the test that an unchanged one gets marked. The question the seed asks is whether the hash still verifies against the initial password, and answering it `true` for everybody is the same as not asking.",
    file: "packages/http/src/db.ts",
    from: "      if (await Bun.password.verify(initial, admin.password_hash)) {",
    to: "      if (true) {",
    suite: "test/misconfigured-boot.test.ts",
    expect: ["an account whose password was already changed was flagged anyway"],
  },
  {
    id: "admin-password-ignores-the-deployment",
    defect:
      "The seeded `admin` account took the password `admin` and nothing else could be stated. That is the quickstart's login and every test's, so it is right on the machine it was written for and a published password on any host others can reach — where the login form filled both boxes in for the visitor until the front end stopped doing it.",
    file: "packages/http/src/db.ts",
    from: "    const hash = await Bun.password.hash(supplied ?? 'admin', { algorithm: 'bcrypt' })",
    to: "    const hash = await Bun.password.hash('admin', { algorithm: 'bcrypt' })",
    suite: "test/misconfigured-boot.test.ts",
    expect: ["takes the deployment's password when it states one", "the stated password did not work"],
  },
  {
    id: "unit-runs-a-file-that-moved",
    defect:
      "A unit's `ExecStart` is resolved against `WorkingDirectory`, so it names a path in this repository — and a unit pointing at a file that moved fails on the host at deploy time, with the operator holding it. Two of these units have no other test at all, and fourteen scripts were deleted from this tree in one day.",
    file: "ops/systemd/agent-mesh-self-reminder-lab.service",
    from: "ExecStart=/home/ubuntu/.bun/bin/bun packages/self-reminder/src/main.ts",
    to: "ExecStart=/home/ubuntu/.bun/bin/bun packages/self-reminder/src/daemon.ts",
    suite: "test/misconfigured-boot.test.ts",
    expect: ["a unit runs a file this repository actually has", "which is not in this repository"],
  },
  {
    id: "env-file-made-optional-again",
    defect:
      "`EnvironmentFile=-path` is systemd's optional form: the file may be absent, the service starts anyway, and every variable in it takes a default. The http server refuses without `JWT_SECRET` and fails loudly; the hub starts on the default state directory and hands every client `http://127.0.0.1:3000` for attachment uploads — right on the quickstart's machine, wrong on the unit's, and not visible until an attachment fails for somebody else.",
    file: "ops/systemd/agent-mesh-hub-lab.service",
    from: "EnvironmentFile=/srv/agent-mesh-lab/env/shared/hub.env",
    to: "EnvironmentFile=-/srv/agent-mesh-lab/env/shared/hub.env",
    suite: "test/misconfigured-boot.test.ts",
    expect: ["a unit refuses to start without the env file it was given", "start the service on defaults"],
  },
  {
    id: "health-counts-the-torn-down",
    defect:
      "`/api/v1/health` counted every row in `agents`, including the soft-deleted ones every other reader filters out, so the one number an operator can get before authenticating only ever rose. Teardown answered `200 soft-deleted` and the count did not move. The route's own docstring says it answers *how many identities exist*, and a torn-down identity does not.",
    file: "packages/http/src/main.ts",
    from: "    .prepare('SELECT count(*) AS n FROM agents WHERE deleted_at IS NULL')",
    to: "    .prepare('SELECT count(*) AS n FROM agents')",
    suite: "test/http.test.ts",
    expect: ["falls when an identity is torn down", "the count did not fall"],
  },
  {
    id: "queue-total-left-to-the-caller",
    defect:
      "The route emitted per-identity rows and no total, so the console summed them itself over a field named `depth` that no route has ever emitted. Its `messages queued` tile read 0 for an idle mesh and 0 for a backed-up one, and 0 is the answer that looks calm.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ ok: true, mailboxes: rows, total_queued: total.n })",
    to: "  return c.json({ ok: true, mailboxes: rows })",
    suite: "test/mailbox-routes.test.ts",
    expect: ["counts the queue itself", "the route counts the queue so the caller does not have to"],
  },
  {
    id: "queue-column-renamed",
    defect:
      "A caller reads these columns by name, and a name it guesses wrong yields `undefined` — which arithmetic turns into a number rather than an error. That is exactly how `depth` became a queue total of zero.",
    file: "packages/http/src/main.ts",
    from: "           count(*) AS pending,",
    to: "           count(*) AS depth,",
    suite: "test/mailbox-routes.test.ts",
    expect: ["counts the queue itself, and names its columns"],
  },
  {
    id: "every-message-recorded-failed",
    defect:
      "`failed` and `pending` only mean something if both are reachable. The suite pinned the refused case alone, so a handler that recorded every message as failed passed it — and a comment in this file claimed the opposite mapping for long enough that the front end nearly labelled the console from it.",
    file: "packages/http/src/main.ts",
    from: "  if (!hubMessageId) {\n    msg.status = 'failed'",
    to: "  if (true) {\n    msg.status = 'failed'",
    suite: "test/message-status.test.ts",
    expect: ["is recorded as pending", "pending"],
  },
  {
    id: "pong-stops-counting-as-life",
    defect:
      "A pong is the only thing that distinguishes a live socket from a half-open one — `ws.ping()` returns 0 for both — so if answering stops clearing the awaiting flag the next sweep drops every healthy connection. The heartbeat had no manifest entry at all until the integration test that covered it was shortened from eight real sweeps to three, and this is the check that the shorter one still catches it.",
    file: "packages/hub/src/heartbeat.ts",
    from: "  alive(socket: Socket): void {\n    this.awaiting.delete(socket);\n  }",
    to: "  alive(socket: Socket): void {\n    void socket;\n  }",
    suite: "test/heartbeat.test.ts",
    expect: ["a peer that answers pings stays online across many sweeps", "the peer was dropped despite answering"],
  },
  {
    id: "nonce-sweep-unscheduled",
    defect:
      "`sweepExpired` is the only statement in the tree that deletes from `upload_nonces`, and nothing called it, so the table could only grow for the life of a deployment. Not dead code — a scheduled job with no schedule, whose symptom is a table nobody reads. The dead-code sweep that found it proposed deleting it.",
    file: "scripts/collect-orphan-blobs.ts",
    from: "  const swept = nonces.sweepExpired(openStore(\"agents\"));",
    to: "  const swept = 0;",
    suite: "test/orphans.test.ts",
    expect: ["an expired upload grant is swept", "swept 1 expired upload nonce"],
  },
  {
    id: "route-renames-a-field-callers-send",
    defect:
      "A route that renames the field it reads leaves every caller sending the old one, and the callers are told 201. This is the group-create silence from the server's side: nothing in the suite compares what a route reads against what anyone sends it.",
    file: "packages/http/src/main.ts",
    from: "  const toGroup = body?.to_group",
    to: "  const toGroup = body?.to_group_id",
    suite: "test/dropped-fields.test.ts",
    expect: ["no caller sends one", "to_group"],
  },
  {
    id: "looped-route-fields-reach-the-comparison",
    defect:
      "The three key decision routes are registered by one templated `app.post` inside a loop, so a scan for `app.post('` never saw them and every call to them went unchecked — which is how a fixture posting `{identity, public_key}` at a route reading `fingerprint` passed. Resolving the loop is not enough: the handler's fields have to reach the comparison, and writing out three registration lines with the body attached to the last one left two of them reading nothing.",
    file: "packages/http/src/main.ts",
    from: "    const reason = typeof body.reason === 'string' ? body.reason : null",
    to: "    const reason = null",
    suite: "test/dropped-fields.test.ts",
    expect: ["no caller sends one", "reason"],
  },
  {
    id: "group-create-refuse-unsupported",
    defect:
      "`POST /api/v1/admin/groups` read `group_id` and `description` and dropped every other field in silence. The front end's own fixture sent `members` and `name` for four months and was answered 201 each time, so its groups were empty — and the topology screen filled them by inventing members, which is why neither defect was visible while the other stood.",
    file: "packages/http/src/main.ts",
    from: "  if (unsupported.length > 0) {",
    to: "  if (false) {",
    suite: "test/group-create-fields.test.ts",
    expect: ["refuses `members`, and says where membership is written instead", "refuses `name`"],
  },
  {
    id: "group-create-field-list",
    defect:
      "Widening the accepted set restores the same silence with an allow-list in front of it: with `members` back in the set the body is accepted, nothing is written from it, and the caller is told 201 again.",
    file: "packages/http/src/main.ts",
    from: "const GROUP_CREATE_FIELDS = new Set(['group_id', 'description'])",
    to: "const GROUP_CREATE_FIELDS = new Set(['group_id', 'description', 'members', 'name'])",
    suite: "test/group-create-fields.test.ts",
    expect: ["refuses `members`, and says where membership is written instead", "refuses `name`"],
  },
  {
    id: "group-create-refuse-before-create",
    defect:
      "Refusing after the row is written is the same silence one step later: the caller is told 400 and the group exists anyway, so the retry meets a group it does not know it made. The refusal has to come before the write, not merely happen.",
    file: "packages/http/src/main.ts",
    from: "  const unsupported = Object.keys(body).filter",
    to: "  groupsStore.createGroup(db_(), { groupId, description: null, createdBy: actor }); const unsupported = Object.keys(body).filter",
    suite: "test/group-create-fields.test.ts",
    expect: ["creates nothing when it refuses", "not-created"],
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
    // Anchored on the family, never on its count. This entry held a copy of the
    // whole row — `… | 2 |` — and went unmeasurable the moment the count became
    // 3, which is a file the front end edits whenever it adds a scenario. The
    // manifest reported `not measured` rather than `caught`, which is the one
    // thing a stale entry must do, but a guard that expires on someone else's
    // ordinary work is a guard that spends its life expired.
    //
    // § 0 is read as the lines beginning with `|`, so breaking the line's start
    // removes the row exactly as deleting it did.
    from: "| `SC-HARNESS-*` |",
    to: "ROW REMOVED BY MUTATION | `SC-HARNESS-*` |",
    suite: "test/scenario-ids.test.ts",
    expect: ["every family with more than one id has a row", "SC-HARNESS-* has", "ids and no row in § 0"],
  },
  {
    id: "receipt-envelope",
    defect:
      "`POST /api/v1/messages` answers `{ ok, message: { id, from, to, ts, status } }` and the front end declared the flat shape, so `res.id` read off the envelope and came back `undefined` on every send. Each receipt field had a local fallback behind `||`, and the fallback is what the person saw every time: their own inputs, the browser\u2019s clock, and the literal `영수증 미발급` where the server\u2019s id belongs. The receipt agreed with itself and said nothing about the send.",
    file: "packages/platform-web/src/api/messages.ts",
    // The whole block, not its first line. Replacing only the assignment left
    // the `typeof message.id` throw standing below it, so the planted defect
    // threw exactly as the fixed code does and the entry was reported `not
    // caught` — the mutation had been neutralised by the half of the fix it did
    // not remove. Both hand-run mutations were right; this manifest is a
    // *re-typing* of them, and the re-typing is where it drifted.
    from: "  const message = body?.message;\n  if (!message || typeof message.id !== \"string\") {\n    throw new Error(NO_RECEIPT);\n  }\n  return message;",
    to: "  return body as unknown as MessageReceipt;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-05", "renders playground receipt with real server response fields", "expect(received).toBe(expected)"],
  },
  {
    id: "receipt-silent-flat",
    defect:
      "Unwrapping with `body.message ?? body` looks like the fix and reproduces the defect: on a `201` that carries no `message` the screen draws a receipt out of the envelope, every field `undefined`, next to a success. The throw is the point \u2014 falling back quietly is the state this issue was opened about.",
    // `??` differs from the throw *only* when the envelope is absent, which is
    // why the entry runs SC-WRITE-09 and not SC-WRITE-05. Planted against
    // SC-WRITE-05 it is not a mutation at all: `body.message` is present on the
    // success path, so `?? body` returns it and the suite is green for the
    // right reason. Measured twice before this comment was written.
    file: "packages/platform-web/src/api/messages.ts",
    from: "  const message = body?.message;\n  if (!message || typeof message.id !== \"string\") {\n    throw new Error(NO_RECEIPT);\n  }\n  return message;",
    to: "  return (body?.message ?? body) as MessageReceipt;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-09", "a 201 carrying no message drew a receipt instead of saying none came"],
  },
  {
    id: "receipt-digest-claim",
    defect:
      "The receipt card carried an `Ed25519 서명 검증됨` badge and a `SHA-256 다이제스트` box for fields no route on this platform sends \u2014 the same finding that removed `signature_verified` from the audit screen, left standing on the screen beside it. The badge was therefore always `서명 미검증` in red, and the digest box fell back to the *sender\u2019s* agent fingerprint, so a real sha256 sat under a label saying it was the digest of this message.",
    file: "packages/platform-web/src/components/messaging/ReceiptCard.tsx",
    from: "        </div>\n      </div>\n    </div>\n  );",
    to: "        </div>\n      </div>\n      <div>SHA-256 다이제스트</div>\n    </div>\n  );",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-05", "renders playground receipt with real server response fields", "\"digest\": true"],
  },
  {
    id: "scenario-id-twice",
    defect:
      "`scenario-ids.test.ts` said in prose that the case which must not happen is two different scenarios wearing one id, and then compared full titles \u2014 which two different scenarios never share. So the rule most likely to be believed was the one nothing checked, and the defect it names went in green: `SC-WRITE-07` was minted a second time for the playground receipt while it already named an RBAC grant abort. It was found by `-t SC-WRITE-07` running two tests.",
    file: "test/fe-render.test.ts",
    from: "it(\"[SC-WRITE-09] says 영수증 미발급",
    to: "it(\"[SC-WRITE-07] says 영수증 미발급",
    suite: "test/scenario-ids.test.ts",
    expect: ["one id on two `it(` lines is two scenarios that cannot disagree", "SC-WRITE-07 at fe-render.test.ts"],
  },
  {
    id: "mailbox-depth-name",
    defect:
      "`GET /api/v1/admin/mailbox` answers rows aliased `identity`, `pending`, `leased`, `oldest`. The front end declared `depth`, `unacked_count`, `oldest_message_ts` and `leased_count` — four names nothing on this platform sends — and summed `depth`, so the total was `0` on an idle mesh and on a backed-up one alike. The dashboard drew that `0` as the queue.",
    file: "packages/platform-web/src/api/mailbox.ts",
    // The route counts the total itself now, so the defect's shape is reading
    // the wrong name off the response rather than summing the wrong column.
    from: 'typeof data?.total_queued === "number" ? data.total_queued : null',
    to: 'typeof data?.depth === "number" ? data.depth : null',
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-03", "states the queue the mailbox route reported", "expect(received).toContain(expected)"],
  },
  {
    id: "queue-zero-for-unknown",
    defect:
      "`?? 0` on the queue card folded three states into one digit: an idle mesh, a backed-up one, and a route that never answered all read `0`. A person watching for a backlog cannot tell a quiet queue from a screen that failed to ask.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    // The card's expression appeared twice — once per panel — and `replace()`
    // with a string argument changes the first occurrence only. The entry
    // mutated the group panel's copy, which no session can reach, and reported
    // `not caught` while the operator's card kept the fix. The two panels share
    // one helper now, so one mutation reaches both and neither can regress in
    // silence.
    from: 'return total != null ? String(total) : "— 미측정";',
    to: "return String(total ?? 0);",
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-04", "a refused route was drawn as an empty queue"],
  },
  {
    id: "proxy-block-auth-nginx",
    defect:
      "The documented nginx block forwarded `/api/` and nothing else, and the front end signs in at `/auth/local` and restores its session from `/auth/me`. Those fell through to the SPA fallback, so nginx answered the login POST itself with `405 Not Allowed`. The page rendered, the assets loaded, and `/api/v1/health` answered through the proxy with the same body as the http server direct — every check this document printed passed, and nobody could log in.",
    file: "docs/running-locally.md",
    from: "  location /auth/ {",
    to: "  location /authXX/ {",
    suite: "test/readme.test.ts",
    expect: ["the nginx block does not forward a prefix the front end calls", "/auth"],
  },
  {
    id: "proxy-block-auth-caddy",
    defect:
      "The Caddy block had the same hole as the nginx one: `handle /api/*` and a `try_files` fallback for everything else, so signing in was served the SPA shell instead of being forwarded. Both blocks are printed for copying and only one of them being right is the same deployment failure.",
    file: "docs/running-locally.md",
    from: "  handle /auth/* {",
    to: "  handle /authXX/* {",
    suite: "test/readme.test.ts",
    expect: ["the caddy block does not forward a prefix the front end calls", "/auth"],
  },
  {
    id: "proxy-coverage-denominator",
    defect:
      "The check above compares the blocks against the paths the front end calls, and a hand-written list of prefixes would have said `/api` in exactly the way the blocks did. It reads them out of `packages/platform-web/src` instead — and an extraction that finds nothing agrees with any block at all, which is the shape this suite exists to refuse.",
    file: "test/readme.test.ts",
    from: 'if (path.startsWith("/api") || path.startsWith("/auth")) {',
    to: "if (false) {",
    suite: "test/readme.test.ts",
    expect: ["no /api or /auth call found in platform-web — the extraction broke"],
  },
  {
    id: "auth-unreachable-fold",
    defect:
      "`checkSession` caught every failure of `/auth/me` and recorded it as not being signed in — the comment on the branch said `// Not authenticated` while a proxy's `502` went down it too. On a deployment that means a backend restart signs every operator out. Measured with nginx in front of a built `dist`: all thirteen screens became the login form.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: 'setAuthFailure(err instanceof ApiError && err.refused ? "unauthenticated" : "unreachable");',
    to: 'setAuthFailure("unauthenticated");',
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-09", "a 502 from /auth/me was read as being signed out"],
  },
  {
    id: "auth-refused-fold",
    defect:
      "The other direction of the same split. A screen that called every failure unreachable would satisfy the scenario above and never sign anybody out again — the counter-case is what makes either half mean something.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: 'setAuthFailure(err instanceof ApiError && err.refused ? "unauthenticated" : "unreachable");',
    to: 'setAuthFailure("unreachable");',
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-11", "a 401 stopped being treated as a refused session"],
  },
  {
    id: "auth-unreachable-screen",
    defect:
      "Splitting the two states in the context is only half of it: the guard still has to draw the difference. Without this branch an unreachable backend falls through to the redirect and the person is sent to a login form served by the same proxy that cannot reach the thing it would log them into.",
    file: "packages/platform-web/src/components/common/GuardedRoute.tsx",
    from: 'if (!isAuthenticated && authFailure === "unreachable") {',
    to: "if (false) {",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-09", "a 502 from /auth/me was read as being signed out"],
  },
  {
    id: "login-silent-throw",
    defect:
      "`handleSubmit` had no `catch`, so `loginWithLocal` rejecting left through the handler, `navigate` never ran, and the form sat there having said nothing. With the backend down that is the only screen reachable, and pressing the button on it did nothing at all — no message, no change, silently.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "          {loginError && (",
    to: "          {false && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-10", "the login button did nothing and said nothing"],
  },
  {
    id: "proxy-block-phantom-route",
    defect:
      "The nginx block carried `proxy_buffering off` for `/api/v1/audit/stream`, a path that exists nowhere else in this repository — no route, no SPEC reference, no call from the front end. The one stanza written to keep a live view live protected nothing, and read as though it did. The three routes that actually stream answer with `X-Accel-Buffering: no`, which nginx acts on itself: measured through this block, a `key-proposed` event arrived 0.58s after the provisioning call against 0.55s with the proxy out of the path.",
    file: "docs/running-locally.md",
    from: "  location /api/ {",
    to: "  location /api/v1/audit/stream {\n    proxy_pass http://127.0.0.1:3000;\n    proxy_buffering off;\n  }\n\n  location /api/ {",
    suite: "test/readme.test.ts",
    expect: ["the nginx block configures a path the http server does not serve", "/api/v1/audit/stream"],
  },
  {
    id: "proxy-route-denominator",
    defect:
      "The check above compares the block against the routes `main.ts` declares, and an extraction that finds none agrees with any block at all — the same empty-set pass this file exists to refuse.",
    file: "test/readme.test.ts",
    from: "[...main.matchAll(/app\\.(?:get|post|put|patch|delete)\\(\\s*'([^']+)'/g)].map((m) => m[1]!),",
    to: "[] as string[],",
    suite: "test/readme.test.ts",
    expect: ["no routes read out of main.ts — the extraction broke"],
  },
  {
    id: "env-example-jwt-secret",
    defect:
      "`ops/env/shared/http.env.example` is the configuration an administrator copies, and it did not name `JWT_SECRET`. A stack started from exactly that set refuses to come up — correctly, since signing sessions with a default would let anyone who has read the source forge them — but about a variable nothing in the env layout told them to set. Measured.",
    file: "ops/env/shared/http.env.example",
    from: "JWT_SECRET=replace-me-with-a-long-random-string",
    to: "#JWT_SECRET=replace-me-with-a-long-random-string",
    suite: "test/readme.test.ts",
    expect: ["http.env.example cannot start the http as documented", "JWT_SECRET"],
  },
  {
    id: "env-example-blob-base",
    defect:
      "The same file set for the hub omitted `AGENT_MESH_BLOB_BASE_URL`, and unset it falls back to `http://127.0.0.1:3000`. Measured on a stack started from these files with the http server elsewhere: the hub advertised an upload address with nothing behind it. Nothing refuses — the first thing that disagrees is an attachment, later, for somebody else.",
    file: "ops/env/shared/hub.env.example",
    from: "AGENT_MESH_BLOB_BASE_URL=http://127.0.0.1:3200",
    to: "#AGENT_MESH_BLOB_BASE_URL=http://127.0.0.1:3200",
    suite: "test/readme.test.ts",
    expect: ["hub.env.example cannot start the hub as documented", "AGENT_MESH_BLOB_BASE_URL"],
  },
  {
    id: "env-example-denominator",
    defect:
      "The check above takes its list from the document's own start commands. A list written into the test would have been written from the same reading of the same files that produced the gap, and a block that stops matching makes it compare an empty set and agree with an env file naming nothing.",
    file: "test/readme.test.ts",
    from: ".filter((b) => b.includes(`bun packages/${service}/src/main.ts`));",
    to: ".filter(() => false);",
    suite: "test/readme.test.ts",
    expect: ["no start command found for the hub in running-locally.md"],
  },
  {
    id: "built-login-prefills",
    defect:
      "`SC-AUTH-06` reads the dev server and what a deployment serves is `dist`. A credential typed into the built login screen would satisfy every scenario in this repository and still ship — the same distinction `I-060` cost a night to find, where the production build called a host no dev run ever called.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: '  const [username, setUsername] = useState("");',
    to: '  const [username, setUsername] = useState("admin");',
    suite: "test/production-bundle.test.ts",
    expect: ["the built login screen still hands out an identity", '"typed": true'],
  },
  {
    id: "built-login-has-no-form",
    defect:
      "The reading is `nothing is typed in the boxes`, and a page with no boxes satisfies it. Both fields have to be found for the emptiness to be about a form somebody can sign in with.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: '              type="password"',
    to: '              type="hidden"',
    suite: "test/production-bundle.test.ts",
    expect: ["the built login screen still hands out an identity", '"boxes": false'],
  },
  {
    id: "login-prefills-a-credential",
    defect:
      "The login form arrived with `admin` typed into both fields, so one click signed anybody who reached the page in as the platform administrator. In a lab that is convenience; on a deployment it is the account name and the password printed on the login screen. The same half-measure as the 시뮬레이션 역할 picker: neither raised a privilege, and both handed out an identity nobody proved they had.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: '  const [username, setUsername] = useState("");',
    to: '  const [username, setUsername] = useState("admin");',
    suite: "test/fe-render.test.ts",
    expect: ["SC-AUTH-06", "the login screen still lets a person pick or be handed what they are"],
  },
  {
    id: "login-placeholder-names-the-account",
    defect:
      "The weaker version of the same thing: with the prefill gone, the username field's placeholder still read `admin`, so the screen went on printing the account name to anyone who loaded it.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: '              placeholder="아이디"',
    to: '              placeholder="admin"',
    suite: "test/fe-render.test.ts",
    expect: ["SC-AUTH-06", "the login screen still lets a person pick or be handed what they are"],
  },
  {
    id: "pwchg-guard-does-not-send",
    defect:
      "The server answers `403 { must_change_password: true }` to every route but three while a first login still holds the password it was seeded with. Without the redirect the person lands on a dashboard where every panel is a refusal and nothing says why.",
    file: "packages/platform-web/src/components/common/GuardedRoute.tsx",
    from: "  if (mustChangePassword === true) {",
    to: "  if (false) {",
    suite: "test/fe-render.test.ts",
    expect: ["SC-PWCHG-01", "a first login was left somewhere other than the change screen"],
  },
  {
    id: "pwchg-never-releases",
    defect:
      "The other half: a screen that sends everybody to the change form and never lets go satisfies the redirect check completely. Reading the URL right after `navigate` is not enough either — `/dashboard` is in the bar for an instant before the guard sends it back, and this mutation passed until the check waited for the change screen to be gone.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: "      const me = await fetchAuthMe();\n      setMustChangePassword(me.must_change_password === true);\n    } catch {\n      setMustChangePassword(null);\n    }\n  };\n\n  const loginWithLocal",
    to: "      const me = await fetchAuthMe();\n      setMustChangePassword(true);\n    } catch {\n      setMustChangePassword(null);\n    }\n  };\n\n  const loginWithLocal",
    suite: "test/fe-render.test.ts",
    expect: ["SC-PWCHG-01", "changing the password did not open the product"],
  },
  {
    id: "pwchg-form-says-nothing",
    defect:
      "A wrong `current` answers `403` and the form has to say so. Silence here is the shape this suite removed from the login form the same day: the button is pressed, nothing happens, and nothing explains it.",
    file: "packages/platform-web/src/pages/ChangePasswordPage.tsx",
    from: "        {error && (",
    to: "        {false && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-PWCHG-03", "the change button did nothing and said nothing"],
  },
  {
    id: "axis-pattern-cannot-see-digits",
    defect:
      "The axis table's family pattern was `SC-[A-Z-]+`, which cannot match a family with a digit in its name. `SC-I18N-*` was the first, and its row was in the table the whole time — the check simply did not see it, so the family read as declared nowhere and its ids as unaccounted. The same pattern was written twice, so widening one of them left the other blind. It is the blindness this file already records twice: a pattern written from the ids in front of the author.",
    file: "test/scenario-ids.test.ts",
    from: "    const rows = [...doc.matchAll(/^\\| `(SC-[A-Z0-9-]+)-\\*` \\|[^|]*\\| ([0-9]+) \\|$/gm)];",
    to: "    const rows = [...doc.matchAll(/^\\| `(SC-[A-Z-]+)-\\*` \\|[^|]*\\| ([0-9]+) \\|$/gm)];",
    suite: "test/scenario-ids.test.ts",
    expect: ["has 2 ids and no row in § 0", "SC-I18N"],
  },
  {
    id: "landing-combo-is-two-buttons",
    defect:
      "A panel that is always open is two buttons wearing a combo. The switcher matches the sidebar's idiom — trigger, panel, a check on the active one — because a screen that invents a second idiom for the same job teaches the reader that they are different jobs.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "        {langOpen && (",
    to: "        {true && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-I18N-02", "the menu was open before anything was pressed"],
  },
  {
    id: "change-screen-not-translated",
    defect:
      "The landing screen defaults to English and the change screen is the next thing a first login sees. It was Korean literals with no dictionary entry — the same gap the login page had, one screen further in, and it would have shipped as an English product whose second screen is not.",
    file: "packages/platform-web/src/pages/ChangePasswordPage.tsx",
    from: '{t("pwchg.title", "Choose a password")}',
    to: "비밀번호를 바꿔야 합니다",
    suite: "test/fe-render.test.ts",
    expect: ["SC-PWCHG-05", "the change screen is not in the language the product defaults to"],
  },
  {
    id: "one-key-two-meanings",
    defect:
      "Seven keys were called with different fallbacks at different call sites — `common.errorLoad` meant both `불러오지 못함` and `조직 정보 불러오지 못함`. Defining such a key makes one of them win everywhere, so adding the missing entries changed wording on screens nobody was touching and timed out a scenario waiting for the older text. A key whose meaning depends on the call site is not a translation key.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: 't("dash.tenants.errorLoad", "Could not load tenants")',
    to: 't("common.errorLoad", "조직 정보 불러오지 못함")',
    suite: "test/fe-scenarios.test.ts",
    expect: ["one key is asked to mean two things", "common.errorLoad"],
  },
  {
    id: "key-defined-nowhere-falls-back-to-korean",
    defect:
      "`t(key, fallback)` returns the fallback when the key is defined nowhere, and every fallback in this front end is Korean — so an English reader saw Korean through the translation function itself, on seventeen call sites including `common.loading` and `common.manage`, which appear on nearly every screen. The dictionary symmetry check stayed green throughout, because the missing keys were missing from both sides.",
    file: "packages/platform-web/src/contexts/I18nContext.tsx",
    from: '    "common.loading": "Loading…",\n',
    to: "",
    suite: "test/fe-scenarios.test.ts",
    expect: ["a screen falls back to Korean because its key is defined nowhere", "common.loading"],
  },
  {
    id: "i18n-callsite-denominator",
    defect:
      "The check reads the call sites out of `platform-web` and compares them against the English dictionary. With nothing collected it agrees with any dictionary at all — which is precisely how the older symmetry check managed to be green while seventeen screens fell back to Korean.",
    file: "test/fe-scenarios.test.ts",
    from: '    walk("packages/platform-web/src");',
    to: "    // walk disabled",
    suite: "test/fe-scenarios.test.ts",
    expect: ["no translated call sites found — the pattern went stale"],
  },
  {
    id: "operator-table-invites-a-first-agent-after-a-refusal",
    defect:
      "The cards say `—` and the table below them says \"no agents are registered to you yet — register one\". The friendlier voice makes the same claim, and a person acts on the table rather than on the dash.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: '              data-testid={isError ? "operator-agents-unreachable" : "operator-agents-empty"}',
    to: '              data-testid="operator-agents-empty"',
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-13", "drew 0 for a read that was refused"],
  },
  {
    id: "scenario-waits-for-a-sentence-nobody-says",
    defect:
      "A copy landmark left behind by a rename. The scenario waits thirty seconds and then every scenario after it reports `Target page, context or browser has been closed` — the suite reads as a crash, and twice this was nearly filed as contention on an idle machine.",
    file: "test/fe-render.test.ts",
    // **조각이 트리에 남아 있으면 안 잡힌다** — 첫 판이 `불러올` 로 바꿨는데 다른 화면이
    // 아직 그 낱말을 쓰고 있어 통과했다. 트리 어디에도 없는 낱말로 바꾼다.
    from: 'await shows(page, "그룹 목록을 불러오지 못했습니다");',
    to: 'await shows(page, "그룹 목록을 가져오지 못했습니다");',
    suite: "test/scenario-ids.test.ts",
    expect: ["copy landmarks", "waits for a sentence no screen contains"],
  },
  {
    id: "panel-heading-contradicts-its-own-body",
    defect:
      "The heading said `(unreachable)` while the message under it named the capability — one screen, two answers about the same request. Whichever a person reads first is the one they act on.",
    file: "packages/platform-web/src/pages/creator/RegisterAgentPage.tsx",
    from: 'isError ? (failure === "refused" ? `(${t("common.refused", "권한 없음")})` : t("common.unreachable", "(통신 불가)"))',
    to: 'isError ? t("common.unreachable", "(통신 불가)")',
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-07", "a refusal was drawn as silence"],
  },
  {
    id: "shared-dialog-warns-in-one-language",
    defect:
      "The warning on an irreversible action, in a language the session did not ask for. The modal's own strings went through the dictionary and the shared dialog's did not, so an English reader saw an English title over a Korean warning and a Korean confirmation prompt.",
    file: "packages/platform-web/src/components/feedback/ConfirmDialog.tsx",
    from: '⚠️ {t("confirm.irreversible", "이 작업은 되돌릴 수 없습니다.")}',
    to: "⚠️ 이 작업은 되돌릴 수 없습니다.",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-08", "not in the session's language"],
  },
  {
    id: "lease-screen-counts-rows-not-messages",
    defect:
      "One mailbox holding eleven messages drawn as one waiting message. The route answers a summary per mailbox; counting rows turns a backlog into a single item, and the number is plausible enough that nobody re-reads it.",
    file: "packages/platform-web/src/pages/creator/LeaseQueuePage.tsx",
    from: "  const availableCount = queue.reduce((n, m) => n + m.pending, 0);",
    to: "  const availableCount = queue.length;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-06", "counted its rows"],
  },
  {
    id: "lease-screen-invents-a-message-id",
    defect:
      "`msg_mb_1` — an identifier for a message the server never sent, on a screen whose subject is messages. An operator reading it believes there is a message with that id.",
    file: "packages/platform-web/src/pages/creator/LeaseQueuePage.tsx",
    from: "          📥 {item.identity}",
    to: "          📥 msg_mb_1 · {item.identity}",
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-06", "drew a message id the server never sent"],
  },
  {
    id: "refusal-drops-the-capability-on-the-screen-that-lacks-it",
    defect:
      "The refusal without the name, seen by the session that actually lacks the capability. `SC-CAP-07` fulfills a 403 to test this; here the server issues it, so the screen and the mesh have to agree about which capability is missing.",
    file: "packages/platform-web/src/api/client.ts",
    from: "  return capability ? `${base} (${capability}).` : `${base}.`;",
    to: "  return `${base}.`;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-09", "told silence where the server refused"],
  },
  {
    id: "audit-screen-shows-bodies-to-a-metadata-holder",
    defect:
      "§ 11.0's privacy boundary drawn from a constant instead of the grant. A session holding `audit.read.metadata` would read every message body, and the screen's own subtitle would still promise the redaction.",
    file: "packages/platform-web/src/pages/tenant/AuditLogsPage.tsx",
    from: '  const canReadContent = hasCapability("audit.read.content");',
    to: "  const canReadContent = true;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-09", "the session was refused on the screen it holds"],
  },
  {
    id: "teardown-offered-to-a-session-that-cannot-use-it",
    defect:
      "An irreversible control drawn for everybody. Measured with a member holding nothing: the modal opened on the `admin` identity, took the typed confirmation, and the server refused at the last step — honest, and a person had still been walked all the way there.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: "          {canTeardown && (",
    to: "          {true && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-08", "offered to a session that cannot use it"],
  },
  {
    id: "teardown-hidden-from-everybody",
    defect:
      "The other way to pass: hide it from every session, including the one the server gave `agent.teardown`. A console where nothing dangerous is possible also cannot do the job.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: "          {canTeardown && (",
    to: "          {false && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-08", "or to nobody at all"],
  },
  {
    id: "admission-route-points-somewhere-unchecked",
    defect:
      "The four admission screens are named in `SC-I18N-04` by a path somebody typed. Pointing a route at a different component leaves that list holding the old files to zero while the screen a person actually sees drifts — and every check stays green.",
    file: "packages/platform-web/src/App.tsx",
    from: "                    <UserAdminPage />",
    to: "                    <TenantTrafficPage />",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-04", "points at a file this check does not hold to zero"],
  },
  {
    id: "client-drops-the-capability-the-server-named",
    defect:
      "§ 11.3's refusal carries `capability` as a field so a client does not parse it out of a sentence. Dropping it sends every screen back to the name typed into its own copy — nine guesses that were right on the day they were written.",
    file: "packages/platform-web/src/api/client.ts",
    from: '      typeof errorData.capability === "string" ? errorData.capability : null,',
    to: "      null,",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-07", "a refusal was drawn as silence"],
  },
  {
    id: "users-blames-permission-when-the-server-is-gone",
    defect:
      "The rendering half of the same mistake: the screen still asks which kind of failure it was and then draws the permission sentence either way. It reads as the more careful message and sends somebody to request a capability that would not have helped.",
    file: "packages/platform-web/src/pages/platform/UserAdminPage.tsx",
    from: '          failure === "refused"',
    to: "          true",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-07", "silence was drawn as a permission problem"],
  },
  {
    id: "refusal-drawn-as-silence",
    defect:
      "One message for both: the server answered `403` and the screen said it did not answer. A person then waits for a backend that is up, instead of asking for the capability they are missing.",
    file: "packages/platform-web/src/pages/creator/RegisterAgentPage.tsx",
    from: `            failure === "refused"
              ? t("reg.queue.refused", "이 계정은 등록 요청 큐를 볼 권한이 없습니다 (key.approve).")
              : t("reg.queue.error", "대기 중인 등록 요청 큐를 불러올 수 없습니다 (서버 연결 실패).")`,
    to: '            t("reg.queue.error", "대기 중인 등록 요청 큐를 불러올 수 없습니다 (서버 연결 실패).")',
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-07", "a refusal was drawn as silence"],
  },
  {
    id: "silence-drawn-as-a-refusal",
    defect:
      "The other direction: a screen that blames the viewer's permissions when the backend is simply gone. It reads as the more careful message and sends somebody to ask for a capability that would not help.",
    file: "packages/platform-web/src/pages/platform/UserAdminPage.tsx",
    from: "      setFailure(failureKind(err));",
    to: '      setFailure("refused");',
    suite: "test/fe-render.test.ts",
    // Caught by the rule rather than the case: dropping `failureKind` is what a
    // screen looks like when it decides the answer itself, and the source half
    // names it before the browser half gets there.
    expect: ["SC-CAP-07", "without recording which kind of failure it was"],
  },
  {
    id: "member-panel-answers-zero-while-waiting",
    defect:
      "`agents` starts empty and the card reads its length, so on a slow link the panel says \"Agents 0 registered\" and then jumps to fourteen. The window is short on a fast machine and is the whole experience on a bad connection.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: '          value={isLoading ? "..." : isError ? "—" : String(agents.length)}',
    to: '          value={isError ? "—" : String(agents.length)}',
    suite: "test/fe-render.test.ts",
    expect: ["SC-LOAD-06", "answered 0 before the answer arrived"],
  },
  {
    id: "member-panel-never-stops-waiting",
    defect:
      "The other direction: a panel that stays on \"...\" forever looks patient and says nothing. One assertion catching only the first direction passes on it.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "      .finally(() => setIsLoading(false));",
    to: "      .finally(() => {});",
    suite: "test/fe-render.test.ts",
    expect: ["SC-LOAD-06", "never stopped waiting"],
  },
  {
    id: "count-answered-from-another-table",
    defect:
      "`health?.agent_count ?? agentList.length` — mesh identities that are alive, or rows in this server's chat registry, whichever answered. Neither set contains the other (12 against 13 when this was written), so the number under the label changes quantity when a route stops answering and nothing says it did.",
    file: "packages/platform-web/src/api/telemetry.ts",
    from: "  const totalAgents = health?.agent_count ?? null",
    to: "  const totalAgents = health?.agent_count ?? agentList.length",
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-05", "answered from another table"],
  },
  {
    id: "screen-calls-the-registry-the-viewers-own",
    defect:
      "`GET /api/v1/agents` hands a member with no capability the whole registry — measured, identical to the platform admin's twelve rows. Calling that list \"My Agents\" tells a person twelve identities are theirs, including other people's.",
    file: "packages/platform-web/src/contexts/I18nContext.tsx",
    from: '    "agents.title": "에이전트 레지스트리",',
    to: '    "agents.title": "내 에이전트 관리",',
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-06", "under a heading that calls it the viewer's own"],
  },
  {
    id: "telemetry-panel-vanishes-without-a-word",
    defect:
      "A monitoring panel that disappears when its source refuses. Nothing false is claimed, which is why it survived: the page just gets shorter, and an operator watching for refusals sees a screen with no refusals on it.",
    file: "packages/platform-web/src/pages/platform/TelemetryPage.tsx",
    from: "          {!telemetry.behaviour && (",
    to: "          {false && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-14", "vanished without a word"],
  },
  {
    id: "telemetry-panel-always-claims-unreachable",
    defect:
      "The other direction: a screen that says the source did not answer while it is answering. The same assertion has to hold both ways, or a permanently pessimistic panel passes.",
    file: "packages/platform-web/src/pages/platform/TelemetryPage.tsx",
    from: "          {!telemetry.behaviour && (",
    to: "          {true && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-14", "claims to be unreachable while the route answers"],
  },
  {
    id: "member-dashboard-draws-zero-for-a-refusal",
    defect:
      "The panel an ordinary account lands on, telling them they own nothing when the read was refused. The platform admin's panel has said `—` for months; this one drew `0`, and every existing SC-DOWN scenario measures the admin's.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: `          value={isError ? "—" : String(agents.length)}
          subValue={isError ? t("common.errorLoad", "불러오지 못함") : t("dash.kpi.agentsSub", "개 등록됨")}`,
    to: `          value={String(agents.length)}
          subValue={t("dash.kpi.agentsSub", "개 등록됨")}`,
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-13", "drew 0 for a read that was refused"],
  },
  {
    id: "catch-empties-a-list-and-says-nothing",
    defect:
      "The shape itself, on any screen: `.catch(() => setX([]))`. It is one line, it reads as defensive, and it converts *the server did not answer* into *there is nothing* — the source rule exists because three panels carried it and only one was ever measured.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: `      .catch(() => {
        setAgents([]);
        setIsError(true);
      });`,
    to: "      .catch(() => setAgents([]));",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-13", "nothing records that it failed"],
  },
  {
    id: "bell-calls-a-refusal-an-unanswered-question",
    defect:
      "The bell saying \"could not ask\" when the server answered `403`. Found by walking the console as a session holding one capability — the middle role nothing had measured, between the platform admin and an account holding nothing.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: '                {failure === "refused"',
    to: "                {false",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-12", "reported an unanswered question as an answer"],
  },
  {
    id: "bell-calls-an-unanswered-question-an-answer",
    defect:
      "`.catch(() => setRequests([]))` — an empty list draws \"no requests are waiting\", which is a sentence about the server's answer written when there was no answer. An operator sees a quiet bell while agents wait to be admitted, and nothing else on any screen mentions it.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: `      .catch(() => {
        setRequests([]);
        setUnreachable(true);
      });`,
    to: "      .catch(() => setRequests([]));",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-12", "reported an unanswered question as an answer"],
  },
  {
    id: "bell-calls-every-answer-unanswered",
    defect:
      "The other direction, which the same check has to hold: a bell stuck on \"could not ask\" tells an operator nothing and looks exactly like caution. One assertion catching only the first direction would pass on it.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "  const [unreachable, setUnreachable] = useState(false);",
    to: "  const [unreachable, setUnreachable] = useState(true);",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-12", "reports every answer as unanswered"],
  },
  {
    id: "logout-leaves-the-cookie",
    defect:
      "Signing out that ends nothing. The browser goes to `/login`, `mesh_token` stays set, and the next person to type `/dashboard` on that machine is inside the previous session. It looks correct from the seat of the person who clicked.",
    file: "packages/http/src/main.ts",
    from: "    headers: { 'content-type': 'application/json', 'Set-Cookie': sessionCookie(c, '', 0) },",
    to: "    headers: { 'content-type': 'application/json' },",
    suite: "test/fe-render.test.ts",
    expect: ["SC-AUTH-07", "signing out left the session usable"],
  },
  {
    id: "client-signs-out-without-telling-the-server",
    defect:
      "The client clearing its own state and leaving the cookie — the exact shape this repository shipped until now. The redirect makes it look finished, and every check that reads the URL agrees.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: '    void apiClient("/auth/logout", { method: "POST" }).catch(() => {});',
    to: "    // (nothing)",
    suite: "test/fe-render.test.ts",
    expect: ["SC-AUTH-07", "signing out left the session usable"],
  },
  {
    id: "ratchet-lets-a-screen-slip-back",
    defect:
      "A string put back into a component rather than the dictionary, on a screen outside the admission path. The flow check does not look there, so the only thing standing between this and English-mode Korean is the count — which is exactly what a ratchet is for.",
    file: "packages/platform-web/src/pages/creator/RegisterAgentPage.tsx",
    from: 'header: t("reg.col.status", "승인 상태"),',
    to: 'header: "승인 상태",',
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-04", "untranslated strings, up from"],
  },
  {
    id: "korean-straight-into-a-screen",
    defect:
      "A string written into a component instead of the dictionary. It renders in Korean with the language set to English, and neither dictionary check sees it: `SC-I18N-01` compares two dictionaries and `SC-I18N-03` checks keys that exist. Text between tags is the shape that walked through the first version of this guard.",
    file: "packages/platform-web/src/pages/platform/UserAdminPage.tsx",
    from: '          {t("users.issued.for", "Temporary password for")} {issued.username}',
    to: "          임시 비밀번호 — {issued.username}",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-04", "a screen on the admission path holds Korean the dictionary never saw"],
  },
  {
    id: "english-dictionary-answers-in-korean",
    defect:
      "An `en` value that is Korean. Every source-layer check is blind to this by construction: `SC-I18N-04` skips `I18nContext` because that file is where Korean belongs, and `SC-I18N-01` compares the two dictionaries by key, not by value. The screen draws Korean with the language set to English and nothing in the tree looks wrong \u2014 which is the shape that made a browser necessary.",
    file: "packages/platform-web/src/contexts/I18nContext.tsx",
    from: "    \"overview.nodes\": \"Service nodes\",",
    to: "    \"overview.nodes\": \"가동 중인 서비스 노드\",",
    suite: "test/fe-render.test.ts",
    expect: ["SC-I18N-05", "drew Korean it wrote itself"],
  },
  {
    id: "korean-hidden-behind-a-glob",
    defect:
      "Korean text between tags in `PlatformOverviewPage`, below `endpoint: \"/api/v1/*\"`. That string opened a block comment for the regex this check used to strip comments with, and the next `*/` was 113 lines later \u2014 so a hundred lines of that file, this one among them, were not in the denominator. The count read zero while a browser with the language set to English drew `개` on `/platform`.",
    file: "packages/platform-web/src/pages/platform/PlatformOverviewPage.tsx",
    from: "          {item.activeSockets}",
    to: "          {item.activeSockets}개",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-04", "untranslated strings or lines, up from"],
  },
  {
    id: "korean-jsx-outside-the-flow",
    defect:
      "A sentence written as text between tags, on a screen that is not on the admission path. The flow check does not read this file, and the count that does used to read string literals only \u2014 so twenty-two of these were invisible while the ratchet said zero, and a browser with the language set to English drew Korean on four screens.",
    file: "packages/platform-web/src/components/feedback/AclMatrix.tsx",
    from: "              {t(\"acl.axis\", \"출발 \\\\ 도착 (Source → Target)\")}",
    to: "              출발 \\\\ 도착 (Source → Target)",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-04", "untranslated strings or lines, up from"],
  },
  {
    id: "client-appends-a-title-nobody-granted",
    defect:
      "`admin (운영자)` in the sidebar of every screen — the client decorating what the server returned. Two defects in one string: a Korean noun that no dictionary carries, and a role the server never said.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: "              name: me.github_login,",
    to: "              name: `${me.github_login} (운영자)`,",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-04", "a screen on the admission path holds Korean the dictionary never saw"],
  },
  {
    id: "issued-password-survives-a-reload",
    defect:
      "Keeping the one-time password somewhere a reload can find it. The screen looks the same and the word `once` becomes false — and the place it would be kept, `localStorage`, is readable by anything else running on the origin.",
    file: "packages/platform-web/src/pages/platform/UserAdminPage.tsx",
    from: "  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);",
    to: `  const [issuedKept, setIssuedKept] = useState<{ username: string; password: string } | null>(
    () => JSON.parse(localStorage.getItem("agent_mesh_issued") ?? "null"),
  );
  const issued = issuedKept;
  const setIssued = (v: { username: string; password: string } | null) => {
    localStorage.setItem("agent_mesh_issued", JSON.stringify(v));
    setIssuedKept(v);
  };`,
    suite: "test/fe-render.test.ts",
    expect: ["SC-USER-D1", "kept it across a reload"],
  },
  {
    id: "admit-screen-composes-its-own-refusal",
    defect:
      "A friendlier sentence than the server's. The duplicate-name case says which name is taken; a screen that replaces it sends somebody to guess, and the same replacement hides every other refusal the route can give.",
    file: "packages/platform-web/src/pages/platform/UserAdminPage.tsx",
    from: "          : String(err?.message ?? err),",
    to: '          : "That did not work. Please try a different username.",',
    suite: "test/fe-render.test.ts",
    expect: ["SC-USER-D2", "the screen invented a refusal, or claimed success on one"],
  },
  {
    id: "rbac-invents-the-role-column",
    defect:
      "The screen writing somebody's role itself. `I-055` and `I-077` are this sentence about other fields; here it printed \"Operator\" beside every subject that was not literally `admin`, including agent ids the server holds no account for.",
    file: "packages/platform-web/src/pages/tenant/RbacManagementPage.tsx",
    from: '{rolesBySubject === null ? "\\u2014" : (rolesBySubject[item.id] ?? "\\u2014")}',
    to: '{item.id === "admin" ? "Platform Admin" : "Operator"}',
    suite: "test/fe-render.test.ts",
    expect: ["SC-USER-D3", "the screen drew a capability axis or a role that the server did not give it"],
  },
  {
    id: "rbac-invents-the-capability-axis",
    defect:
      "A capability list written into the client goes stale silently: the platform gains a capability, every table keeps its old columns, and the screen agrees with itself forever.",
    file: "packages/platform-web/src/pages/tenant/RbacManagementPage.tsx",
    from: "      setAvailableCaps(caps);",
    to: '      setAvailableCaps(caps.length ? ["group.manage", "audit.read.metadata"] : [])',
    suite: "test/fe-render.test.ts",
    expect: ["SC-USER-D3", "the screen drew a capability axis or a role that the server did not give it"],
  },
  {
    id: "password-gate-lets-everybody-through",
    defect:
      "The gate is one `if` in one middleware, and deleting it is silent: every route still answers, the account still holds no capabilities, and the only visible change is that somebody who was handed a temporary password can go on using it forever.",
    file: "packages/http/src/main.ts",
    from: "  if (payload && mustChangePassword(payload.github_login)) {",
    to: "  if (false && payload && mustChangePassword(payload.github_login)) {",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-USER-B3", "the password gate did not hold, or did not lift once the password was chosen"],
  },
  {
    id: "auth-me-tells-everyone-they-hold-nothing",
    defect:
      "`capabilities: []` for everybody passes any check that only asserts a fresh account is empty. A server that has lost the ability to say yes reads exactly like a server enforcing a rule, and the screen greys out every control for the platform admin too.",
    file: "packages/http/src/main.ts",
    from: `    capabilities: grants
      .listFor(agentsDb(), user.github_login)`,
    to: `    capabilities: ([] as string[])
      .concat(grants.listFor(agentsDb(), 'nobody-at-all').map((g) => g.capability))`,
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-USER-B4", "nobody holds anything and nobody reaches anything"],
  },
  {
    id: "user-listing-carries-the-secret",
    defect:
      "A person is admitted with one password, once, and the listing is where `once` stops being true. Nothing else in this suite notices a listing that carries password material — the creation response is the only place it is supposed to appear.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ ok: true, users: listLocalUsers() })",
    to: '  return c.json({ ok: true, users: listLocalUsers().map((u: any) => ({ ...u, password_hash: "x" })) })',
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-USER-B1", "the listing carries the password it was supposed to show once"],
  },
  {
    id: "refusal-does-not-name-the-capability",
    defect:
      "`403` without the capability's name sends an operator to guess which of twelve they are missing. The refusal has said so since § 11 and it is worth a check, because the sentence that names it is the easiest thing to drop while keeping the status.",
    file: "packages/http/src/main.ts",
    from: "return c.json({ error: `Missing capability: ${capability}`, capability, scope }, 403)",
    to: "return c.json({ error: 'Forbidden' }, 403)",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-USER-B2", "a refusal that does not name what is missing sends somebody to guess"],
  },
  {
    id: "landing-defaults-to-korean",
    defect:
      "The default language was Korean and the toggle lived in the sidebar, which is behind the login. A visitor who could not read the login form could not reach the control that would have translated it.",
    file: "packages/platform-web/src/contexts/I18nContext.tsx",
    from: '      return (saved === "en" || saved === "ko") ? saved : "en";',
    to: '      return (saved === "en" || saved === "ko") ? saved : "ko";',
    suite: "test/fe-render.test.ts",
    expect: ["SC-I18N-02", "the landing screen is not in English, or has no way to change that"],
  },
  {
    id: "landing-toggle-does-nothing",
    defect:
      "A flag in the corner that does not change the page is a control that looks like it works — the same shape as a guard that guards nothing, which is the thing this suite spends its time removing. Rendering English and offering a switch satisfies `the default is English` completely without the switch ever having to work.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "                  setLanguage(lang);",
    to: "                  void lang;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-I18N-02", "the flag was pressed and the page did not change"],
  },
  {
    id: "login-picks-its-own-role",
    defect:
      "The login screen offered a `<select>` labelled 시뮬레이션 역할 whose top option read 👑 플랫폼 관리자, and passed the choice to `loginWithLocal`. It granted nothing — `GuardedRoute` and the sidebar both ask `hasCapability`, and `POST /auth/local` reads only the username and password — but the sidebar drew the choice as the person's title, so a deployment to a real server showed a self-declared platform administrator.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "          {loginError && (",
    to: "          <div>\n            <label style={labelStyle}>시뮬레이션 역할 (RBAC Role)</label>\n            <select style={inputStyle}><option>👑 플랫폼 관리자 (Platform Admin - 전체 메뉴)</option></select>\n          </div>\n\n          {loginError && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-AUTH-06", "the login screen still lets a person pick what they are"],
  },
  {
    id: "login-stops-signing-in",
    defect:
      "The other half. A login screen with no role picker that also signed nobody in would satisfy a check for the picker's absence, and that check is the one this change invites somebody to write.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "      await loginWithLocal(username, password);",
    to: '      if (true) { setLoginError("차단"); return; }\n      await loginWithLocal(username, password);',
    // **Pinned on SC-ACT-01, not on SC-AUTH-06's own half.** Running the whole
    // file, `SC-ACT-01` signs in long before SC-AUTH-06 does, fails at its
    // `waitForURL`, and takes the browser context down with it — every later
    // scenario then dies on `Target page, context or browser has been closed`,
    // SC-AUTH-06 included. So the sentence this entry can honestly wait for is
    // the earlier scenario's.
    //
    // A third reason for `not caught` that is not the check being weak: not a
    // bad anchor, not a mutation that changes nothing, but **another check
    // firing first and ending the run**. SC-AUTH-06 keeps its second assertion
    // regardless — it is what makes that scenario mean something on its own.
    suite: "test/fe-render.test.ts",
    expect: ["SC-ACT-01", "performs interactive login form submission"],
  },
  {
    id: "doc-quotes-a-line-nothing-prints",
    defect:
      "§ 5 quoted `[db] seeded default admin local user` after `651597e` replaced it with two lines that say *which password was used*. Quoted output is the part of a document a reader compares against their own terminal, so a reader who does not see it has no way to tell a defect from a version skew — and here the line they would miss is the warning that the deployment is running on the published default.",
    file: "docs/running-locally.md",
    from: "[db] seeded admin local user with AGENT_MESH_ADMIN_PASSWORD",
    to: "[db] seeded default admin local user",
    suite: "test/readme.test.ts",
    expect: ["the document quotes a log line this source does not print", "seeded default admin local user"],
  },
  {
    id: "doc-log-quote-denominator",
    defect:
      "The check reads the quoted lines out of the document and the printable strings out of `packages`. Either side going empty makes it agree with anything: no quoted line is a green run over nothing, and no source is a green run against nothing.",
    file: "test/readme.test.ts",
    from: '    walk(join(REPO_ROOT, "packages"));',
    to: "    // walk disabled",
    suite: "test/readme.test.ts",
    expect: ["no sources read — the walk broke"],
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
    id: "screen-draws-null-as-zero",
    defect:
      "The same rule at the screen. The shaping can return `{value: null}` correctly and the page still print `0` — `null` renders as nothing in JSX and a numeric cell would show an empty box, or a `?? 0` anywhere between would turn it into the number the reader is hoping for. agent-mesh-local-pm measured the data half by SIGSTOPping the hub and named this half as the last square.",
    file: "packages/platform-web/src/pages/platform/TelemetryPage.tsx",
    from: "                    {metric.value === null ? (",
    to: "                    {false ? (",
    suite: "test/fe-render.test.ts",
    expect: ["draws an unreadable metric as unmeasured, never as 0"],
  },
  {
    id: "playground-filters-what-it-was-given",
    defect:
      "The playground's sender list compared a hardcoded `ownerId` — the literal `\"admin\"` on every row — to the signed-in id, and its recipient list excluded a group name from a field holding the agent's *type*. One passed everything for a single username and nothing for every other; the other excluded nothing at all. Both read as authorisation and neither was: `GET /api/v1/agents` carries no capability guard, so the server had already handed the whole list over. Not a hole — a false statement about where the gate is, which is worse than an absent one because a reader stops looking. Found by agent-mesh-local-pm.",
    file: "packages/platform-web/src/pages/creator/PlaygroundPage.tsx",
    from: "  const senderAgents = agentsList;",
    to: '  const senderAgents = agentsList.filter((a) => a.group === "Support Group");',
    suite: "test/fe-render.test.ts",
    expect: ["lists exactly the agents /api/v1/agents returned for that session"],
  },
  {
    id: "type-labelled-as-membership",
    defect:
      "Three screens printed an agent's `type` — the kind of agent — under a heading reading 소속, its membership, one of them with `|| \"General\"` invented for anything the server had not typed. The half-fix was worse than the defect: the agent list and the playground's sender were corrected and its recipient was not, leaving one screen calling the same field two names, which a reader takes as two facts. Found by agent-mesh-local-pm reading the diff rather than the issue.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "                    종류: <strong>{agt.type ?? \"—\"}</strong> · 상태:{\" \"}",
    to: "                    소속: <strong>{agt.type ?? \"—\"}</strong> · 상태:{\" \"}",
    suite: "test/greppable.test.ts",
    expect: ["no screen calls an agent's type its membership", "a screen is calling an agent's kind its group"],
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
    id: "egress-refusal-never-counted",
    defect:
      "The wiring between a real § 12 denial and the number reporting it. The shaping can be right and the count still never move — `recordRefusal` not called, the hub's `/api/v1/limits` not read, or the kinds filtered by the wrong name — and every unit test would stay green because they all supply the count themselves. agent-mesh-local-pm named it: seeing a refusal counted is worth more than reading the line that counts it.",
    file: "packages/hub/src/rpc/send.ts",
    from: '    recordRefusal("egress", `${egress.fromGroup}->${egress.toGroup}`);',
    to: "    void egress;",
    suite: "test/behaviour-metrics.test.ts",
    expect: ["an egress denial arrives as a number that went up"],
  },
  {
    id: "rate-limit-never-counted",
    defect:
      "The second source the same route reports, and it can break alone. `rate_limited` sums the hub limiters' own refusals rather than `recordRefusal`, so the egress guard beside it would stay green while this number never moved — a different field, read from the same response.",
    file: "packages/http/src/behaviour-metrics.ts",
    from: "{ value: (s.limits.limiters ?? []).reduce((n, l) => n + (l.refusals ?? 0), 0) },",
    to: "{ value: 0 },",
    suite: "test/behaviour-metrics.test.ts",
    expect: ["a rate-limited request arrives as a number that went up"],
  },
  {
    id: "reminder-stored-in-a-form-that-never-fires",
    defect:
      "§ 8.5 states `next_fire_at` as ISO-8601 and `mesh.schedule_reminder` stored exactly what arrived. The scheduler selects due rows with `next_fire_at <= sqliteTime(now)` — `YYYY-MM-DD HH:MM:SS` — and compares strings, so an ISO timestamp never sorted as due: `T` is 0x54 and the space is 0x20. A caller following the contract got `{ok: true}`, a stored row, and a reminder that never fired. Measured: the same test passed in 522ms with a space-separated timestamp and timed out at thirty seconds with the ISO one, nothing else changed. Nothing caught it because the two sides were tested apart — and every example in this repository used the form that does not work.",
    file: "packages/hub/src/rpc/reminders.ts",
    from: "  const storedFireAt = fireAt.toISOString().replace(\"T\", \" \").slice(0, 19);",
    to: "  const storedFireAt = fireAt.toISOString();",
    suite: "test/reminder-fires.test.ts",
    expect: ["a scheduled reminder is fired by the daemon and reaches its owner"],
  },
  {
    id: "held-reminder-looks-scheduled",
    defect:
      "A `once` reminder more than `overdueHoldMs` late is held for an operator and its row stays `active`, with `next_fire_at` receding further into the past on every scan — so `mesh.list_reminders` showed the same thing for one about to fire and one that never will. Two states where three are needed: scheduled, held, gone. The shape this repository spent the week taking out of screens, in an RPC response. Raised by agent-mesh-local-pm, who also asked for the reverse direction: a field that always says *held* passes the first half.",
    file: "packages/hub/src/rpc/reminders.ts",
    from: "      return held?.value ?? null;",
    to: "      return held ? null : null;",
    suite: "test/reminder-fires.test.ts",
    expect: ["list_reminders tells a held reminder from a scheduled one"],
  },
  {
    id: "boots-without-a-jwt-secret",
    defect:
      "Starting without `JWT_SECRET` and failing only when somebody tries to log in. Signing sessions with a default would mean anyone who has read the file can forge them, and the comment above the check says the rest: a misconfiguration that runs is one nobody finds. It was the last row of agent-mesh-local-pm's feature table still resting on *the source says so*, and the table had it serving a redirect with no cookie — which is what would happen if the check were gone.",
    file: "packages/http/src/auth.ts",
    from: "    process.exit(1)",
    to: "    return 'insecure-default'",
    suite: "test/misconfigured-boot.test.ts",
    expect: ["the http server refuses to start without a JWT secret"],
  },
  {
    id: "preview-without-a-proxy-target",
    defect:
      "The preview section started a front end without `API_PROXY_TARGET`, so `vite.config.ts` fell back to `http://localhost:3000` and attached to whatever was on that port — on a machine already running a mesh, somebody else's. **Every check the document prints still returned 200**; agent-mesh-local-pm caught it by reading `uptime` (68724 from a nineteen-hour-old stack, versus 99 from the one the procedure started). The third time this document meets that shape, in the one section that had not applied it.",
    file: "docs/running-locally.md",
    from: 'export API_PROXY_TARGET="http://127.0.0.1:$HTTP_PORT"',
    to: 'export API_PROXY_TARGET="http://127.0.0.1:3000"',
    suite: "test/readme.test.ts",
    // `"declared"` and not the hardcoded-port message: the declaration check
    // throws first, so the second assertion never runs and its message never
    // appears. Naming it would have demanded a line the run cannot reach.
    expect: ["every vite it starts is told where the backend is", '"declared": false'],
  },
  {
    id: "bunx-cwd-in-a-command",
    defect:
      "`bunx --cwd <dir> vite …` reads `--cwd` as the package to fetch on the bun version this document names, and dies with `GET https://api.github.com/repos/packages/platform-web/tarball/ - 404`. A reader who meets that stops there and never reaches the three correct observations printed under it — the command was wrong and the findings around it were right, which is the expensive combination.",
    file: "docs/running-locally.md",
    from: "cd packages/platform-web && bunx vite preview --port 3041",
    to: "bunx --cwd packages/platform-web vite preview --port 3041",
    suite: "test/readme.test.ts",
    expect: ["does not use a bunx flag that bunx reads as a package"],
  },
  {
    id: "doc-points-at-a-merged-branch",
    defect:
      "§ 8 told readers `packages/platform-web` is not on `main` and to take it from `fe-admin-requirements`, after that branch had been merged and `main` had gone 51 commits past it. **A command that dies stops a reader; a wrong location lets them finish** — everything succeeded on a front end without the last three weeks in it. agent-mesh-local-pm lost a piece of work to it: they built a screen the inventory listed as missing, reached a clean typecheck, and found on the first adversarial check that `main` already had it, better tested.",
    file: "docs/running-locally.md",
    from: "git fetch origin\nbun install --frozen-lockfile",
    to: "git fetch origin\ngit worktree add /tmp/fe origin/fe-admin-requirements\ncd /tmp/fe && bun install --frozen-lockfile",
    suite: "test/readme.test.ts",
    expect: ["does not send a reader to a ref main already contains", "fe-admin-requirements"],
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
  {
    id: "prose-scope-walks-the-tree",
    defect:
      "The scan's file list was three paths typed into the test. `agent-mesh-local-pm` found the same shape in four of their sweeps the same day (mail #1078) and fixed theirs first. A hand-written list covers what its author had already seen, so the day a screen is added the scan silently stops covering it — and the sentence the test prints is \"every namespaced name shown to a user is in the contract\", which is then false while green. The walk replaces the list; this entry removes the walk.",
    file: "test/capability-prose.test.ts",
    from: "const FILES = screenFiles(WEB);",
    to: "const FILES: string[] = [];",
    suite: "test/capability-prose.test.ts",
    expect: ["the scan reaches every screen file, and the three it was built on"],
  },
  {
    id: "prose-reaches-past-the-old-three",
    defect:
      "The other half, and the one that matters: a wrong capability name on a page **outside** the three the check was built against. `GroupsPage.tsx` writes `group.manage` into a subtitle a person reads; yesterday that file was not scanned at all, so this mutation would have passed green. It is here rather than on an anchor file because an anchor proves the rule works, not that the scope does.",
    file: "packages/platform-web/src/pages/creator/GroupsPage.tsx",
    from: "\u00a7 12 group.manage)",
    to: "\u00a7 12 policy.manage)",
    suite: "test/capability-prose.test.ts",
    expect: ["every namespaced name shown to a user is in the contract"],
  },
  {
    id: "versioning-walk-finds-packages",
    defect:
      "Every assertion in `versioning.test.ts` is a loop over `manifests()`, and a loop over an empty list passes. The walk was already derived — this is the floor under it, added while fixing the sibling case in `capability-prose`, because `0 manifests, all declaring the right version` is the same green as the truth.",
    file: "test/versioning.test.ts",
    from: "const found = [{ name: \"root\"",
    to: "const found: Array<{ name: string; path: string; json: Record<string, any> }> = []; const unused = [{ name: \"root\"",
    suite: "test/versioning.test.ts",
    expect: ["the walk found the packages, rather than none"],
  },
  {
    id: "versioning-manifest-that-will-not-parse",
    defect:
      "`catch {}` around `readJson` was commented `Not a package directory` — true for a missing file, false for a malformed or unreadable one, which was dropped from the version check in silence. The denominator shrinking without saying so, on the check whose whole job is that every package agrees on one number. The fix distinguishes ENOENT; this mutation makes a real manifest unparseable and the run must fail rather than skip it.",
    file: "packages/store/package.json",
    from: "\"name\": \"@agent-mesh/store\",",
    to: "\"name\" \"@agent-mesh/store\",",
    suite: "test/versioning.test.ts",
    expect: ["JSON Parse error"],
  },
  {
    id: "password-gate-change-measures-a-transition",
    defect:
      "`can change it, and is then let through` asserted only that the route answered 200 after the change. On an account that was never flagged that is true without a gate ever existing, and the harness clears the flag at boot — so the fixture and the test both plant the state, and whichever plants last decides what is being measured. `agent-mesh-local-pm` named the shape in their own suite the same day (mail #1090): a check that believed it had asked for English was reading Korean, because the reload re-planted the language. This mutation removes the test's own planting; the pre-assertion is what notices.",
    file: "test/http.test.ts",
    from: "    flag(true);\n    const cookie = await login();\n    try {\n      // **The gate has to be shut",
    to: "    // flag(true);\n    const cookie = await login();\n    try {\n      // **The gate has to be shut",
    suite: "test/http.test.ts",
    expect: ["can change it, and is then let through"],
  },
  {
    id: "admitted-is-approved-reaches-the-harness",
    defect:
      "`admitLocalUser` calling `upsertApprovedWebUser` is what makes an admitted account able to load a screen, and nothing measured it from the outside. Thirteen scenarios built their member by writing `local_users` directly, which misses the boot-time approval loop, so `/api/v1/agents` answered 403 and every table above it was empty — and every one of those checks passed, because counting rows on an empty page counts zero without complaint. `agent-mesh-local-pm` measured it twice (mail #1104). Removing the approval here makes the harness produce that member again.",
    file: "packages/http/src/db.ts",
    from: "  upsertApprovedWebUser(input.username)",
    to: "  // upsertApprovedWebUser(input.username)",
    suite: "test/harness-viewer.test.ts",
    expect: ["a route that gates on approval lets them in"],
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

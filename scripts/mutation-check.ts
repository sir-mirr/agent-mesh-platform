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
  /**
   * **Set when the code this planted into is gone.**
   *
   * An entry whose `from` no longer exists checks nothing, and deleting it
   * leaves the next person reading the manifest as though nobody had thought of
   * the case — so they write it again. Retiring keeps the reasoning where
   * somebody looking for that defect will find it, and says which check covers
   * the shape now.
   *
   * A retired entry carries no `from`/`to`: there is nowhere to put them, and a
   * placeholder anchor is the quiet failure this field exists to avoid.
   */
  retired?: string;
  file: string;
  from?: string;
  to?: string;
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

export const SEND_HEAD = `app.post('/api/v1/messages', async (c) => {
  // --- Auth required ---
  const payload = await extractJwt(c)
  if (!payload) {
    return c.json({ error: 'Unauthorized — provide Authorization: Bearer <jwt>' }, 401)
  }
  if (!isUserApproved(payload.github_login, payload.role)) {`

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
    id: "guard-paints-before-the-answer",
    defect:
      "The guard stopped waiting for /auth/me, so a role remembered in localStorage won the first paint and drew a dashboard the server had not agreed to.",
    file: "packages/platform-web/src/components/common/GuardedRoute.tsx",
    from: "  if (isLoading) {",
    to: "  if (false) {",
    suite: "packages/platform-web/src/App.test.tsx",
    expect: ["draws nothing but the check itself"],
  },
  {
    id: "role-mapping-passes-server-string",
    defect:
      "The server's own role string reached the session, so a name the client has a screen for but no route, capability or test would light up a panel nobody can reach.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: "    role: me.role === \"admin\" ? \"PLATFORM_ADMIN\" : \"AGENT_OPERATOR\",",
    to: "    role: (me.role as UserRole) ?? \"AGENT_OPERATOR\",",
    suite: "packages/platform-web/src/contexts/AuthContext.test.tsx",
    expect: ["resolves every role the server could send to one of two"],
  },
  {
    id: "role-mapping-promotes-tenant-admin",
    defect:
      "A role the server does not issue was promoted to platform administrator by the mapping.",
    file: "packages/platform-web/src/contexts/AuthContext.tsx",
    from: "    role: me.role === \"admin\" ? \"PLATFORM_ADMIN\" : \"AGENT_OPERATOR\",",
    to: "    role: me.role === \"admin\" || me.role === \"TENANT_ADMIN\" ? \"PLATFORM_ADMIN\" : \"AGENT_OPERATOR\",",
    suite: "packages/platform-web/src/contexts/AuthContext.test.tsx",
    expect: ["never resolves to a role the dashboard has a panel for"],
  },
  {
    id: "ingest-token-unchecked",
    defect:
      "The AI-usage ingest route stopped checking its token, so with ingest enabled any caller could write the figures the admin screens read. This is the mutation `af4b159` left in `main` for three days.",
    file: "packages/http/src/main.ts",
    from: "  if (!timingSafeEqualString(auth ?? '', `Bearer ${token}`)) {\n    return c.json({ error: 'Unauthorized' }, 401)\n  }",
    to: "",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refuses a caller carrying no token"],
  },
  {
    id: "ingest-enabled-by-default",
    defect:
      "Ingest answered rather than refusing on a deployment that never configured it, turning an unset variable into an open endpoint.",
    file: "packages/http/src/main.ts",
    from: "  const token = process.env.AI_USAGE_INGEST_TOKEN\n  if (!token) {",
    to: "  const token = process.env.AI_USAGE_INGEST_TOKEN ?? 'in-process-ingest-token'\n  if (!token) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refuses everyone while ingest is switched off"],
  },
  {
    id: "send-lets-an-unapproved-account-post",
    defect:
      "The send route stopped checking that the account is approved, so anybody who completed the OAuth flow could put messages on the mesh while still waiting on an admin. \u00a7 9.2a makes admission the gate; authentication only says who is asking. The check is copied into every route on this surface rather than shared, which is why it is worth a mutation: it is only as good as the least recently edited copy.",
    file: "packages/http/src/main.ts",
    from: SEND_HEAD,
    to: SEND_HEAD.replace(
      "  if (!isUserApproved(payload.github_login, payload.role)) {",
      "  if (false) {",
    ),
    suite: "packages/http/src/send-refusals.test.ts",
    expect: ["refuses an account still waiting on an admin"],
  },
  {
    id: "send-ignores-the-policy",
    defect:
      "\u00a7 11's per-user policy stopped being consulted, so any approved member could message any agent in the registry. Refusal is the default here \u2014 a member with no policy row may message nobody \u2014 and removing the check turns the absence of a grant into a grant.",
    file: "packages/http/src/main.ts",
    from: "  if (!isAllowedToMessage(payload.github_login, payload.role, to)) {",
    to: "  if (false) {",
    suite: "packages/http/src/send-refusals.test.ts",
    expect: ["refuses a member whose policy admits nobody"],
  },
  {
    id: "send-names-the-wrong-missing-field",
    defect:
      "Both malformed-body refusals came back naming `to`. A client that dropped `text` is told to look at the field it sent correctly, and the two are dropped by different bugs \u2014 which is the whole reason each refusal names its own field rather than saying \"bad request\".",
    file: "packages/http/src/main.ts",
    from: "    return c.json({ error: 'Missing or invalid \"text\" field' }, 400)",
    to: "    return c.json({ error: 'Missing or invalid \"to\" field' }, 400)",
    suite: "packages/http/src/send-refusals.test.ts",
    expect: ["names the field it is missing"],
  },
  {
    id: "send-failure-corrects-nothing-quietly",
    defect:
      "The write-back that marks a hub-refused message `failed` stopped reporting a miss. The row is inserted moments earlier in the same handler, so a miss means the insert did not take \u2014 and a correction that silently applied to nothing leaves every later read serving `pending` for a message that never left this machine.",
    file: "packages/http/src/send-failure.ts",
    from:
      '  log.error("could not mark a refused message failed: no such row", "send_failure_unrecorded", {\n' +
      "    id,\n" +
      '    outcome: "failed",\n' +
      '    reason: "no_such_row",\n' +
      "  })",
    to: "",
    suite: "packages/http/src/send-failure.test.ts",
    expect: ["names the message when the correction matched no row"],
  },
  {
    id: "chat-audits-reads-a-cleared-box-as-a-filter",
    defect:
      "An empty query value became a filter on the empty string. A console that clears its search box sends `?search=`, and the audit then answers with nothing \u2014 the same screen as a mesh that carried no traffic, which is the one answer an operator cannot check.",
    file: "packages/http/src/chat-audits.ts",
    from: '  typeof v === "string" && v ? v : null;',
    to: '  typeof v === "string" ? v : null;',
    suite: "packages/http/src/chat-audits.test.ts",
    expect: ["treats a cleared box as no filter at all"],
  },
  {
    id: "chat-audits-cursor-skips-a-shared-instant",
    defect:
      "Pagination anchored on `ts` alone. Two messages written in the same millisecond page over each other: the second is never returned on any page, and nothing in the response says a message was skipped. The `id` tiebreak is what makes the order total.",
    file: "packages/http/src/chat-audits.ts",
    from: '      where.push("(ts < ? OR (ts = ? AND id < ?))");\n      params.push(cursorTs, cursorTs, beforeId);',
    to: '      where.push("ts < ?");\n      params.push(cursorTs);',
    suite: "packages/http/src/chat-audits.test.ts",
    expect: ["does not skip a message that shares the cursor's instant"],
  },
  {
    id: "chat-audits-guesses-has-more",
    defect:
      "The query stopped fetching one row beyond the page, so `has_more` was computed from a list that could never exceed the limit and came back `false` on every full page. The console stops offering the next page while the audit still has one, and the operator has no way to tell a complete list from a truncated one.",
    file: "packages/http/src/chat-audits.ts",
    from: "    const rows = db.query(sql).all(...params, limit + 1) as ChatAuditMessage[];",
    to: "    const rows = db.query(sql).all(...params, limit) as ChatAuditMessage[];",
    suite: "packages/http/src/chat-audits.test.ts",
    expect: ["measures has_more rather than guessing it"],
  },
  {
    id: "chat-audits-page-size-unbounded",
    defect:
      "`limit` stopped being clamped, so a caller asking for a million rows holds the whole audit in memory to serve one screen. The value arrives as text from a query string, which is also why the `NaN` guard beside it is reachable here and unreachable behind a JSON body.",
    file: "packages/http/src/chat-audits.ts",
    from: "  return n > MAX_LIMIT ? MAX_LIMIT : n;",
    to: "  return n;",
    suite: "packages/http/src/chat-audits.test.ts",
    expect: ["is clamped rather than trusted"],
  },
  {
    id: "chat-audits-reports-a-failed-query-as-an-empty-audit",
    defect:
      "The catch returned an empty page instead of refusing \u2014 the exact defect `audit-agents.ts` was split out of `main.ts` to end, one route over. *The audit holds nothing* and *the query did not run* become one sentence, and the front end's `SC-DOWN-*` shapes never see the failure they exist to catch.",
    file: "packages/http/src/chat-audits.ts",
    from: '    return {\n      status: 500,\n      body: { error: "Failed to query chat audits", detail: String(e?.message ?? e) },\n    };',
    to: "    return { status: 200, body: { messages: [], has_more: false, oldest_id: null } };",
    suite: "packages/http/src/chat-audits.test.ts",
    expect: ["refuses with the reason, rather than an empty page"],
  },
  {
    id: "chat-audits-search-is-a-pattern-again",
    defect:
      "The audit search stopped escaping `LIKE`'s wildcards, so an operator's text became a pattern again: `%` matches any run, `_` any single character, and a search for `50%` returns every message in the audit. Bound, so this is over-matching rather than injection \u2014 and on an audit screen over-matching is the expensive direction, because it is message content on screen that the capability gating this route exists to keep narrow (D-743).",
    file: "packages/http/src/chat-audits.ts",
    from: '  return "%" + value.replace(/[\\\\%_]/g, (ch) => "\\\\" + ch) + "%";',
    to: '  return "%" + value + "%";',
    suite: "packages/http/src/chat-audits.test.ts",
    expect: ["treats LIKE wildcards as the characters they are"],
  },
  {
    id: "telemetry-reads-the-key-queue-from-a-field-that-is-not-there",
    defect:
      "The key-proposal count read `body.proposals`, and the helper answers `{ ok, keys }`. `?? 0` then answered for the missing field, so telemetry reported an empty key queue however many proposals were waiting \u2014 for every deployment that has ever run. A wrong `0` is worse here than an unread marker: four of these six metrics read `0` when the mesh is calm, so nothing about it looks wrong.",
    file: "packages/http/src/telemetry-behaviour.ts",
    from: "    pendingKeys = r.status === 200 ? ((r.body as any).keys?.length ?? 0) : null;",
    to: "    pendingKeys = r.status === 200 ? ((r.body as any).proposals?.length ?? 0) : null;",
    suite: "packages/http/src/telemetry-behaviour.test.ts",
    expect: ["counts the proposals the helper actually returns"],
  },
  {
    id: "telemetry-reports-an-unreadable-store-as-zero",
    defect:
      "An unreadable message store came back as `0` rather than `null`, so `shapeMetrics` published a count instead of an unread marker. `0 accepted` and `0 pending` describe a calm mesh; a store nobody can read describes a broken server, and the operator cannot tell them apart.",
    file: "packages/http/src/telemetry-behaviour.ts",
    from: "  } catch {\n    oldestPendingMs = null;\n    accepted = null;\n  }",
    to: "  } catch {\n    oldestPendingMs = 0;\n    accepted = 0;\n  }",
    suite: "packages/http/src/telemetry-behaviour.test.ts",
    expect: ["reports both as unread when the store will not answer"],
  },
  {
    id: "telemetry-dates-a-queue-in-local-time",
    defect:
      "The admission queue's stamp stopped being read as UTC. `CURRENT_TIMESTAMP` carries no zone marker, so `Date.parse` takes it as local time and the queue is reported hours older or younger than it is \u2014 in whichever direction the server sits from UTC, which is also why it looks correct on a machine running UTC and wrong nowhere the author tested.",
    file: "packages/http/src/telemetry-behaviour.ts",
    from: '  return Date.parse(`${stamp.replace(" ", "T")}Z`);',
    to: "  return Date.parse(stamp);",
    suite: "packages/http/src/telemetry-behaviour.test.ts",
    expect: ["reads the stamp as UTC, from a machine that is not"],
  },
  {
    id: "telemetry-loses-a-row-it-cannot-date",
    defect:
      "A pending-approval row whose stamp will not parse stopped being counted, because the filter that drops unparseable stamps was applied to the count as well as to the age. Somebody waiting to be admitted disappears from the queue depth on account of a bad timestamp, and the screen that exists to notice them does not.",
    file: "packages/http/src/telemetry-behaviour.ts",
    from: "    pendingUsers = waiting.length;",
    to: "    pendingUsers = waiting.filter((row) => row.requested_at).length;",
    suite: "packages/http/src/telemetry-behaviour.test.ts",
    expect: ["reports no age when no row can be dated"],
  },
  {
    id: "chat-page-opens-for-an-account-still-waiting",
    defect:
      "The chat page stopped checking admission and rendered the conversation for an account still waiting on an admin. The API refuses every call it would then make, so the person gets a working-looking screen where nothing works \u2014 and the pending page exists precisely because *waiting* and *turned away* have different next actions.",
    file: "packages/http/src/main.ts",
    from: "  const approved = isUserApproved(user.github_login, user.role)\n  if (!approved) {\n    return c.html(renderPendingApprovalPage(user))\n  }\n\n  const agentId = c.req.param('agentId')",
    to: "  const approved = true\n  if (!approved) {\n    return c.html(renderPendingApprovalPage(user))\n  }\n\n  const agentId = c.req.param('agentId')",
    suite: "packages/http/src/pages-and-form.test.ts",
    expect: ["tell an account still waiting that it is waiting"],
  },
  {
    id: "chat-list-page-opens-for-an-account-still-waiting",
    defect:
      "The same check, one route over. `/chat` has its own copy of the admission gate \u2014 the two pages were written separately and each decides again \u2014 so a fix to one is not a fix to the other, and a test that only visits `/chat/:agentId` measures half of it.",
    file: "packages/http/src/main.ts",
    from: "  const approved = isUserApproved(user.github_login, user.role)\n  if (!approved) {\n    return c.html(renderPendingApprovalPage(user))\n  }\n\n  return c.html(renderChatPage(user))",
    to: "  const approved = true\n  if (!approved) {\n    return c.html(renderPendingApprovalPage(user))\n  }\n\n  return c.html(renderChatPage(user))",
    suite: "packages/http/src/pages-and-form.test.ts",
    expect: ["tell an account still waiting that it is waiting"],
  },
  {
    id: "file-route-resolves-before-it-asks",
    defect:
      "The route handed the resolved path to the policy again. `resolve(resolve(p))` is `resolve(p)`, so the `..` rule can never fire at any input \u2014 a check that checks nothing, written down as a defence and inert. This is the wiring the split fixed; the mutation restores it.",
    file: "packages/http/src/main.ts",
    from: "  if (!isPathAllowed(filePath, ALLOWED_FILE_PREFIXES)) {",
    to: "  if (!isPathAllowed(resolved, ALLOWED_FILE_PREFIXES)) {",
    suite: "packages/http/src/file-route.test.ts",
    expect: ["refuses a path written with a traversal, even one that lands inside"],
  },
  {
    id: "file-route-serves-a-file-past-its-limit",
    defect:
      "The size limit stopped refusing. The chat renders what this route returns, so an oversized file is either a page that will not load or \u2014 worse if the limit were made a truncation \u2014 a document that ends mid-sentence with nothing to say it was cut.",
    file: "packages/http/src/main.ts",
    from: "  if (stat.size > MAX_FILE_SIZE) {",
    to: "  if (false) {",
    suite: "packages/http/src/file-route.test.ts",
    expect: ["refuses a file past the limit, and says how big it is"],
  },
  {
    id: "file-route-serves-a-directory",
    defect:
      "The `isFile` check went, so a directory is read as a file. `readFileSync` on a directory throws `EISDIR`, which lands on the global error handler as a `500` \u2014 an operator is told the server broke when the answer is that a directory is not a document.",
    file: "packages/http/src/main.ts",
    from: "  if (!stat.isFile()) {\n    return c.json({ error: 'Path is not a file' }, 400)\n  }",
    to: "",
    suite: "packages/http/src/file-route.test.ts",
    expect: ["refuses a directory, which exists and is not a file"],
  },
  {
    id: "screen-inventory-stops-noticing-an-unopened-screen",
    defect:
      "A screen the server draws stops being opened by any scenario \u2014 here `/admin`, by renaming the path the scenario navigates to. The inventory exists because a denominator taken from one producer measures that producer: three screens out of twenty-one had no scenario and all three came from the source nobody was reading. If this mutation is not caught, the inventory has gone quiet and nothing says so.",
    file: "test/fe-render.test.ts",
    from: '    const admin = await read("/admin");',
    to: '    const admin = await read("/admin-renamed");',
    suite: "test/scenario-ids.test.ts",
    expect: ["screens exist that no scenario opens"],
  },
  {
    id: "telemetry-reports-an-unreachable-hub-as-a-calm-mesh",
    defect:
      "`/api/v1/admin/telemetry` stopped carrying why the hub did not answer about its rate limits. `rate_limits: null` with no error beside it draws the same screen as a mesh where no limit has fired \u2014 the operator is told everything is calm while the hub is unreachable, which is the one reading they cannot check.",
    file: "packages/http/src/main.ts",
    from: "    limitersError = err instanceof Error ? err.message : String(err)",
    to: "    limitersError = null",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["names the reason when the hub cannot be reached"],
  },
  {
    id: "telemetry-hides-a-hub-refusal",
    defect:
      "The same silence one branch over: the hub answered, with a status saying no. Losing `hub answered 503` leaves a screen that cannot distinguish a refusal from a mesh with nothing to report.",
    file: "packages/http/src/main.ts",
    from: "    else limitersError = `hub answered ${res.status}`",
    to: "    else limitersError = null",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["names the status when the hub refuses"],
  },
  {
    id: "telemetry-truncates-the-lane-list-silently",
    defect:
      "The lane list is capped at ten and the total beside it stopped being counted separately, so ten rows out of two hundred draws a screen saying the problem is small. This route shipped with the silent version for an hour, which is how the comment came to be written.",
    file: "packages/http/src/main.ts",
    from: "  const lanesTotal = (hub.prepare(\n    `SELECT count(DISTINCT to_agent) AS n FROM messages WHERE status = 'pending'`,\n  ).get() as { n: number }).n",
    to: "  const lanesTotal = lanes.length",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["says how many lanes it is showing, and how many there are"],
  },
  {
    id: "key-stream-replays-the-backlog-as-arrivals",
    defect:
      "The proposal watcher stopped seeding itself from what is already pending, so opening a dashboard announces every key that has been waiting \u2014 a day-old backlog arriving as though it had just landed. The snapshot frame exists to carry that list once; announcing it twice, as news, is how an operator learns to close the notification.",
    file: "packages/http/src/key-proposals.ts",
    from: "  const reported = new Set<string>(pendingSince(db).map((p) => p.fingerprint))",
    to: "  const reported = new Set<string>()",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["says what is already waiting, then what arrives"],
  },
  {
    id: "a-cookie-that-does-not-verify-is-taken-as-a-session",
    defect:
      "The cookie path's `catch` returned the unverified payload instead of `null`, so a token nobody signed is a session. The header path has its own copy of the same three lines, which is why this is worth a mutation rather than a reading: one of the two can stop without the other.",
    file: "packages/http/src/main.ts",
    from: "  const cookieToken = getCookie(c, 'mesh_token')\n  if (cookieToken) {\n    try {\n      return await verifyJwt(cookieToken)\n    } catch {\n      return null\n    }\n  }",
    to: "  const cookieToken = getCookie(c, 'mesh_token')\n  if (cookieToken) {\n    try {\n      return await verifyJwt(cookieToken)\n    } catch {\n      return { github_id: 0, github_login: 'unverified', role: 'member' } as any\n    }\n  }",
    suite: "packages/http/src/pages-and-form.test.ts",
    expect: ["refuses a cookie that does not verify"],
  },
  {
    id: "receive-hands-out-destructively",
    defect:
      "The batch was settled on hand-out instead of leased. A turn can end between the response arriving and anything being written, so a destructive read discards exactly what the caller did not survive to persist \u2014 and the loss is invisible, because the row says delivered.",
    file: "packages/mailbox/src/receive.ts",
    from: "    for (const m of page) stmt.leaseMessage.run(m.id, leaseSeconds);",
    to: "    for (const m of page) stmt.ackMessage.run(m.id, identity);",
    suite: "packages/hub/src/rpc/receive.test.ts",
    expect: ["leaves the batch pending, under a lease"],
  },
  {
    id: "receive-settles-a-message-twice",
    defect:
      "`ackMessage` stopped requiring the row to still be pending. SQLite counts a row rewritten with identical values as changed, so `receive()` fires its settle hook again and \u00a7 8.9.4's one `delivered` event per message becomes two \u2014 on the retry this design deliberately makes safe. The status cannot show it: the second write sets the value it already had.",
    file: "packages/store/src/schema/hub.ts",
    from: "      UPDATE messages SET status = 'delivered', leased_until = NULL\n      WHERE id = ?1 AND to_agent = ?2 AND status = 'pending'",
    to: "      UPDATE messages SET status = 'delivered', leased_until = NULL\n      WHERE id = ?1 AND to_agent = ?2",
    suite: "packages/hub/src/rpc/receive.test.ts",
    expect: ["does not settle a message twice"],
  },
  {
    id: "receive-acks-across-mailboxes",
    defect:
      "The acknowledgement stopped being scoped to the caller's own queue, so any caller can settle any message by naming its id \u2014 the recipient never receives it and the audit records it as delivered to somebody who never held it.",
    file: "packages/store/src/schema/hub.ts",
    from: "      WHERE id = ?1 AND to_agent = ?2 AND status = 'pending'",
    to: "      WHERE id = ?1 AND status = 'pending'",
    suite: "packages/hub/src/rpc/receive.test.ts",
    expect: ["ignores an acknowledgement for somebody else's message"],
  },
  {
    id: "receive-limit-passed-through",
    defect:
      "`limit` reached the query unclamped. A negative limit is *no limit* in SQLite, so a caller asking for `-1` is handed its whole queue in one leased batch \u2014 the opposite of what it asked for, from a parameter the wire controls.",
    file: "packages/hub/src/rpc/receive.ts",
    from: "  const limit = Math.min(\n    Math.max(parseInt(params.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),\n    MAILBOX_CAPABILITY_DEFAULTS.max_receive_batch,\n  );",
    to: "  const limit = parseInt(params.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;",
    suite: "packages/hub/src/rpc/receive.test.ts",
    expect: ["is clamped rather than passed through"],
  },
  {
    id: "receive-trusts-the-ack-list",
    defect:
      "The acknowledgement list stopped being filtered to strings. `bun:sqlite` reads an array as the whole positional list, so a nested `[\"x\"]` raises *expected 2 values, received 1* from inside the transaction \u2014 and the settle step runs before the lease is granted, so the throw does not merely fail to settle, it takes the batch down with it. A number, a null or an object is inert against these statements; the array is the one that bites, which is why the case carries one.",
    file: "packages/hub/src/rpc/receive.ts",
    from: "  const ackIds: string[] = Array.isArray(params.ack_ids)\n    ? params.ack_ids.filter((x: unknown) => typeof x === \"string\")\n    : [];",
    to: "  const ackIds: string[] = Array.isArray(params.ack_ids) ? params.ack_ids : [];",
    suite: "packages/hub/src/rpc/receive.test.ts",
    expect: ["takes ack ids only when they are strings"],
  },
  {
    id: "audit-append-acks-before-it-commits",
    defect:
      "The ACK stopped being read back from the committed row. A client told its outbox entry is safe drops it, so acknowledging before the transaction commits is how an event is lost with both sides believing it was stored \u2014 and nothing later says otherwise, because the outbox is empty.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "  const stored = stmtSelectAuditEvent.get(eventId) as { stored_at: string };",
    to: "  const stored = { stored_at: new Date().toISOString() };",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["commits it, and answers only afterwards"],
  },
  {
    id: "audit-append-treats-a-collision-as-a-retry",
    defect:
      "An event reusing an id with *different* bytes was answered as a duplicate. The two are not alike: identical bytes mean the client did not hear the ACK, different bytes under one id mean a client defect retrying cannot fix. Answering `duplicate: true` tells that client the event is stored when what is stored is somebody else's.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    if (existing.payload_digest === payloadDigest) {",
    to: "    if (true) {",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["refuses a second event that reuses an id with different bytes"],
  },
  {
    id: "audit-append-records-the-caller-as-producer",
    defect:
      "The stored `identity` came from the payload rather than from the connection. \u00a7 8.9.3's record is only worth reading if the *who* is the hub's own knowledge \u2014 an event that says who it is about is an event anyone can write about anyone.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "        params.producer_id ?? null,\n        identity,\n        \"adapter\",",
    to: "        params.producer_id ?? null,\n        (params.identity as string) ?? identity,\n        \"adapter\",",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["records the connection's identity, not one the payload claims"],
  },
  {
    id: "audit-append-accepts-a-truncated-blob",
    defect:
      "The size check went, so a file of the right name and the wrong length counts as present. That is an interrupted upload, and accepting it commits an event that references truncated bytes as verified \u2014 the one thing the check exists for, and unrecoverable afterwards because the event is signed over what it claims.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    if (!stat || stat.size !== size) {",
    to: "    if (!stat) {",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["refuses a blob whose stored size is not the declared one"],
  },
  {
    id: "prepare-blobs-reports-a-partial-upload-as-present",
    defect:
      "The same rule one method earlier: `prepare_blobs` reported a stored file of the wrong length as `present`, so the client never re-uploads it and the append that follows references bytes nobody completed. The two checks are copies of one rule and either can stop alone.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    if (existing && existing.size === b.size) {",
    to: "    if (existing) {",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["reports one of the wrong length as missing, and grants an upload"],
  },
  {
    id: "recall-loses-the-senders-signature",
    defect:
      "The recall event stopped carrying the sender's `AgentMeshSig`. A recall is a thing the sender asked for, and the `messages` row is gone by then \u2014 this event is the only place the withdrawal exists, so an unattested one is a withdrawal nobody can prove was requested. That is the standalone mailer's defect one level down: the sender able to shape the record.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "  recordMeshEvent(\"mesh.message.recalled\", {\n    messageId: row.id,\n    from: row.from_agent,\n    to: row.to_agent,\n    sentBy: row.sent_by ?? row.from_agent,\n    content: \"\",\n    replyTo: null,\n    senderSig,",
    to: "  recordMeshEvent(\"mesh.message.recalled\", {\n    messageId: row.id,\n    from: row.from_agent,\n    to: row.to_agent,\n    sentBy: row.sent_by ?? row.from_agent,\n    content: \"\",\n    replyTo: null,\n    senderSig: null,",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["keeps the sender's own signature on a recall, and none on a delivery"],
  },
  {
    id: "delivery-attests-the-hubs-own-observation",
    defect:
      "A delivery event gained an attestation. It is the hub's own later observation, not something the sender asked for \u2014 attaching a signature-shaped field to it says a party vouched for a fact they were never asked about, and an audit that cannot tell the two apart is one whose attestations mean nothing.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    senderSig: null,\n    senderParams: \"{}\",\n  });\n}",
    to: "    senderSig: { alg: \"hub\", value: \"observed\" },\n    senderParams: \"{}\",\n  });\n}",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["keeps the sender's own signature on a recall, and none on a delivery"],
  },
  {
    id: "identity-event-invents-an-actor",
    defect:
      "An identity change whose cause the route could not name was recorded as caused by the hub. `null` is the honest answer and a legible one: an operator reading the trail can tell *nobody knows who did this* from *the hub did this*, and filling it in removes the difference for ever \u2014 § 8.9.5 events are retained indefinitely.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    actor: fields.actor,\n    change: fields.change,",
    to: "    actor: fields.actor ?? \"hub\",\n    change: fields.change,",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["records one whose cause is unknown, rather than inventing an actor"],
  },
  {
    id: "hub-events-get-ids-that-do-not-sort",
    defect:
      "The hub's own events took random ids. \u00a7 8.9.3 requires time-ordered ones because the query API pages by `(stored_at, event_id)` and `stored_at` is millisecond precision \u2014 several events land on one value under any load, and a random id breaks the tie randomly, which lets a row inserted later sort before the cursor and never be read. The hub is a producer as much as any client, and this is the requirement it was placing on others.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    // API pages by `(stored_at, event_id)` and millisecond `stored_at` ties.\n    event_id: `evt_${Bun.randomUUIDv7()}`,",
    to: "    // API pages by `(stored_at, event_id)` and millisecond `stored_at` ties.\n    event_id: `evt_${crypto.randomUUID()}`,",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["gives its own events ids that sort the way they happened"],
  },
  {
    id: "mailbox-signs-the-path-without-its-query",
    defect:
      "The REST signature stopped covering the query string. `?peer=` and `?limit=` carry the request on this surface, so an attacker able to rewrite a query could redirect a history read at another peer while the signature still verified \u2014 the one place a path alone is not the request.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "  const auth = authenticate(method, req.path, req.authorization, req.body, req.observed ?? null);",
    to: "  const auth = authenticate(method, req.pathname, req.authorization, req.body, req.observed ?? null);",
    suite: "packages/hub/src/rest/mailbox-request.test.ts",
    expect: ["honours a limit that came in signed"],
  },
  {
    id: "mailbox-recall-forgets-to-record-it",
    defect:
      "A recall stopped writing its audit event. The `messages` row is deleted by the recall, so this event is the only place the withdrawal exists \u2014 without it the trail holds a `sent` and nothing saying it was taken back, which is the standalone mailer's defect (\u00a7 9.2.1): the sender able to shape the record.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "  if (row) recordRecalled(row, { scheme: \"AgentMeshSig\", authorization });",
    to: "",
    suite: "packages/hub/src/rest/mailbox-request.test.ts",
    expect: ["records the withdrawal in the audit"],
  },
  {
    id: "mailbox-recall-reads-the-row-after-the-delete",
    defect:
      "The row was read after the recall removed it, so the audit event has nothing to record and the withdrawal goes unrecorded exactly when it succeeds. The order is the property: read first, then delete.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "  const row = stmtMessageById.get(messageId) as\n    | { id: string; from_agent: string; to_agent: string; sent_by: string | null }\n    | undefined;\n\n  const outcome = outbox.recall(hubDb, caller.identity, messageId);",
    to: "  const outcome = outbox.recall(hubDb, caller.identity, messageId);\n  const row = stmtMessageById.get(messageId) as\n    | { id: string; from_agent: string; to_agent: string; sent_by: string | null }\n    | undefined;",
    suite: "packages/hub/src/rest/mailbox-request.test.ts",
    expect: ["records the withdrawal in the audit"],
  },
  {
    id: "mail-send-is-recorded-as-a-mesh-send",
    defect:
      "\u00a7 8.2a: the transport a message arrived on is recorded, and this route *is* the mailbox. Letting it default to `mesh` makes every mail-sent message indistinguishable from a socket send, which is the fact the routing rule is keyed on.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "    return handleSend(ws, params, 1, undefined, undefined, \"mailbox\")!;",
    to: "    return handleSend(ws, params, 1, undefined, undefined)!;",
    suite: "packages/hub/src/rest/mailbox-request.test.ts",
    expect: ["records the channel it arrived on"],
  },
  {
    id: "unwrap-flattens-every-refusal-to-500",
    defect:
      "The REST envelope stopped mapping JSON-RPC codes to statuses, so a malformed request, a conflict and an unentitled sender all come back `500`. A client cannot retry-classify on a status it shares with a server fault, and the `rpc_code` beside it is what carries the policy \u2014 both halves exist because neither is enough alone.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "      rpc.error.code === -32015 ? 409 :",
    to: "      false ? 409 :",
    suite: "packages/hub/src/rest/mailbox-request.test.ts",
    expect: ["refuses a key reused for a different message"],
  },
  {
    id: "preview-lint-loses-its-extraction-floor",
    defect:
      "The preview linter stopped requiring a minimum number of extracted route references. An extractor that quietly stops finding routes also stops finding unauthorised ones, so the lint passes \u2014 the floor is the only thing that can tell a preview which shrank from a parser which broke. Sixty modular pages must yield at least sixty references.",
    file: "scripts/lint-preview.ts",
    from: "  if (totalRoutesFound < minFloor) {",
    to: "  if (false) {",
    suite: "test/preview-lint.test.ts",
    expect: ["catches an extraction that has quietly stopped working"],
  },
  {
    id: "preview-lint-falls-back-to-a-hand-written-capability-list",
    defect:
      "The capability count came from a list in this file again rather than from the contract. That is the defect this check exists to catch: the list said nine while the contract held twelve, and a linter reading its own copy agrees with itself for ever.",
    file: "scripts/lint-preview.ts",
    from: "    ?? (() => require('@agent-mesh/contracts').CAPABILITY as Record<string, string>);",
    to: "    ?? (() => ({ a: 'agent.provision', b: 'agent.teardown', c: 'key.approve', d: 'role.grant', e: 'audit.read.metadata', f: 'audit.read.content', g: 'mailbox.read.depth', h: 'group.manage', i: 'type.manage' }));",
    suite: "test/preview-lint.test.ts",
    expect: ["counts capabilities from the contract rather than a list of its own"],
  },
  {
    id: "audit-query-reads-the-digest-back-instead-of-recomputing-it",
    defect:
      "The integrity field compared the stored digest with itself. It always matches, which is why it looks fine \u2014 and it proves nothing: a row edited after ingest carries a digest edited with it, or one nobody compares. Recomputing over the bytes being returned is the only thing that says the payload is what was signed for. An audit store whose rows can change without detection is a log.",
    file: "packages/http/src/audit-query.ts",
    from: "      digest_matches: createHash('sha256').update(row.payload, 'utf8').digest('hex') === row.payload_digest,",
    to: "      digest_matches: row.payload_digest === row.payload_digest,",
    suite: "packages/http/src/audit-query.test.ts",
    expect: ["recomputes the digest over the bytes it is returning"],
  },
  {
    id: "audit-query-cursor-compares-the-timestamp-alone",
    defect:
      "Paging compared `stored_at` on its own. Two events stored in the same millisecond give the cursor no way to say which it already returned, so a page boundary landing between them skips one or repeats it \u2014 silently, in an audit trail, which is the one place a missing row cannot be noticed by its absence.",
    file: "packages/http/src/audit-query.ts",
    from: "    where.push('(stored_at, event_id) > (?, ?)')\n    args.push(c.storedAt, c.eventId)",
    to: "    where.push('stored_at > ?')\n    args.push(c.storedAt)",
    suite: "packages/http/src/audit-query.test.ts",
    expect: ["does not skip or repeat an event that shares the boundary timestamp"],
  },
  {
    id: "audit-query-hands-content-to-a-metadata-holder",
    defect:
      "\u00a7 11's line between metadata and content stopped being drawn on the way out of the audit. An operator holding `audit.read.metadata` and not `audit.read.content` reads every message body on the mesh, and the read is recorded as a metadata read \u2014 so the record understates what was disclosed.",
    file: "packages/http/src/audit-query.ts",
    from: "    if (!withContent) payload = stripContent(payload)",
    to: "",
    suite: "packages/http/src/audit-query.test.ts",
    expect: ["withholds the content, and gives its length"],
  },
  {
    id: "audit-query-redacts-only-the-top-level",
    defect:
      "Redaction stopped recursing, so a secret one level down comes back whole. The payload is stored verbatim because the digest is over those bytes \u2014 removing it on the way out is the only place it can be removed at all, which makes a shallow pass the difference between redacted and published.",
    file: "packages/http/src/audit-query.ts",
    from: "      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v)",
    to: "      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : v",
    suite: "packages/http/src/audit-query.test.ts",
    expect: ["redacts secrets whatever the caller holds"],
  },
  {
    id: "revocation-without-a-reason-is-accepted",
    defect:
      "A key revocation stopped requiring a reason. `rotation` and `compromise` say different things about every signature made before the revocation \u2014 one says nothing, the other casts doubt on the whole window \u2014 and the recorded reason is the only thing that tells a verifier which happened. By the time anybody asks, nobody remembers.",
    file: "packages/http/src/keys-admin.ts",
    from: "        if (!reason) {",
    to: "        if (false) {",
    suite: "packages/http/src/keys-admin.test.ts",
    expect: ["refuses a revocation that gives no reason"],
  },
  {
    id: "key-decision-conflates-missing-with-already-decided",
    defect:
      "A fingerprint that does not exist and one already decided came back as the same status. They mean different things to the operator holding a stale listing: one says *you have the wrong string*, the other says *somebody got there first*, and only the second is a reason to reload rather than retype.",
    file: "packages/http/src/keys-admin.ts",
    from: "        status: err.code === 'not-found' ? 404 : 409,",
    to: "        status: 409,",
    suite: "packages/http/src/keys-admin.test.ts",
    expect: ["tells a wrong fingerprint apart from one already decided"],
  },
  {
    id: "key-decision-records-no-actor",
    defect:
      "The decision stopped naming who made it. \u00a7 10.2 requires each transition to say who caused it, and an approval nobody is named for is an approval nobody can be asked about \u2014 which is exactly the state the unauthenticated version of this route left every row in.",
    file: "packages/http/src/keys-admin.ts",
    from: "        row = keys.approveKey(db, fingerprint, actor)",
    to: "        row = keys.approveKey(db, fingerprint, 'hub')",
    suite: "packages/http/src/keys-admin.test.ts",
    expect: ["records who approved it, and when"],
  },
  {
    id: "drop-connection-evicts-the-owner-when-a-contender-goes",
    defect:
      "A losing contender's departure took the working connection offline with it. \u00a7 8.1 gives the identity to whoever holds it: a second socket claiming an identity already held does not take it, and when that contender goes the incumbent must still be online. Dropping the check makes any short-lived duplicate connection a way to disconnect the real one.",
    file: "packages/hub/src/presence.ts",
    from: "  if (released?.wasOwner && onlineAgents.get(identity) === ws) {",
    to: "  if (onlineAgents.get(identity) === ws || true) {",
    suite: "packages/hub/src/presence.test.ts",
    expect: ["leaves the identity online when a contender goes"],
  },
  {
    id: "drop-connection-steals-a-proxy-entry-back",
    defect:
      "A departing proxy removed a `proxyMap` entry that another socket had since taken. Two sockets can proxy for one user in sequence, and the one leaving must not unroute the connection still serving them \u2014 the user goes offline because somebody else disconnected.",
    file: "packages/hub/src/presence.ts",
    from: "      if (proxyMap.get(pid) === ws) proxyMap.delete(pid);",
    to: "      proxyMap.delete(pid);",
    suite: "packages/hub/src/presence.test.ts",
    expect: ["does not remove a proxy entry another socket now owns"],
  },
  {
    id: "nonce-sweep-keeps-an-identity-with-nothing-in-it",
    defect:
      "The replay window stopped dropping an identity once its last nonce expired, so the map grows by name for the life of the process \u2014 one entry per identity that has ever signed, never released. The nonces inside are swept; the shell is what is left.",
    file: "packages/store/src/verify.ts",
    from: "      if (nonces.size === 0) this.seen.delete(identity);",
    to: "",
    suite: "packages/store/src/nonce-window.test.ts",
    expect: ["forgets an identity once its last nonce goes"],
  },
  {
    id: "nonce-sweep-drops-what-is-still-in-the-window",
    defect:
      "The sweep compared against the wrong side of the window and removed entries still inside it. A nonce forgotten early is a signed request that can be replayed \u2014 which is the one thing this map exists to prevent, and the failure leaves no trace anywhere.",
    file: "packages/store/src/verify.ts",
    from: "    const cutoff = nowSeconds - this.windowSeconds;",
    to: "    const cutoff = nowSeconds + this.windowSeconds;",
    suite: "packages/store/src/nonce-window.test.ts",
    expect: ["keeps what is still inside the window"],
  },
  {
    id: "entitlement-refusals-all-say-the-same-thing",
    defect:
      "The four refusal reasons collapsed into one sentence. *No such identity* and *that identity signs for itself* send an operator to different places \u2014 provisioning, or the agent's own key \u2014 and one message for both sends them to neither.",
    file: "packages/store/src/entitlement.ts",
    from: "    case \"unknown-identity\":\n      return `cannot act for '${subject}': no such identity`;",
    to: "    case \"unknown-identity\":\n      return `not entitled to act for '${subject}'`;",
    suite: "packages/store/src/entitlement.test.ts",
    expect: ["gives each reason a distinct sentence"],
  },
  {
    id: "send-checks-egress-after-it-has-written",
    defect:
      "\u00a7 12's egress check moved behind the write, so a send the policy forbids reaches the queue and is refused afterwards. Two things go wrong at once: the row exists for a message that was never allowed, and the dormancy clock has been stamped by an attempt that was refused \u2014 which resets the very silence \u00a7 8.11.2 measures.",
    file: "packages/hub/src/rpc/send.ts",
    from: "  const egress = groups.maySend(agentsDb, effectiveSender, to);\n  if (!egress.ok) {",
    to: "  const egress = groups.maySend(agentsDb, effectiveSender, to);\n  if (false) {",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["writes no message when it refuses"],
  },
  {
    id: "egress-rule-read-in-both-directions",
    defect:
      "An egress rule started answering for the reverse pair. Allowing `a \u2192 b` says nothing about `b \u2192 a`, and reading it both ways quietly widens every rule an operator has ever written \u2014 the kind of change nothing visible fails on.",
    file: "packages/store/src/groups.ts",
    from: "      `SELECT 1 FROM group_egress WHERE tenant = ? AND from_group = ? AND to_group = ? LIMIT 1`,\n    )\n    .get(tenant, fromGroup, toGroup);",
    to: "      `SELECT 1 FROM group_egress WHERE tenant = ?1 AND ((from_group = ?2 AND to_group = ?3) OR (from_group = ?3 AND to_group = ?2)) LIMIT 1`,\n    )\n    .get(tenant, fromGroup, toGroup);",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["does not open the other direction"],
  },
  {
    id: "send-accepts-an-undeclared-proxy-subject",
    defect:
      "The `proxy_for` check went, leaving only the store's entitlement. They are two questions: the store says which identities a caller *may* act for, `proxy_for` says which it *claimed* on connect. A socket entitled to ten identities has not claimed all ten, and a send as an undeclared one is a socket acting outside what it announced \u2014 which is what the declaration is for.",
    file: "packages/hub/src/rpc/send.ts",
    from: "    if (!wsProxies.get(ws)?.has(effectiveSender)) {",
    to: "    if (false) {",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["refuses an identity it is entitled to but did not declare"],
  },
  {
    id: "send-takes-an-idempotency-key-it-cannot-store",
    defect:
      "`client_message_id` stopped being validated, so an empty string or a value longer than the column holds is stored as a key. The key is how a retry is told from a new send; one that cannot round-trip means neither, and the failure appears later as a duplicate message or a conflict nobody can explain.",
    file: "packages/hub/src/rpc/send.ts",
    from: "    if (typeof clientMessageId !== \"string\" || clientMessageId.length === 0 || clientMessageId.length > 128) {",
    to: "    if (false) {",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["refuses an idempotency key it cannot use"],
  },
  {
    id: "teardown-by-ownership-skips-the-name-check",
    defect:
      "On the ownership path the identity stopped being validated before the store was called. Ownership of a malformed name is a row somebody wrote, not a reason to act on it \u2014 and \u00a7 9.3 is irreversible, so a teardown that reaches a name nobody meant cannot be undone. The capability path validates; this one is the copy that stopped.",
    file: "packages/http/src/main.ts",
    from: "    if (!IDENTITY_RE.test(identity)) return badIdentity(c)\n    return teardownAs(c, subject!, identity)",
    to: "    return teardownAs(c, subject!, identity)",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["refuses a malformed identity even from its owner"],
  },
  {
    id: "teardown-takes-ownership-of-one-agent-for-all",
    defect:
      "The ownership check stopped naming the identity, so holding `agent.teardown` at any scope plus owning *anything* tears down *anything*. \u00a7 11.3 scopes teardown for the reason \u00a7 9.3 makes it irreversible: reaching one identity too far is not recoverable, and the name is never usable again.",
    file: "packages/http/src/main.ts",
    from: "      ownership.isOwner(agentsDb(), subject, identity)",
    to: "      ownership.ownedBy(agentsDb(), subject).length > 0",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["refuses the same holder on an identity they do not own"],
  },
  {
    id: "sign-in-crashes-on-a-body-it-can-parse",
    defect:
      "`POST /auth/local` read its fields straight off whatever the body parsed to. `null` is valid JSON, so the one malformed body this route could parse became an unhandled `TypeError` and a `500`, while `\"a string\"`, `[]` and `123` all got the `400` they should. Four characters on an unauthenticated route, answered with the server's error handler.",
    file: "packages/http/src/main.ts",
    from: "  const body: Record<string, unknown> =\n    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}",
    to: "  const body = parsed as Record<string, unknown>",
    suite: "packages/http/src/pages-and-form.test.ts",
    expect: ["refuses every body that carries no credential, in one shape"],
  },
  {
    id: "sign-in-form-says-which-half-was-wrong",
    defect:
      "The form's failed sign-in stopped using one redirect for both causes, so `?error=` distinguishes an unknown username from a wrong password. That turns the landing page into an account enumerator: a caller learns which names exist without ever holding a credential.",
    file: "packages/http/src/main.ts",
    from: "  const user = await verifyLocalUser(username, password)\n  if (!user) {",
    to: "  const user = await verifyLocalUser(username, password)\n  if (!user) {\n    if (!getLocalUser(username)) return fail(401, 'no such user', '/?error=nouser')",
    suite: "packages/http/src/pages-and-form.test.ts",
    expect: ["does not say which half of the credential was wrong"],
  },
  {
    id: "sign-in-form-lands-without-a-session",
    defect:
      "The browser form's success stopped setting the cookie on the redirect. The person is sent to `/chat`, which finds no session and sends them back to `/` \u2014 a sign-in that succeeds and does nothing, twice in a row, with no error anywhere to say why.",
    file: "packages/http/src/main.ts",
    from: "    headers: { 'Location': '/chat', 'Set-Cookie': cookie },",
    to: "    headers: { 'Location': '/chat' },",
    suite: "packages/http/src/pages-and-form.test.ts",
    expect: ["signs the browser in, and lands it on the conversation"],
  },
  {
    id: "grant-author-is-self-reported",
    defect:
      "`grantedBy` started falling back to a field the caller sent. The grant record is the only account of how somebody came to hold a capability, and one whose author is self-reported records whatever the author wanted recorded \u2014 including a name that never made the grant.",
    file: "packages/http/src/main.ts",
    from: "  grants.grant(agentsDb(), { subject, capability, scope, grantedBy: actor })",
    to: "  grants.grant(agentsDb(), { subject, capability, scope, grantedBy: body.grantedBy ?? actor })",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["records the actor as the author, whatever the body claims"],
  },
  {
    id: "grant-vocabulary-left-open",
    defect:
      "The write route stopped checking the capability against `ALL_CAPABILITIES`, so a mistyped name is stored as a grant that no check will ever match. It fails silently and in the safe direction \u2014 the operator believes the person has the capability, the person does not, and nothing anywhere says so.",
    file: "packages/http/src/main.ts",
    from: "  if (!(ALL_CAPABILITIES as readonly string[]).includes(capability)) {\n    return c.json({ ok: false, error: `unknown capability: ${capability}`, capabilities: ALL_CAPABILITIES }, 400)",
    to: "  if (false) {\n    return c.json({ ok: false, error: `unknown capability: ${capability}`, capabilities: ALL_CAPABILITIES }, 400)",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["refuses a capability nobody defines, and says which exist"],
  },
  {
    id: "revoke-accepts-half-a-row",
    defect:
      "The revocation stopped requiring both halves of the row it names. A request missing `capability` then reaches the store as `undefined`, removes nothing, and answers `not-found` \u2014 which an operator reads as *the grant was already gone* rather than *you did not name one*.",
    file: "packages/http/src/main.ts",
    from: "  if (typeof subject !== 'string' || typeof capability !== 'string') {\n    return c.json({ ok: false, error: 'subject and capability are required' }, 400)\n  }",
    to: "  if (false) {\n    return c.json({ ok: false, error: 'subject and capability are required' }, 400)\n  }",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["refuses a revocation that names no grant"],
  },
  {
    id: "any-scope-gate-demands-the-whole-tenant",
    defect:
      "`requireCapabilityAnyScope` fell back to a tenant-scoped check, which is the failure \u00a7 11.3 names: it refuses every operator who holds `key.approve` on their own agents only. The answer for them is a short list \u2014 the approval queue's empty state \u2014 not a `403` for a capability they do hold.",
    file: "packages/http/src/main.ts",
    from: "  if (!grants.hasAny(agentsDb(), subject, capability)) {",
    to: "  if (!grants.has(agentsDb(), subject, capability)) {",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["admits a holder scoped to a single agent"],
  },
  {
    id: "pending-keys-unfiltered-for-an-owner",
    defect:
      "The pending-key queue stopped narrowing to what the operator owns, handing every scoped holder every proposal in the tenant. The queue is a work list, and one that shows an operator agents they cannot decide on is both a leak of who else runs what and a list nobody can act on.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ ...body, keys: (body.keys ?? []).filter((k) => mine.has(k.identity)) }, 200)",
    to: "  return c.json({ ...body, keys: body.keys ?? [] }, 200)",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["shows an owner their own proposals and nobody else's"],
  },
  {
    id: "ai-usage-read-borrows-the-audit-grant",
    defect:
      "The AI-usage read stopped asking for `usage.read` and took the audit's grant instead. \u00a7 11 separates them because they answer different questions: an operator cleared to read message content is not thereby cleared to read what the deployment spends, and a capability that stands in for another is one nobody can revoke separately.",
    file: "packages/http/src/main.ts",
    from: "  const actor = await requireCapability(c, CAPABILITY.USAGE_READ)\n  if (typeof actor !== 'string') return actor\n  void actor\n  return c.json({ snapshot: latestAiUsageSnapshot })",
    to: "  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_CONTENT)\n  if (typeof actor !== 'string') return actor\n  void actor\n  return c.json({ snapshot: latestAiUsageSnapshot })",
    suite: "packages/http/src/ai-usage.test.ts",
    expect: ["is not satisfied by a grant that answers another question"],
  },
  {
    id: "ai-usage-stream-waits-for-the-next-tick",
    defect:
      "The stream stopped pushing the snapshot it was already holding on connect. Nothing is lost forever \u2014 the next monitor tick arrives \u2014 but the tick is five minutes wide, so a console opens on an empty panel while the server holds the answer, and the emptiness is indistinguishable from a monitor that has stopped.",
    file: "packages/http/src/main.ts",
    from: "      if (latestAiUsageSnapshot) {",
    to: "      if (false) {",
    suite: "packages/http/src/ai-usage.test.ts",
    expect: ["pushes what it already has, without waiting for the next tick"],
  },
  {
    id: "ai-usage-stream-leaks-a-departed-subscriber",
    defect:
      "A subscriber that cancelled its stream was left in the fan-out set. This fails at no particular moment: the set grows for the life of the process and every push writes to a controller whose socket is gone. The same defect `sseClientCount` exists to make visible, one route over \u2014 and it is visible only because `aiUsageSseClientCount` is exported, since nothing outside can otherwise count these clients.",
    file: "packages/http/src/main.ts",
    from: "      if (controllerRef) removeAiUsageSseClient(controllerRef)",
    to: "",
    suite: "packages/http/src/ai-usage.test.ts",
    expect: ["unregisters a subscriber that leaves, and still serves the rest"],
  },
  {
    id: "ingest-accepts-a-snapshot-with-no-accounts",
    defect:
      "Ingest accepted a snapshot carrying an empty `accounts` array, which the console then renders as a deployment that spent nothing. A monitor that failed to read any account reports exactly this shape, and accepting it overwrites the last figures that were true with a zero nobody can tell from a real one.",
    file: "packages/http/src/main.ts",
    from: "  if (!Array.isArray(body.accounts) || body.accounts.length < 1) {",
    to: "  if (!Array.isArray(body.accounts)) {",
    suite: "packages/http/src/ai-usage.test.ts",
    expect: ["refuses a snapshot it cannot use, and says which part"],
  },
  {
    id: "ingest-schema-version-unchecked",
    defect:
      "A snapshot declaring a schema this build does not know was accepted and read as if it were v1.",
    file: "packages/http/src/main.ts",
    from: "  if (body.schema_version !== 'v1') {",
    to: "  if (false) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["not the shape it declares"],
  },
  {
    id: "ingest-empty-accounts-accepted",
    defect:
      "An empty accounts array was accepted, so a broken producer could quietly blank the usage screens.",
    file: "packages/http/src/main.ts",
    from: "  if (!Array.isArray(body.accounts) || body.accounts.length < 1) {",
    to: "  if (!Array.isArray(body.accounts)) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["not the shape it declares"],
  },
  {
    id: "ingest-ts-type-unchecked",
    defect:
      "A snapshot whose timestamp is not a string was stored, and every later comparison on it is lexical.",
    file: "packages/http/src/main.ts",
    from: "  if (typeof body.ts !== 'string' || typeof body.source !== 'string') {",
    to: "  if (typeof body.source !== 'string') {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["not the shape it declares"],
  },
  {
    id: "change-password-behind-the-guard",
    defect:
      "The page the guard sends people to went behind the same guard, so anyone holding a temporary password was redirected to it for ever and could neither sign in nor reach the page that would let them.",
    file: "packages/platform-web/src/App.tsx",
    from: "            <Route path=\"/change-password\" element={<ChangePasswordPage />} />",
    to: "            <Route path=\"/change-password\" element={<GuardedRoute><ChangePasswordPage /></GuardedRoute>} />",
    suite: "packages/platform-web/src/App.test.tsx",
    expect: ["does not guard the page the guard sends people to"],
  },
  {
    id: "route-table-has-no-fallback",
    defect:
      "An unrouted path rendered blank instead of redirecting, so a wrong link looked like a broken screen.",
    file: "packages/platform-web/src/App.tsx",
    from: "            <Route path=\"*\" element={<Navigate to=\"/\" replace />} />",
    to: "",
    suite: "packages/platform-web/src/App.test.tsx",
    expect: ["does not leave a person on a path it does not know"],
  },
  {
    id: "sidebar-offers-a-dead-link",
    defect:
      "The sidebar offered a path the router does not know. Nothing errors: it matches `*`, redirects, and the person lands on the dashboard wondering what they clicked.",
    file: "packages/platform-web/src/components/layout/Sidebar.tsx",
    from: "          href: \"/creator/topology\",",
    to: "          href: \"/creator/topologie\",",
    suite: "packages/platform-web/src/App.test.tsx",
    expect: ["routes every path the sidebar offers"],
  },
  {
    id: "files-prefix-has-no-boundary",
    defect:
      "A path prefix with no separator boundary let any approved session read a sibling directory: `<STATE_DIR>-backup/secret` matched `<STATE_DIR>` and the route answered 200 with the bytes.",
    file: "packages/http/src/file-access.ts",
    from: "    const dir = prefix.endsWith(\"/\") ? prefix : `${prefix}/`;\n    return resolved === prefix || resolved.startsWith(dir);",
    to: "    return resolved.startsWith(prefix);",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["merely starts with an allowed one"],
  },
  {
    id: "files-unknown-type-guessed",
    defect:
      "An unrecognised extension was served as something a browser renders instead of as bytes.",
    file: "packages/http/src/main.ts",
    from: "  return mimeMap[ext] ?? 'application/octet-stream'",
    to: "  return mimeMap[ext] ?? 'text/html'",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["falls back to bytes"],
  },
  {
    id: "files-allowlist-not-enforced",
    defect:
      "A path outside the allowed directories was served rather than refused.",
    file: "packages/http/src/main.ts",
    from: "    return c.json({ error: 'Access denied \u2014 file path not in allowed directories' }, 403)",
    to: "    return c.json({ error: 'Access denied' }, 200)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refuses a path outside the allowed directories"],
  },
  {
    id: "files-directory-served-as-file",
    defect:
      "A directory was read as a file rather than refused.",
    file: "packages/http/src/main.ts",
    from: "  if (!stat.isFile()) {\n    return c.json({ error: 'Path is not a file' }, 400)\n  }\n  if (stat.size > MAX_FILE_SIZE) {",
    to: "  if (false) {\n    return c.json({ error: 'Path is not a file' }, 400)\n  }\n  if (stat.size > MAX_FILE_SIZE) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refuses a directory"],
  },
  {
    id: "files-missing-not-checked",
    defect:
      "A path that is not there was read anyway, so a missing file threw instead of answering 404.",
    file: "packages/http/src/main.ts",
    from: "  if (!existsSync(resolved)) {",
    to: "  if (false) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refuses a directory"],
  },
  {
    id: "boot-retry-swallows-refusal",
    defect:
      "Every failed boot became retryable, so the two misconfigured-boot checks would pass against a server that had stopped refusing to start.",
    file: "test/harness.ts",
    from: "  if (PORT_TAKEN.test(said)) return true;\n  return said.replace(NEVER_HEALTHY, \"\").replace(HARNESS_SECTIONS, \"\").trim() === \"\";",
    to: "  return true;",
    suite: "test/boot-retryable.test.ts",
    expect: ["a service that refused is the answer"],
  },
  {
    id: "boot-retry-never-fires",
    defect:
      "The retry stopped firing at all, and a lost port race \u2014 the thing freePort's bind-then-release window makes routine \u2014 failed the run instead of taking another port.",
    file: "test/harness.ts",
    from: "  if (PORT_TAKEN.test(said)) return true;\n  return said.replace(NEVER_HEALTHY, \"\").replace(HARNESS_SECTIONS, \"\").trim() === \"\";",
    to: "  return false;",
    suite: "test/boot-retryable.test.ts",
    expect: ["a boot that named a port is retried"],
  },
  {
    id: "boot-retry-drops-port-clause",
    defect:
      "The port-race clause went away, so the original failure this guard was written for stopped being retried.",
    file: "test/harness.ts",
    from: "  if (PORT_TAKEN.test(said)) return true;\n  return said.replace(NEVER_HEALTHY, \"\").replace(HARNESS_SECTIONS, \"\").trim() === \"\";",
    to: "  return said.replace(NEVER_HEALTHY, \"\").replace(HARNESS_SECTIONS, \"\").trim() === \"\";",
    suite: "test/boot-retryable.test.ts",
    expect: ["a boot that named a port is retried"],
  },
  {
    id: "boot-retry-counts-harness-speech",
    defect:
      "The harness's own timeout sentence counted as the child having spoken, so every slow boot looked like a refusal and was never retried \u2014 the exact failure this widening was for.",
    file: "test/harness.ts",
    from: "  return said.replace(NEVER_HEALTHY, \"\").replace(HARNESS_SECTIONS, \"\").trim() === \"\";",
    to: "  return said.replace(HARNESS_SECTIONS, \"\").trim() === \"\";",
    suite: "test/boot-retryable.test.ts",
    expect: ["does not count as the child speaking"],
  },
  {
    id: "boot-retry-strips-child-output",
    defect:
      "Stripping the harness's sentence swallowed the child's output underneath it, so a real refusal read as silence and was retried.",
    file: "test/harness.ts",
    from: "const NEVER_HEALTHY = /service at \\S+ never became healthy:[^\\n]*/g;",
    to: "const NEVER_HEALTHY = /service at \\S+ never became healthy:[\\s\\S]*/g;",
    suite: "test/boot-retryable.test.ts",
    expect: ["still a refusal"],
  },
  {
    id: "sw-source-syntax-error",
    defect:
      "The service worker source stopped parsing, so no browser would register it and the app quietly stopped being installable \u2014 nothing on the server notices, because it is a string.",
    file: "packages/http/src/main.ts",
    from: "  e.waitUntil(\n    self.registration.showNotification(data.title, {",
    to: "  e.waitUntil((\n    self.registration.showNotification(data.title, {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["parses as JavaScript"],
  },
  {
    id: "sw-notification-opens-404",
    defect:
      "Tapping a notification navigated to a route this server does not answer.",
    file: "packages/http/src/main.ts",
    from: "  const url = agent ? '/chat/' + encodeURIComponent(agent) : '/chat';",
    to: "  const url = agent ? '/chats/' + encodeURIComponent(agent) : '/chats';",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["navigates to a route this server answers"],
  },
  {
    id: "sw-notification-icon-404",
    defect:
      "The notification asked for an icon file this server does not serve.",
    file: "packages/http/src/main.ts",
    from: "      icon: '/icon-192.svg',",
    to: "      icon: '/icon-192.png',",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["asks for an icon this server serves"],
  },
  {
    id: "sw-notification-tag-collapses",
    defect:
      "Every message shared one notification tag, so the second agent to write to you silently replaced the first.",
    file: "packages/http/src/main.ts",
    from: "      tag: 'mesh-' + (data.data?.agent || 'default'),",
    to: "      tag: 'mesh-default',",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["keeps two agents' notifications apart"],
  },
  {
    id: "sw-empty-push-throws",
    defect:
      "A push whose payload the browser dropped threw inside the handler, so the user was shown nothing at all.",
    file: "packages/http/src/main.ts",
    from: "  const data = e.data ? e.data.json() : { title: 'Agent Mesh', body: 'New message' };",
    to: "  const data = e.data.json();",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["shows something for a push that carries no payload"],
  },
  {
    id: "key-decision-empty-fingerprint",
    defect:
      "An empty fingerprint stopped counting as a missing one, so a decision could be made against nothing at all (\u00a7 10.2).",
    file: "packages/http/src/main.ts",
    from: "    if (typeof fingerprint !== 'string' || !fingerprint) {",
    to: "    if (typeof fingerprint !== 'string' && !fingerprint) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["names no fingerprint"],
  },
  {
    id: "key-decision-by-identity",
    defect:
      "A decision could be addressed by identity again \u2014 approving whatever proposal arrived last, including one that landed between reading the screen and clicking (\u00a7 10.2).",
    file: "packages/http/src/main.ts",
    from: "    const fingerprint = body.fingerprint",
    to: "    const fingerprint = body.fingerprint ?? body.identity",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["names no fingerprint"],
  },
  {
    id: "teardown-always-says-deleted",
    defect:
      "Teardown reported `soft-deleted` whatever it had done, so an operator could not tell a name they mistyped from one they tore down.",
    file: "packages/http/src/main.ts",
    from: "    action: result.action,\n    ...(result.deletedAt !== undefined ? { deleted_at: result.deletedAt } : {}),",
    to: "    action: 'soft-deleted',\n    ...(result.deletedAt !== undefined ? { deleted_at: result.deletedAt } : {}),",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["which of the three things it did"],
  },
  {
    id: "audit-list-ignores-cursor",
    defect:
      "The audit list ignored its cursor, so paging returned the first page again and a reader scrolling could not tell.",
    file: "packages/http/src/chat-audits.ts",
    from: "    if (cursorTs !== null) {",
    to: "    if (false) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["pages backwards from a cursor"],
  },
  {
    id: "audit-list-ignores-filter",
    defect:
      "The audit list dropped the from_agent filter, handing a console watching one conversation every conversation on the mesh.",
    file: "packages/http/src/chat-audits.ts",
    from: '    if (fromAgent !== null) {\n      where.push("from_agent = ?");\n      params.push(fromAgent);\n    }',
    to: '    if (false) {\n      where.push("from_agent = ?");\n      params.push(fromAgent);\n    }',
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["narrows to the conversation"],
  },
  {
    id: "audit-list-limit-unclamped",
    defect:
      "A limit that is not a number was passed through, so a mistyped query answered with nothing and looked like an empty audit.",
    file: "packages/http/src/chat-audits.ts",
    from: "  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;",
    to: "  if (false) return DEFAULT_LIMIT;",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["takes a limit it can honour"],
  },
  {
    id: "audit-stream-capability-bypassed",
    defect:
      "The audit stream stopped refusing an operator without audit.read.content, and every admin-role session read every conversation on the mesh (\u00a7 11.0).",
    file: "packages/http/src/main.ts",
    from: "  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_CONTENT)\n  if (typeof actor !== 'string') return actor\n  const refused = logContentRead(c, actor, true, 'chat-audits:stream', c.req.query())",
    to: "  const actor = await requireCapability(c, CAPABILITY.AUDIT_READ_CONTENT)\n  const refused = logContentRead(c, actor as string, true, 'chat-audits:stream', c.req.query())",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["does not hold audit.read.content"],
  },
  {
    id: "audit-stream-read-unrecorded",
    defect:
      "A content read went unrecorded. Holding audit.read.content is defensible; holding it without the record is not (\u00a7 8.9.5).",
    file: "packages/http/src/main.ts",
    from: "  const refused = logContentRead(c, actor, true, 'chat-audits:stream', c.req.query())",
    to: "  const refused = logContentRead(c, actor, false, 'chat-audits:stream', c.req.query())",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["records the read before it serves a byte"],
  },
  {
    id: "audit-replay-newest-first",
    defect:
      "A reconnecting console was handed its missed conversation backwards.",
    file: "packages/http/src/main.ts",
    from: "ORDER BY ts ASC, id ASC LIMIT 100",
    to: "ORDER BY ts DESC, id DESC LIMIT 100",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["oldest first"],
  },
  {
    id: "audit-replay-includes-anchor",
    defect:
      "The message named by Last-Event-ID was replayed, so every reconnect drew the last message a second time.",
    file: "packages/http/src/main.ts",
    from: "            const where: string[] = ['(ts > ? OR (ts = ? AND id > ?))']",
    to: "            const where: string[] = ['(ts >= ? OR (ts = ? AND id > ?))']",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["does not replay the message the client already has"],
  },
  {
    id: "audit-replay-unlabelled",
    defect:
      "Replayed frames stopped saying they were recovered, so a console could not tell history from live.",
    file: "packages/http/src/main.ts",
    from: "JSON.stringify(Object.assign({}, m, { recovered: true }))",
    to: "JSON.stringify(m)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["labels a replayed frame as recovered"],
  },
  {
    id: "audit-replay-no-frame-id",
    defect:
      "Replayed frames carried no id, so after a second disconnection the browser resent the old Last-Event-ID and replayed the same window for ever.",
    file: "packages/http/src/main.ts",
    from: "`id: ${sseSafeId(m.id)}\\nevent: message\\n",
    to: "`event: message\\n",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["gives each replayed frame its own id"],
  },
  {
    id: "audit-replay-floods",
    defect:
      "A gap too large to send stopped being summarised, and a client reconnecting after an outage was handed the flood instead.",
    file: "packages/http/src/main.ts",
    from: "            if (gapCount > 100) {",
    to: "            if (gapCount > 100000) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["summarises a gap too large"],
  },
  {
    id: "audit-replay-ignores-filter",
    defect:
      "The replay dropped the filter the live stream applies, so a console watching one conversation was handed every conversation on the mesh \u2014 with content.",
    file: "packages/http/src/main.ts",
    from: "            if (fromAgent) { where.push('from_agent = ?'); params.push(fromAgent) }",
    to: "            if (false) { where.push('from_agent = ?'); params.push(fromAgent) }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["filters the replay the same way"],
  },
  {
    id: "audit-replay-unknown-anchor-is-epoch",
    defect:
      "An unknown Last-Event-ID was treated as the beginning of time, so a client reconnecting after a retention sweep was sent the whole table.",
    file: "packages/http/src/main.ts",
    from: "          const anchor = db.query('SELECT ts FROM messages WHERE id = ?').get(lastEventId) as { ts: string } | undefined",
    to: "          const anchor = (db.query('SELECT ts FROM messages WHERE id = ?').get(lastEventId) ?? { ts: '1970-01-01 00:00:00' }) as { ts: string } | undefined",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["replays nothing for a Last-Event-ID the hub no longer holds"],
  },
  {
    id: "keystream-not-a-stream",
    defect:
      "The key-proposal stream was served as text, so no browser would treat it as SSE and the operator bell went silent.",
    file: "packages/http/src/main.ts",
    from: "  return new Response(keyProposalStream(agentsDb()), {\n    headers: {\n      'Content-Type': 'text/event-stream',",
    to: "  return new Response(keyProposalStream(agentsDb()), {\n    headers: {\n      'Content-Type': 'text/plain',",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["answers as a stream"],
  },
  {
    id: "keystream-proxy-buffers",
    defect:
      "The stream stopped telling a proxy not to buffer it, so behind nginx the operator saw nothing until the connection closed \u2014 which for a stream is never.",
    file: "packages/http/src/main.ts",
    from: "  return new Response(keyProposalStream(agentsDb()), {\n    headers: {\n      'Content-Type': 'text/event-stream',\n      'Cache-Control': 'no-cache, no-transform',\n      'Connection': 'keep-alive',\n      'X-Accel-Buffering': 'no',\n    },\n  })",
    to: "  return new Response(keyProposalStream(agentsDb()), {\n    headers: {\n      'Content-Type': 'text/event-stream',\n      'Cache-Control': 'no-cache, no-transform',\n      'Connection': 'keep-alive',\n    },\n  })",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["tells a proxy not to hold it"],
  },
  {
    id: "keystream-queue-renamed",
    defect:
      "The stream called the queue something the list route does not, so the bell read `keys` from one channel and `proposals` from the other (\u00a7 9.2).",
    file: "packages/http/src/main.ts",
    from: "      push('snapshot', { keys: keyProposals.pendingSince(db) })",
    to: "      push('snapshot', { proposals: keyProposals.pendingSince(db) })",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["calls the queue `keys`"],
  },
  {
    id: "keystream-backlog-as-arrivals",
    defect:
      "A backlog was replayed as arrivals, announcing keys that had been waiting for a day as though they had just landed.",
    file: "packages/http/src/main.ts",
    from: "      push('snapshot', { keys: keyProposals.pendingSince(db) })",
    to: "      for (const p of keyProposals.pendingSince(db)) push('key-proposed', p)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["as a snapshot, not as arrivals"],
  },
  {
    id: "keystream-leaks-public-key",
    defect:
      "Public key material was sent to the browser, where an operator only ever decides on a fingerprint.",
    file: "packages/http/src/key-proposals.ts",
    from: "      `SELECT k.identity, k.fingerprint, a.type, k.proposed_at",
    to: "      `SELECT k.identity, k.fingerprint, k.public_key, a.type, k.proposed_at",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["no public key material"],
  },
  {
    id: "refusal-hides-capability",
    defect:
      "A refusal stopped naming the missing grant, so an operator told 'Forbidden' asks for everything instead of for the one thing (\u00a7 11).",
    file: "packages/http/src/main.ts",
    from: "    return c.json({ error: `Missing capability: ${capability}`, capability, scope }, 403)",
    to: "    return c.json({ error: 'Forbidden', capability, scope }, 403)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["names the grant a refused operator is missing"],
  },
  {
    id: "attachment-signature-ignored",
    defect:
      "A valid signature over an approved key was refused, so a signing caller could never fetch an attachment at all (§ 9.2.1).",
    file: "packages/http/src/main.ts",
    from: "  return outcome.ok ? { identity } : { refusal: 401 }",
    to: "  return { refusal: 401 }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["an approved key's signature is a credential"],
  },
  {
    id: "attachment-signature-unchecked",
    defect:
      "The signature was never checked, so anyone who knew a fingerprint could fetch any attachment its owner was party to (§ 9.2.1).",
    file: "packages/http/src/main.ts",
    from: "  return outcome.ok ? { identity } : { refusal: 401 }",
    to: "  return { identity }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a forged signature buys nothing"],
  },
  {
    id: "attachment-preimage-drops-query",
    defect:
      "The query string fell out of the signed preimage, leaving everything after `?` free to rewrite in flight.",
    file: "packages/http/src/main.ts",
    from: "      path: url.pathname + url.search,",
    to: "      path: url.pathname,",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["the signed path includes the query string"],
  },
  {
    id: "attachment-freshness-one-sided",
    defect:
      "The freshness bound stopped being a distance, so a header dated into the future was accepted.",
    file: "packages/http/src/main.ts",
    from: "  if (Math.abs(Math.floor(Date.now() / 1000) - auth.iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {",
    to: "  if (Math.floor(Date.now() / 1000) - auth.iat > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["dated into the future"],
  },
  {
    id: "attachment-freshness-absent",
    defect:
      "The freshness bound went away, and with no nonce window in this process an Authorization header lifted from a log worked for ever.",
    file: "packages/http/src/main.ts",
    from: "  if (Math.abs(Math.floor(Date.now() / 1000) - auth.iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {",
    to: "  if (false) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a captured Authorization header stops working"],
  },
  {
    id: "attachment-unparsed-credential",
    defect:
      "A credential that is not a signature reached `auth.iat` and threw, answering 500 where the contract says 401.",
    file: "packages/http/src/main.ts",
    from: "  const auth = parseRestAuthorization(header)\n  if (!auth) return { refusal: 401 }\n",
    to: "  const auth = parseRestAuthorization(header)!\n",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["not a signature is refused, not crashed on"],
  },
  {
    id: "attachment-unapproved-gets-401",
    defect:
      "An authenticated but unapproved person was told to sign in again — sent to fix the thing that was already working.",
    file: "packages/http/src/main.ts",
    from: "      : { refusal: 403 }",
    to: "      : { refusal: 401 }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["never approved is told to wait"],
  },
  {
    id: "attachment-unknown-fingerprint",
    defect:
      "A fingerprint no approved key names resolved to an identity anyway.",
    file: "packages/http/src/main.ts",
    from: "  if (!identity) return { refusal: 401 }",
    to: "  if (!identity) return { identity: 'in-process-signer' }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a fingerprint no approved key names"],
  },
  {
    id: "hubless-send-answer",
    defect:
      "A message the hub refused was answered `pending`, so the thread drew it as still on its way (§ 5).",
    // Already killed by `test/message-status.test.ts` against a real hub, in
    // both directions. This anchor exists because that file runs in a child
    // and this one runs where an instrument can see it — not because it is a
    // second chance at the same defect.
    file: "packages/http/src/main.ts",
    from: "    msg.status = 'failed'",
    to: "    msg.status = 'pending'",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["failed in the answer and in the row"],
  },
  {
    id: "hubless-send-row",
    defect:
      "The refusal was corrected in the reply only; the stored row kept `pending`, so history, conversation and search all reported a message that never left the machine as waiting.",
    file: "packages/http/src/send-failure.ts",
    from: "  if (update(id, 'failed')) return true",
    to: "  if (update(id, 'pending')) return true",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["failed in the answer and in the row"],
  },
  {
    id: "oauth-callback-no-code",
    defect:
      "A callback arriving without a code answered 200, so cancelling GitHub's consent screen looked like a successful sign-in.",
    // **The guard itself is deliberately not the anchor.** Every mutation that
    // lets an absent or empty code through reaches `exchangeCodeForToken`,
    // which is a bare `fetch` to github.com — an anchor that runs on every
    // sweep must not depend on the network, so the status is mutated instead
    // and the guard stays.
    file: "packages/http/src/main.ts",
    from: "    return c.json({ error: 'Missing \"code\" query parameter' }, 400)",
    to: "    return c.json({ error: 'Missing \"code\" query parameter' }, 200)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refused before anything is exchanged"],
  },
  {
    id: "logout-keeps-cookie",
    defect:
      "Signing out stopped expiring the session cookie, so the next request from that browser was still signed in.",
    file: "packages/http/src/main.ts",
    from: "'content-type': 'application/json', 'Set-Cookie': sessionCookie(c, '', 0)",
    to: "'content-type': 'application/json'",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["clears the browser's copy of the session"],
  },
  {
    id: "sw-content-type",
    defect: "The service worker was served as text, so no browser would register it and the app never installed.",
    file: "packages/http/src/main.ts",
    from: "'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'",
    to: "'Content-Type': 'text/plain', 'Cache-Control': 'no-cache'",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["serves the service worker as JavaScript"],
  },
  {
    id: "sw-cacheable",
    defect:
      "The service worker itself became cacheable, so the copy that would fetch a new build was the stale one.",
    file: "packages/http/src/main.ts",
    from: "'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache'",
    to: "'Content-Type': 'application/javascript'",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["not to cache the service worker"],
  },
  {
    id: "sw-cache-version-pinned",
    defect:
      "The cache name stopped following the build, so `activate` never deleted the old cache and a new build served the old one.",
    file: "packages/http/src/main.ts",
    from: "const CACHE_VERSION = '${BUILD_VERSION}';",
    to: "const CACHE_VERSION = 'v1';",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["names its cache after the version"],
  },
  {
    id: "manifest-icon-missing",
    defect: "The manifest named an icon the server does not serve, and the install failed with nothing logged.",
    file: "packages/http/src/main.ts",
    from: "{ src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' }",
    to: "{ src: '/icon-256.svg', sizes: '256x256', type: 'image/svg+xml' }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["names icons in the manifest that the server actually serves"],
  },
  {
    id: "icon-size-copy-paste",
    defect: "The large icon was the small one, scaled up on every device that asked for it.",
    file: "packages/http/src/main.ts",
    from: "return c.body(meshIconSvg(512))",
    to: "return c.body(meshIconSvg(192))",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["draws each icon at the size its name claims"],
  },
  {
    id: "vapid-key-absent-not-null",
    defect:
      "An unconfigured push key vanished from the body, so a client could not tell 'push is not set up here' from 'the server did not answer that'.",
    file: "packages/http/src/main.ts",
    from: "publicKey: VAPID_PUBLIC_KEY || null",
    to: "publicKey: VAPID_PUBLIC_KEY || undefined",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["answers null for an unconfigured push key"],
  },
  {
    id: "registry-scope-collapse",
    defect:
      "GET /api/v1/agents listed the whole registry to any approved session — 44 identities to an account with no capabilities (§ 12).",
    file: "packages/http/src/main.ts",
    from: "  const seesEverything = (getLocalUser",
    to: "  const seesEverything = true || (getLocalUser",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["sees only itself"],
  },
  {
    id: "registry-scope-owned",
    defect: "The owned-agent term went missing, so an operator lost sight of what it owns (§ 12).",
    file: "packages/http/src/main.ts",
    from: "    for (const identity of ownership.ownedBy(mesh, actor)) visible.add(identity)",
    to: "    void 0",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["an owned identity becomes visible"],
  },
  {
    id: "registry-scope-group",
    defect: "The group term went missing, so people in one group could not see each other (§ 12).",
    file: "packages/http/src/main.ts",
    from: "      for (const member of groupsStore.membersOf(mesh, myGroup)) visible.add(member)",
    to: "      void 0",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["everyone in the session's own group"],
  },
  {
    id: "registry-scope-outbound",
    defect:
      "Only the sender end of a conversation counted, so an identity this session had written to stayed invisible (§ 12).",
    // **This one was not caught when it was first written.** The check sent one
    // message, inbound, and both terms make an inbound row visible — so deleting
    // the outbound line left the suite green. It is caught by the outbound
    // message that exists in the check only because this mutation was run.
    from: "      visible.add(row.to_agent)",
    file: "packages/http/src/main.ts",
    to: "      void 0",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["sent or received"],
  },
  {
    id: "registry-last-seen-null",
    defect: "An identity the mesh has no presence row for reported undefined rather than null, and the console drew ONLINE for everyone.",
    file: "packages/http/src/main.ts",
    from: "    last_seen_at: lastSeen.get(entry.id) ?? null,",
    to: "    last_seen_at: lastSeen.get(entry.id),",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["carries the mesh's last_seen"],
  },
  {
    id: "registry-fingerprint-unapproved",
    defect: "A merely proposed key was drawn beside an identity as if the mesh trusted it (§ 4).",
    file: "packages/http/src/main.ts",
    from: "FROM agent_keys WHERE status = 'approved'",
    to: "FROM agent_keys",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["carries a fingerprint only for an approved key"],
  },
  {
    id: "content-read-trace",
    defect: "A content read left no record (§ 11.0.1).",
    file: "packages/http/src/main.ts",
    from: "  const refusal = recordContentReadOrRefuse({ actor, target, query })",
    to: "  const refusal = null",
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
    id: "key-stream-ping-leaves-the-watcher-running",
    defect:
      "The keepalive on `keys/stream` was a fourth hand-written copy of a rule the other three streams share, and it cleared its own timer while leaving the proposal watcher polling `agent_keys` every 500ms — for the life of the process, against a stream nobody is reading. The other three have no watcher to forget, which is why collecting them did not collect this.",
    file: "packages/http/src/main.ts",
    from: "      stopHeartbeat = startStreamKeepalive(() => {\n        if (push('ping', {})) return\n        stop?.()",
    to: "      stopHeartbeat = startStreamKeepalive(() => {\n        if (push('ping', {})) return",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["stops the watcher too, not only the timer"],
  },
  {
    id: "key-stream-proposal-into-a-reader-that-left",
    defect:
      "A proposal arriving after the reader went away was pushed into a closed controller and the watcher kept running, so the poll outlived every stream that ended without a `cancel`. The enqueue failing is how a gone reader announces itself here — `push` answers `false` rather than throwing, and dropping the answer drops the only notice there is.",
    file: "packages/http/src/main.ts",
    from: "        if (!push('key-proposed', p)) stop?.()",
    to: "        push('key-proposed', p)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["stops the watcher, rather than pushing into nothing"],
  },
  {
    id: "key-stream-cancel-keeps-polling",
    defect:
      "Cancelling the stream stopped the keepalive and left the proposal watcher running. This is the ordinary ending — a dashboard tab closing — so the leak needed no failure at all to happen, only a browser.",
    file: "packages/http/src/main.ts",
    from: "    cancel() {\n      stopHeartbeat?.()\n      stop?.()\n    },",
    to: "    cancel() {\n      stopHeartbeat?.()\n    },",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a reader that leaves takes the watcher with it"],
  },
  {
    id: "key-stream-push-claims-a-closed-write",
    defect:
      "`push` reported success for an enqueue that threw, so every caller that asks whether the stream is still there was told yes by a stream that is gone — and both endings that depend on the answer stopped happening.",
    file: "packages/http/src/main.ts",
    from: "          return true\n        } catch {\n          return false\n        }",
    to: "          return true\n        } catch {\n          return true\n        }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["stops the watcher"],
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
    // **Anchored to the route, not to the guard.** The guard's two lines appear
    // under `keys/stream` as well, so this named two places and `replace` took
    // the first — a verdict about a line the entry had not chosen.
    from: "app.get('/api/v1/admin/keys/:identity', async (c) => {\n  const actor = await requireCapability(c, CAPABILITY.KEY_APPROVE)\n  if (typeof actor !== 'string') return actor",
    to: "app.get('/api/v1/admin/keys/:identity', async (c) => {\n  const payload = await extractJwt(c)\n  if (!payload) return c.json({ error: 'Unauthorized' }, 401)\n  if (payload.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)\n  const actor = payload.github_login as string",
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
    id: "reminder-reads-its-schedule-in-local-time",
    defect:
      "`next_fire_at` is SQLite's zoneless UTC and the marker stopped being stamped before parsing, so `Date.parse` reads it as local time. East of UTC a reminder five minutes late looks nine hours overdue: it is held for an operator decision and never fires, which is the failure the overdue policy exists to make deliberate rather than silent. Invisible under `bun test`, which runs on UTC.",
    file: "packages/self-reminder/src/scheduler.ts",
    from: '  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);',
    to: "  const parsed = new Date(value);",
    suite: "packages/self-reminder/src/scheduler.test.ts",
    expect: ["does not hold a barely-late reminder as overdue, east of UTC"],
  },
  {
    id: "dormancy-reads-its-clock-in-local-time",
    defect:
      "`last_send_at` is SQLite's `datetime('now')` \u2014 UTC, space-separated, no zone marker \u2014 and the zone marker stopped being stamped before parsing. `Date.parse` then reads it as local time, so on a server east of UTC every identity looks idle by exactly the offset: nine hours of phantom idleness on the machine this was written on, and a control whose entire value is how rarely it fires on someone legitimate starts refusing working agents the first time they move network. Invisible under `bun test`, which runs on UTC.",
    file: "packages/hub/src/dormancy.ts",
    from: '  const idleSeconds = (Date.now() - Date.parse(`${last.replace(" ", "T")}Z`)) / 1000;',
    to: "  const idleSeconds = (Date.now() - Date.parse(last)) / 1000;",
    suite: "packages/hub/src/dormancy.test.ts",
    expect: ["does not read a recent send as hours of idleness, east of UTC"],
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
    from: "    markSendFailed(msg.id)",
    to: "",
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
    from: "  ['audit (access log)', closeAuditAccessLog],",
    to: "  ['audit (access log)', () => {}],",
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
    from: "const GROUP_CREATE_FIELDS = new Set(['group_id', 'description', 'tenant'])",
    to: "const GROUP_CREATE_FIELDS = new Set(['group_id', 'description', 'tenant', 'members', 'name'])",
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
    // **Re-anchored three times now, and the reason is the same every time:**
    // this row grows whenever a scenario joins the family, so an anchor written
    // against its tail goes stale the moment the axis it counts does any work.
    // The count *is* what the entry is about, so the count has to be in the
    // anchor and the staleness is the price. `--anchors` charges it immediately
    // rather than letting the entry sit checking nothing, which is the whole
    // reason that check exists — it caught this one within a minute of
    // `fe-console` landing four new `SC-WRITE-*` scenarios.
    from: "· **받아들여진 쓰기에 화면이 영수증을 그리는가** | 21 |",
    to: "· **받아들여진 쓰기에 화면이 영수증을 그리는가** | 19 |",
    suite: "test/scenario-ids.test.ts",
    // Moved with the anchor: the number the mutant produces is the number the
    // expected message quotes.
    expect: ["every count it states is the count the tests hold", "SC-WRITE-*: table says 19"],
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
    // 재앵커 2026-08-20: 그 시나리오 제목이 `영수증 없음` 으로 바뀌었다.
    from: "it(\"[SC-WRITE-09] says 영수증 없음",
    to: "it(\"[SC-WRITE-07] says 영수증 없음",
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
    // 재앵커 2026-08-20: 그 문자열이 사전을 거치게 됐다.
    from: 'return total != null ? String(total) : t("common.unmeasured", "— 미측정");',
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
    // 재앵커 2026-08-20: placeholder 가 사전을 거치게 됐다.
    from: '              placeholder={t("login.idPlaceholder", "username")}',
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
    from: "    ? t(\"common.errorLoad\", \"\ubd88\ub7ec\uc624\uc9c0 \ubabb\ud568\")\n    : emptyMessage;",
    to: "    ? t(\"common.errorLoad\", \"\uc870\uc9c1 \uc815\ubcf4 \ubd88\ub7ec\uc624\uc9c0 \ubabb\ud568\")\n    : emptyMessage;",
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
    // 재앵커 2026-08-20: 로딩 상태가 그 삼항 앞에 붙었다.
    from: '              data-testid={isLoading ? "operator-agents-loading" : isError ? "operator-agents-unreachable" : "operator-agents-empty"}',
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
      "A refusal drawn as silence: the server answered `403` naming the capability it wanted, and the screen said nothing about either. The rule then reversed \u2014 nine screens had the machine key typed into their own copy (`(key.approve)`, `(group.manage)`, `(mailbox.read.depth)`), nine guesses that were right on the day they were written and operator-facing language on none of them. So what is planted now is that habit returning: the sentence naming the capability again. The key stays on the error object for code and diagnostics, which is where a machine name belongs.",
    file: "packages/platform-web/src/api/client.ts",
    from: "  return `${base}.`;",
    to: "  return _capability ? `${base} (${_capability}).` : `${base}.`;",
    suite: "packages/platform-web/src/api/client.test.ts",
    expect: ["keeps the server's machine key out of operator copy"],
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
    from: "          {canTeardown && item.id !== user?.name && (",
    to: "          {true && item.id !== user?.name && (",
    suite: "packages/platform-web/src/pages/creator/AgentsPage.test.tsx",
    expect: ["does not open teardown to a session holding some other capability"],
  },
  {
    id: "teardown-hidden-from-everybody",
    defect:
      "The other way to pass: hide it from every session, including the one the server gave `agent.teardown`. A console where nothing dangerous is possible also cannot do the job.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: "          {canTeardown && item.id !== user?.name && (",
    to: "          {false && item.id !== user?.name && (",
    suite: "packages/platform-web/src/pages/creator/AgentsPage.test.tsx",
    expect: ["offers it to the session the server gave `agent.teardown`"],
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
    // 재앵커 2026-08-20: 거절 문구가 `refusedText` 로 모였다 — 심는 결함은 같다.
    from: `            failure === "refused"
              ? refusedText(t, missing)
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
    // 재앵커 2026-08-20: 로딩 상태가 두 삼항 앞에 붙었다. 심는 결함은 같다.
    from: `          value={isLoading ? "..." : isError ? "\u2014" : String(agents.length)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? t("common.errorLoad", "불러오지 못함") : t("dash.kpi.agentsSub", "개 등록됨")}`,
    to: `          value={String(agents.length)}
          subValue={t("dash.kpi.agentsSub", "개 등록됨")}`,
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-13", "drew 0 for a read that was refused"],
  },
  {
    id: "catch-empties-a-list-and-says-nothing",
    // **Retired 2026-08-21, and the reason is that the shape is gone.**
    //
    // Re-anchored three times before this, each time because the catch it
    // planted into moved. It has now stopped moving: `fe-t019` routed every
    // list read on this page through one discriminated value, so there is no
    // `.catch(() => setX([]))` left in `DashboardPage.tsx` to neuter.
    //
    // Kept rather than deleted, and the last chapter is worth the space. The
    // static half of `SC-DOWN-13` accepted a catch that *mentioned*
    // `setIsError`, never asking whether anything read what it set — so two
    // panels recorded a failure into state nothing consumed, drew `0`, and this
    // guard was green over them for as long as it existed. `fe-codex` asked the
    // better question and the fig leaf came off. That rule now requires the
    // state to be read, and it flags five sites in the tree as it stood before
    // this merge and none after, which is the coverage this entry had claimed.
    retired: "the shape is gone from this file (fe-t019 routed every list read through one value); SC-DOWN-13's static half now requires the recorded state to be read, which is strictly wider",
    defect:
      "The shape itself, on any screen: `.catch(() => setX([]))`. It is one line, it reads as defensive, and it converts *the server did not answer* into *there is nothing* — the source rule exists because three panels carried it and only one was ever measured.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    suite: "test/fe-render.test.ts",
    expect: ["SC-DOWN-13", "retired"]
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
    // 재앵커 2026-08-20: `unreachable` 상태가 `failure` 로 바뀌었다 — 심는 결함은 같다.
    from: `      .catch((e: unknown) => {
        setRequests([]);
        setFailure(failureKind(e));
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
    // 재앵커 2026-08-20: 상태였던 것이 파생값이 됐다. 늘 참으로 만들면 같은 결함이다.
    from: "  const unreachable = failure !== null;",
    to: "  const unreachable = true;",
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
    id: "rbac-rows-only-for-people-who-already-have-grants",
    defect:
      "The RBAC table built its rows out of the grants themselves, so somebody admitted five minutes ago \u2014 no capabilities, which is how everyone starts \u2014 had no row, and there was no way to give them their first one. The account list was already being fetched for the role column and thrown away for this purpose. The screen that hands out access could not reach anyone who had none.",
    file: "packages/platform-web/src/pages/tenant/RbacManagementPage.tsx",
    from: "      if (roles) {",
    to: "      if (false) {",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-14", "capability cell was not drawn"],
  },
  {
    id: "a-testid-the-scenarios-wait-for-is-renamed",
    defect:
      "A hook renamed in the product while the scenarios still wait for the old name. The cost is not one red test: the wait is thirty seconds, the timeout closes the browser, and every scenario after it fails with `Target page \u2026 closed` \u2014 one rename reads as ninety broken tests, and the real cause is above the noise. `copy landmarks` names a moved sentence in a second; nothing named a moved testid.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "        data-testid=\"bell\"",
    to: "        data-testid=\"bell-renamed\"",
    suite: "test/scenario-ids.test.ts",
    expect: ["testid landmarks", "which no screen emits"],
  },
  {
    id: "a-dead-stream-looks-like-a-live-one",
    defect:
      "The bell had no `onopen`, no `onerror`, and read no `readyState`. When the stream dropped, the initial fetch's answer stayed on screen looking current \u2014 a proposal arriving afterwards never appeared and nothing said so. The operator sitting on the page is the only person this component is for, and the only one who would never find out.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "      es.onerror = () => setStreamLost(true);",
    to: "      es.onerror = () => {};",
    suite: "test/fe-render.test.ts",
    expect: ["SC-LIVE-02", "showed a stale queue as current"],
  },
  {
    id: "pushed-proposal-never-reaches-the-open-page",
    defect:
      "The bell's `key-proposed` listener is bound to a name the stream never sends, so a proposal that arrives after the page did is invisible until somebody reloads. Silent by construction: the queue is correct on every reload, and the only person who notices is the operator sitting on the page while an agent waits to be admitted. Every scenario that touched this stream fulfilled a failure or an empty snapshot \u2014 four of them measured what the screen says when the stream says nothing.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "      es.addEventListener(\"key-proposed\", (e: MessageEvent) => {",
    to: "      es.addEventListener(\"key-proposed-disabled\", (e: MessageEvent) => {",
    suite: "test/fe-render.test.ts",
    expect: ["SC-LIVE-01", "never reached the open page"],
  },
  {
    id: "egress-allowed-only-on-screen",
    defect:
      "`addEgressRuleApi` returns `{ ok: true }` without sending. The cell reads `ALLOW` and \u00a7 12 says a group with no egress rule sends nowhere, so an operator is looking at an open lane that is closed and the group's agents reach nothing. `SC-WRITE-11` cannot see it: it answers both directions from the intercept, so no rule is ever written, and the fixture's single group makes its one cell start `ALLOW` \u2014 the click it exercises is the delete.",
    file: "packages/platform-web/src/api/groups.ts",
    from: "export async function addEgressRuleApi(groupId: string, toGroupId: string): Promise<{ ok: boolean }> {\n  return await apiClient<{ ok: boolean }>(",
    to: "export async function addEgressRuleApi(groupId: string, toGroupId: string): Promise<{ ok: boolean }> {\n  if (groupId) return { ok: true };\n  return await apiClient<{ ok: boolean }>(",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-16", "ticked without the rule being written"],
  },
  {
    id: "approval-reported-but-never-sent",
    defect:
      "`approveKeyProposal` returns `{ ok: true }` without sending. The bell marks the proposal approved and the identity is still waiting on the server \u2014 § 10.2 approval is the one act that admits an identity to the mesh, so the console reports an agent is in while it cannot connect. `SC-WRITE-10` cannot see this: it plants its proposal with `route.fulfill`, and a fingerprint the server never had cannot be approved either way.",
    file: "packages/platform-web/src/api/agents.ts",
    from: "export async function approveKeyProposal(fingerprint: string, reason?: string): Promise<{ ok: boolean }> {\n  return await apiClient<{ ok: boolean }>(\"/api/v1/admin/keys/approve\", {",
    to: "export async function approveKeyProposal(fingerprint: string, reason?: string): Promise<{ ok: boolean }> {\n  if (fingerprint) return { ok: true };\n  return await apiClient<{ ok: boolean }>(\"/api/v1/admin/keys/approve\", {",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-15", "reported an approval the server never took"],
  },
  {
    id: "grant-checked-but-never-sent",
    defect:
      "`addGrantApi` returns `{ ok: true }` without sending. The cell checks, the toast says granted, and nobody holds the capability. A revoke that silently fails leaves access somebody should not have and the next reload says so; a grant that silently fails leaves an operator believing they gave access that nobody has.",
    file: "packages/platform-web/src/api/grants.ts",
    from: "export async function addGrantApi(subject: string, capability: string, scope: string = \"*\"): Promise<{ ok: boolean }> {",
    to: "export async function addGrantApi(subject: string, capability: string, scope: string = \"*\"): Promise<{ ok: boolean }> {\n  if (subject) return { ok: true };",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-14", "checked on screen without being granted"],
  },
  {
    id: "group-created-only-on-screen",
    defect:
      "`createGroupApi` returns `{ ok: true }` without sending anything. The row appears, the toast says created, and the mesh never heard of the group \u2014 the screen agreeing with itself, which is the shape this repository has written down as a check comparing a value to its own source. Measured before `SC-WRITE-12` existed: this mutation left all 114 scenarios in `fe-render` green.",
    file: "packages/platform-web/src/api/groups.ts",
    // **The anchor deliberately stops before the body.** Spelling the request
    // body here put `JSON.stringify({ group_id: name, description })` into this
    // file, and `dropped-fields` reads `scripts/` as caller code — it paired
    // those field names with the nearest route literal and reported this
    // manifest as a caller sending `description, group_id` to
    // `POST /api/v1/messages`. The mutation is an early return instead, which
    // reproduces the same defect and quotes nothing that looks like a call.
    from: "export async function createGroupApi(\n  name: string,\n  description?: string,\n  tenant?: string,\n): Promise<{ ok: boolean; group_id?: string; created?: boolean; group?: any }> {",
    to: "export async function createGroupApi(\n  name: string,\n  description?: string,\n  tenant?: string,\n): Promise<{ ok: boolean; group_id?: string; created?: boolean; group?: any }> {\n  if (name) return { ok: true };",
    suite: "packages/platform-web/src/pages/creator/GroupsPage.test.tsx",
    expect: ["says the group was created, and shows what the server then listed"],
  },
  {
    id: "teardown-reported-but-never-sent",
    defect:
      "`teardownAgentApi` returns `{ ok: true }` without sending the `DELETE`. The row goes, the screen reports the identity torn down, and the agent is still in the mesh \u2014 an irreversible-looking action that did nothing, which is worse than one that fails loudly.",
    file: "packages/platform-web/src/api/agents.ts",
    from: "  return await apiClient<TeardownResponse>(`/api/v1/admin/agents/${encodeURIComponent(identity)}`, {\n    method: \"DELETE\",\n  });",
    to: '  return { ok: true, identity, action: "soft-deleted" };',
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-13", "reported a teardown it never sent"],
  },
  {
    id: "unreachable-blamed-on-a-permission",
    defect:
      "The mirror of `a-refusal-drawn-as-silence`: a screen tells somebody they lack permission when the backend never answered. A console that answers every failure that way passes the check that a refusal must not be drawn as silence \u2014 it never claims the server went quiet, because it never says anything true \u2014 and it sends people to ask for a capability they already hold.",
    file: "packages/platform-web/src/pages/platform/TenantTrafficPage.tsx",
    from: "          failure === \"refused\"",
    to: "          true",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-12", "blamed a permission for a backend that never answered"],
  },
  {
    id: "a-refusal-drawn-as-silence",
    defect:
      "A screen that was refused says the backend went quiet. `I-061` was this on `/platform/telemetry` and `I-111` was the same thing one screen over, both found one at a time \u2014 a refusal is an answer, and telling somebody the server did not respond sends them to check a network that is fine for a permission nobody named.",
    file: "packages/platform-web/src/pages/platform/PlatformOverviewPage.tsx",
    from: "              : `${t(\"overview.partial\", \"\uc774 \uacc4\uc815\uc774 \ubcfc \uc218 \uc5c6\ub294 \ud56d\ubaa9\uc774 \uc788\uc2b5\ub2c8\ub2e4\")} (${telemetry?.refused.length ?? 0})`}",
    to: "              : `\ud1b5\uc2e0 \uc624\ub958 (${telemetry?.refused.length ?? 0})`}",
    suite: "packages/platform-web/src/pages/platform/PlatformOverviewPage.test.tsx",
    expect: ["reports how many reads were refused without exposing machine keys"],
  },
  {
    id: "overview-blames-the-network-for-a-refusal",
    defect:
      "`/platform` computed `failureKind` and `refusedCapability`, stored both, and rendered neither \u2014 every failure came out as `\ud1b5\uc2e0 \uc624\ub958`. A person without `usage.read` was sent to check a network that was fine, for a permission nobody named. `/platform/telemetry` had the same defect one screen over (`I-061`), which is why the banner is a scenario rather than a fix.",
    file: "packages/platform-web/src/pages/platform/PlatformOverviewPage.tsx",
    from: "{(failure === \"refused\" || (telemetry?.refused.length ?? 0) > 0) && (",
    to: "{false && (",
    suite: "test/fe-render.test.ts",
    expect: ["SC-CAP-10", "did not name the capability"],
  },
  {
    id: "bell-decides-without-the-server",
    defect:
      "The bell marks a key proposal `\uc2b9\uc778\ub428` or `\uac70\uc808\ub428` on a write that never landed. The state update sat below the `try`, so a caught error logged to a console nobody has open and the row moved anyway \u2014 an operator was told a key was decided while it was still pending on the server. `keys/deny` had no scenario at all until the front end's write list was read against the suite.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "      setDecisionFailure(failureKind(err));\n      return;",
    to: "      setDecisionFailure(failureKind(err));",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-10", "called a proposal decided on a write that never landed"],
  },
  {
    id: "egress-cell-keeps-a-rule-the-server-refused",
    defect:
      "The ACL cell is set before the call and put back when the call throws. Delete the put-back and the matrix shows a rule the server never took \u2014 the cell is what an operator reads to decide whether a group can send anywhere, so it says `ALLOW` about a group that cannot.",
    file: "packages/platform-web/src/pages/tenant/TenantEgressAclPage.tsx",
    from: "      setRules((prev) => ({\n        ...prev,\n        [sourceId]: {\n          ...(prev[sourceId] || {}),\n          [targetId]: currentAllowed,\n        },\n      }));\n",
    to: "",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-11", "kept a rule the server never took"],
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
    from: "          {item.uptime}",
    to: "          {item.uptime}\uac1c",
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
    from: "    name: me.github_login,",
    to: "    name: `${me.github_login} (운영자)`,",
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
    from: "info [http] seeded the platform-admin local user with AGENT_MESH_ADMIN_PASSWORD",
    to: "info [http] seeded default admin local user",
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
    // The same block is printed for `location /auth/`, so the location line is
    // part of the anchor.
    from: "  location /api/ {\n    proxy_pass http://127.0.0.1:3000;\n    proxy_set_header Host $host;",
    to: "  location /api/ {\n    proxy_pass http://127.0.0.1:3100;\n    proxy_set_header Host $host;",
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
    from: "          refused.push({ panel: p.panel, capability: refusedCapability(err) ?? p.capability });",
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
    // 재앵커 2026-08-20: 두 라벨이 사전을 거치게 됐다. 심는 결함은 같다 —
    // *종류* 자리에 *소속* 이라고 써서 그 필드가 아닌 것을 말하게 한다.
    from: '                    {t("dash.op.kind", "종류")}: <strong>{agt.type ?? "\u2014"}</strong> · {t("dash.op.state", "상태")}:{" "}',
    to: '                    {t("dash.op.kind", "소속")}: <strong>{agt.type ?? "\u2014"}</strong> · {t("dash.op.state", "상태")}:{" "}',
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
    from: "  process.exit(1)",
    to: "  return 'insecure-default' as never",
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
    // **은퇴 2026-08-20 — 이 결함은 갈 자리가 없어졌다.**
    //
    // `status` 를 `"active"` 로 접던 줄이 `api/agents.ts` 에서 통째로 사라졌다.
    // SPEC § 9.1 이 그 라우트에 그런 필드가 없다고 정했고, 화면은 이제 `last_seen_at` 을
    // 읽어 *얼마나 전* 을 말한다 — 없는 필드를 읽던 비교 셋이 죽은 코드였다는 것이
    // 그 커밋의 내용이다.
    //
    // 지우지 않고 근거를 남긴다: 그냥 지우면 다음 사람이 *아무도 생각 안 했구나* 로 읽고
    // 도로 넣는다. 이 엔트리가 막던 것은 **없는 상태를 건강함으로 그리는 것**이고,
    // 그 자리는 지금 `SC-INVENT-*` 가 *서버가 안 보낸 필드를 값으로 그리지 않는가* 로 덮는다.
    retired: "the field this planted into no longer exists; SPEC § 9.1 removed it and SC-INVENT-* covers the shape",
    defect:
      "`status` folded to `\"active\"` when the route sent none, so a screen drew every identity healthy from a field nobody answered with.",
    file: "packages/platform-web/src/api/agents.ts",
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-01", "retired"],
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
    from: "      header: t(\"groups.col.name\", \"\uadf8\ub8f9 \uba85 / ID\"),",
    to: "      header: t(\"groups.col.name\", \"\uadf8\ub8f9 \uba85 / ID (group.manage \ud544\uc694)\"),",
    suite: "test/capability-prose.test.ts",
    expect: ["an internal permission identifier is being shown to a person"],
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
  {
    id: "auth-me-tenant-comes-from-the-row",
    defect:
      "`/auth/me` answered no tenant at all, so a screen asking which tenant this session is in had `undefined` and drew nothing, while `local_users.tenant` held the answer admission had written. `agent-mesh-local-pm` measured it as null on an account that has one. This mutation replaces the row read with the constant `default`, which is the specific wrong answer that a single-tenant test cannot tell from the right one — the check admits two accounts into different tenants for that reason.",
    file: "packages/http/src/main.ts",
    from: "    tenant: getLocalUser(user.github_login)?.tenant ?? null,",
    to: "    tenant: 'default',",
    suite: "test/http.test.ts",
    expect: ["says which tenant the session is in, and says it from the row"],
  },
  {
    id: "agent-listing-scopes-at-all",
    defect:
      "`GET /api/v1/agents` listed the whole registry to anyone approved — `agent-mesh-local-pm` measured an account with no capabilities seeing the same 44 identities as the administrator. This mutation removes the filter, which is the state the route shipped in.",
    file: "packages/http/src/main.ts",
    from: "    .filter(entry => seesEverything || visible.has(entry.id))",
    to: "    .filter(() => true)",
    suite: "test/agents-visibility.test.ts",
    expect: ["a stranger is absent and a correspondent is present"],
  },
  {
    id: "agent-listing-does-not-scope-everything-away",
    defect:
      "The other direction, and the one a one-sided check misses: a route that returns an empty list to every member also hides strangers. `agent-mesh-local-pm`'s first falsification was one-sided — cut the connection, the row disappears — which an empty-list implementation satisfies and which a history-based one can never satisfy. This mutation scopes members down to nothing.",
    file: "packages/http/src/main.ts",
    from: "    .filter(entry => seesEverything || visible.has(entry.id))",
    to: "    .filter(entry => seesEverything && visible.has(entry.id))",
    suite: "test/agents-visibility.test.ts",
    expect: ["a stranger is absent and a correspondent is present", "a group puts its members in each other's list"],
  },
  {
    id: "escape-written-as-jsx-text-on-screen",
    defect:
      "The same defect, judged by opening the menu rather than by reading the source. Both entries are kept because they answer different questions: the source check says it is written correctly, the browser says what is drawn. Nothing in this suite had ever opened this control \u2014 which is why the defect was visible to a person and to no check.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: ">{\"\\u2713\"}</span>}",
    to: ">\\u2713</span>}",
    suite: "test/fe-render.test.ts",
    expect: ["SC-I18N-07", "the language menu drew an escape sequence"],
  },
  {
    id: "escape-written-as-jsx-text",
    defect:
      "The check mark beside the selected language, written between tags instead of inside a string. TypeScript compiles it, every i18n check stays green, and the menu draws six characters. It shipped that way and a person reading the screen found it \u2014 the file's own idiom is escapes two lines above, which is what makes the one that lost its quotes read as correct.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: ">{\"\\u2713\"}</span>}",
    to: ">\\u2713</span>}",
    suite: "test/fe-scenarios.test.ts",
    expect: ["SC-I18N-06", "an escape sequence sits where JSX reads text"],
  },
  {
    id: "reissue-actually-replaces-the-password",
    defect:
      "Admission is the only thing that ever issued a password and it answers 409 to a name that exists, so an account whose holder forgot theirs had no route — `agent-mesh-local-pm` measured the reissue as 409 while walking an account through its first day. This mutation returns a fresh string and writes nothing, which is the shape a reissue fails in: the operator reads out a password that was never stored and the old one still works.",
    file: "packages/http/src/db.ts",
    from: "  db.prepare('UPDATE local_users SET password_hash = ?, must_change_password = 1 WHERE username = ?')",
    to: "  db.prepare('SELECT ? AS ignored WHERE ? IS NOT NULL')",
    suite: "test/http.test.ts",
    expect: ["can be given a new temporary password, which puts them back at the gate"],
  },
  {
    id: "reissue-puts-them-back-behind-the-gate",
    defect:
      "The other half: a reissue that leaves `must_change_password` at 0 hands the holder a password an operator has read out loud and lets them keep it. Everything else about the route still looks right — the old password stops working, the new one signs in — so only an assertion about the gate catches it.",
    file: "packages/http/src/db.ts",
    from: "  db.prepare('UPDATE local_users SET password_hash = ?, must_change_password = 1 WHERE username = ?')",
    to: "  db.prepare('UPDATE local_users SET password_hash = ?, must_change_password = 0 WHERE username = ?')",
    suite: "test/http.test.ts",
    expect: ["can be given a new temporary password, which puts them back at the gate"],
  },
  {
    id: "unread-queue-drawn-as-empty",
    defect:
      "The admission queue's failure branch keeping `[]` instead of `null`. Every failure — a refused capability, a proxy answering 502, a backend that is gone — then draws *Nobody is waiting*, which is a claim the screen is in no position to make. This is the shape the four states exist for, and the reason this queue was worth drawing at all: nothing in this front end asked for it, and silence read exactly like an empty queue.",
    file: "packages/platform-web/src/pages/platform/UserAdminPage.tsx",
    from: "      setQueue(null);",
    to: "      setQueue([]);",
    suite: "test/fe-render.test.ts",
    expect: ["SC-QUEUE-01", "folded `nobody is waiting` together with `I could not ask`"],
  },
  {
    id: "root-redirect-sent-everywhere",
    defect:
      "The router's `/` sending signed-out visitors to the dashboard instead of leaving the guard to answer. The address people type is the one route no scenario opened, so a redirect pointed anywhere at all would have been green — every other scenario names its own route and never types `/`.",
    file: "packages/platform-web/src/App.tsx",
    from: '<Route path="/" element={<Navigate to="/dashboard" replace />} />',
    to: '<Route path="/" element={<Navigate to="/creator" replace />} />',
    suite: "test/fe-render.test.ts",
    expect: ["SC-NAV-05", "the root address did not land where the router says it should"],
  },
  {
    id: "delete-absence-404-again",
    defect:
      "The egress delete answering `404` for a target that was not there, alongside `ok: true` — a status and a body saying opposite things about one call. SPEC \u00a7 9.2a says a delete whose target is absent answers `200` and the body names which of the two happened. Four delete routes had four answers and four passing tests, because each test asserted whatever its own route did; `agent-mesh-local-pm` found this one by holding the clause against the running stack (mail #1556), and a contract scenario had already ratified the `404`.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ ok: true, action: removed ? 'deleted' : 'not-found' })\n})\n\n/** Who is answerable",
    to: "  return c.json({ ok: true, removed }, removed ? 200 : 404)\n})\n\n/** Who is answerable",
    suite: "test/delete-absence.test.ts",
    expect: ["egress/:to_group answers 200 and says which happened"],
  },
  {
    id: "delete-route-off-the-manifest",
    defect:
      "A delete route existing in the source with no absent-case written down. The list is derived from `main.ts` and compared both ways precisely so the next route added cannot inherit silence: without this the file tests four routes forever while the service grows a fifth.",
    file: "packages/http/src/main.ts",
    from: "app.delete('/api/v1/admin/grants',",
    to: "app.delete('/api/v1/admin/absence-mutant', async (c) => c.json({ ok: true }))\napp.delete('/api/v1/admin/grants',",
    suite: "test/delete-absence.test.ts",
    expect: ["every delete route in the source is accounted for here"],
  },
  {
    id: "delete-absence-regex-matches-nothing",
    defect:
      "The route-extracting regex matching nothing, which would make the two set comparisons pass against an empty list \u2014 the failure mode of every test that derives its own subject. The floor is what catches it, and it is the reason the floor is written as a number rather than as `length > 0`.",
    file: "test/delete-absence.test.ts",
    from: "/app\\.delete\\(\\s*'([^']+)'/g",
    to: "/app\\.NOSUCH\\(\\s*'([^']+)'/g",
    suite: "test/delete-absence.test.ts",
    expect: ["every delete route in the source is accounted for here"],
  },
  {
    id: "bell-stream-drop-read-as-unreachable",
    defect:
      "A dropped SSE stream reported as *could not ask*. `EventSource` reconnects on its own, so an error means the rows on screen are the last thing received — a claim about the channel — while `unreachable` is a claim that the queue was never read. This mutant passed every assertion in the bell's own spec, because with rows present `unreachable` has nothing to draw: the `?` badge is gated on an empty count and the unreachable empty-state renders only for an empty list. The state was invisible, so the test asserts it on an empty queue, where the two sentences differ.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "      es.onerror = () => setStreamLost(true);",
    to: "      es.onerror = () => { setStreamLost(true); setFailure(\"unreachable\"); };",
    suite: "packages/platform-web/src/components/layout/NotificationBell.test.tsx",
    expect: ["does not turn a dropped stream into a queue it could not read"],
  },
  {
    id: "groups-page-invents-a-creation-time",
    defect:
      "A group the route sent no `created_at` for drawn with a fixed timestamp, `2026-08-17 12:00:00`. `api/groups.ts` keeps that field `null` on purpose — its own comment says drawing a group as reaching nothing is a claim — and this line made the same kind of claim about time. A plausible date is worse than a plausible name: an operator can doubt `admin` on sight and cannot doubt a timestamp. Found by agent-mesh-local-pm sweeping for a preserved unknown with a collapsed one beside it (I-161).",
    file: "packages/platform-web/src/pages/creator/GroupsPage.tsx",
    from: "          createdAt: g.created_at ? new Date(g.created_at).toLocaleString() : null,",
    to: "          createdAt: g.created_at ? new Date(g.created_at).toLocaleString() : \"2026-08-17 12:00:00\",",
    suite: "packages/platform-web/src/pages/creator/GroupsPage.test.tsx",
    expect: ["draws no creation time rather than a plausible one"],
  },
  {
    id: "groups-page-loses-a-real-zero",
    defect:
      "`member_count || g.members?.length || 0` sends a group that really holds nobody down the same road as one the route said nothing about: `0` is falsy, so the real measurement falls through to the fallback. `??` keeps them apart, and `null` then draws as absent rather than as nought.",
    file: "packages/platform-web/src/pages/creator/GroupsPage.tsx",
    from: "          const counted = g.member_count ?? null;",
    to: "          const counted = g.member_count ?? 0;",
    suite: "packages/platform-web/src/pages/creator/GroupsPage.test.tsx",
    expect: ["draws no member count rather than nought"],
  },
  {
    id: "playground-parses-free-text-while-rendering",
    defect:
      "`JSON.parse(payloadText)` in the receipt panel's JSX. `sendMessageApi` sends `text`, so the field is free text and nothing requires JSON — the default happens to be a JSON preset, which is the only reason the happy path never showed it. Type a word, send it successfully, and the parse threw while React was drawing the receipt for a message the mesh had already accepted. It also read the textarea's *current* value, so editing the box after a send rewrote the panel labelled `what was dispatched` under a receipt that had not moved. agent-mesh-local-pm found it in the unverified list and pushed SC-WRITE-17 red to hold the place (I-156).",
    file: "packages/platform-web/src/pages/creator/PlaygroundPage.tsx",
    from: "              <JsonViewer data={asBody(dispatched)} title={t(\"play.dispatched\", \"보낸 본문\")} />",
    to: "              <JsonViewer data={JSON.parse(payloadText || \"{}\")} title={t(\"play.dispatched\", \"보낸 본문\")} />",
    suite: "packages/platform-web/src/pages/creator/PlaygroundPage.test.tsx",
    expect: ["draws the receipt for a message the mesh accepted"],
  },
  {
    id: "bell-drops-an-empty-snapshot",
    defect:
      "`if (list.length > 0)` around the snapshot reader, so a queue somebody else drained never cleared: the bell went on showing proposals the hub had already decided and the badge went on counting them. *Nothing is waiting* is a statement the stream is entitled to make, and the guard threw it away. Found by agent-mesh-local-pm (I-152).",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: "          if (Array.isArray(list)) {",
    to: "          if (list.length > 0) {",
    suite: "packages/platform-web/src/components/layout/NotificationBell.test.tsx",
    expect: ["takes the rows down when the stream says nothing is waiting"],
  },
  {
    id: "confirm-dialog-leaves-escape-open-mid-action",
    defect:
      "`isLoading` disabled the two footer buttons and handed `onClose` to `Modal` unchanged, so Escape and the backdrop still dismissed a dialog whose destructive request was already in flight. The request goes on, the operator is told nothing, and the screen keeps no record that anything was asked. The buttons were the only exit anybody had checked (I-159).",
    file: "packages/platform-web/src/components/feedback/ConfirmDialog.tsx",
    from: "      onClose={isLoading ? () => {} : onClose}",
    to: "      onClose={onClose}",
    suite: "packages/platform-web/src/components/feedback/ConfirmDialog.test.tsx",
    expect: ["locks every way out while the action it asked for is in flight"],
  },
  {
    id: "fingerprint-copy-fails-in-silence",
    defect:
      "A refused clipboard — no permission, an insecure origin — caught and dropped under a comment reading `// Fallback`, with no fallback. The button went on saying `Copy`, so a person who pressed it and moved on pasted whatever was there before. It never claimed success, so this is silence rather than a lie; the fingerprint is the one value on that card somebody carries elsewhere to compare, and silence about it is its own kind of wrong. One of six swallowing catches agent-mesh-local-pm swept out (I-165).",
    file: "packages/platform-web/src/components/data/FingerprintBox.tsx",
    from: "      setCopied(false);\n      setFailed(true);",
    to: "      // swallowed",
    suite: "packages/platform-web/src/components/data/FingerprintBox.test.tsx",
    expect: ["says the copy failed rather than saying nothing"],
  },
  {
    id: "second-ack-records-a-second-delivery",
    defect:
      "The acknowledgement matched on `id AND to_agent` alone, and SQLite counts a row it rewrote with identical values as changed — so `receive()` saw `changes > 0` on a repeated acknowledgement and fired `onSettled` again, putting a second `delivered` event behind one message. That is what § 8.9.4 forbids and what `receive()`'s own comment says the hook is placed on acknowledgement to avoid. The retry it happens on is the documented one: a caller retrying an ambiguous receive re-sends the same ids, which is why ids it does not hold are ignored rather than refused.",
    file: "packages/store/src/schema/hub.ts",
    from: "      WHERE id = ?1 AND to_agent = ?2 AND status = 'pending'",
    to: "      WHERE id = ?1 AND to_agent = ?2",
    suite: "packages/mailbox/src/receive.test.ts",
    expect: ["reports each settled message once, on acknowledgement rather than hand-out"],
  },
  {
    id: "pairing-code-withholds-the-window-it-granted",
    defect:
      "The pairing-code route validated `ttl_seconds` and did not send it back. `PairingCodeResponse` declares the field as required and `RegisterAgentPage` reads `res.ttl_seconds || selectedTtl`, so the countdown on screen came from the *requested* value on every call — the fallback was the only path and the type was describing a field that never arrived. The two agree today because the route refuses a window outside its range rather than clamping one into it, which is why this was invisible.",
    file: "packages/http/src/main.ts",
    from: "expires_at: code.expires_at, ttl_seconds: ttl }, 201)",
    to: "expires_at: code.expires_at }, 201)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a pairing code is minted for a name the mesh will accept"],
  },
  {
    id: "mailbox-prefix-claims-a-sibling-name",
    defect:
      "The hub dispatched on `startsWith(\"/api/v1/mailbox\")` while `rest/mailbox.ts` matched its four paths exactly, so `/api/v1/mailboxfoo` entered the branch and was refused inside it. Nothing leaked — the refusal is above `authenticate` — but the branch `return`s rather than falling through, so any route added below it whose path began with those letters was unreachable and nothing said so. Invisible from outside: measured on a booted hub, the sibling name answered `404 Not Found`, `text/plain`, nine bytes, exactly as an unrouted path does. 64a1be9 named this one and left it.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: '  return pathname === "/api/v1/capabilities" || isMailboxPath(pathname);',
    to: '  return pathname === "/api/v1/capabilities" || pathname.startsWith("/api/v1/mailbox");',
    suite: "packages/hub/src/mailbox-path.test.ts",
    expect: ["/api/v1/mailboxfoo is not"],
  },
  {
    id: "mailbox-recall-claims-a-sibling-name",
    defect:
      "The same boundary one level down. `/api/v1/mailbox/out/<id>` recalls a message a sender may still withdraw; dropping the trailing separator makes `/api/v1/mailbox/outfoo` a recall path, which the handler then routes on a suffix it parsed out of a name that was never an id. Registered beside the entry above because the fix for one is the reason to look at the other, and only a predicate test can tell either apart from a 404.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: '    pathname.startsWith("/api/v1/mailbox/out/")',
    to: '    pathname.startsWith("/api/v1/mailbox/out")',
    suite: "packages/hub/src/mailbox-path.test.ts",
    expect: ["/api/v1/mailbox/outfoo is not"],
  },
  {
    id: "audit-append-accepts-a-schema-it-cannot-validate",
    defect:
      "`mesh.audit.append` stopped refusing an event whose `schema_version` is newer than this hub validates. The event is then stored, and storing an event the hub cannot validate records `validated` as a falsehood — which is why the refusal exists rather than a best-effort parse. Nothing is lost by refusing: the client's outbox retries and drains after the hub is upgraded.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "  if (schemaVersion > MAX_SCHEMA_VERSION) {",
    to: "  if (false) {",
    suite: "packages/hub/src/rpc/audit.test.ts",
    expect: ["a schema_version newer than this hub validates"],
  },
  {
    id: "prepare-blobs-forgets-the-per-event-total",
    defect:
      "`mesh.audit.prepare_blobs` checked each blob against `max_blob_bytes` and stopped checking their sum against `max_attachments_bytes_per_event`. Every blob is individually legal and the event is not — the limit only a sum can breach, and the one a per-blob check cannot see. The hub would issue upload grants for more bytes than it advertises it will hold.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "  if (declaredTotal > AUDIT_LIMITS.max_attachments_bytes_per_event) {",
    to: "  if (false) {",
    suite: "packages/hub/src/rpc/audit.test.ts",
    expect: ["blobs that are each small enough and too large together"],
  },
  {
    id: "prepare-blobs-accepts-a-blob-with-no-name",
    defect:
      "The storage key retains the file extension (\u00a7 15.2), so the digest alone does not determine where the bytes land. Dropping the `name` requirement makes two implementations of one normalisation rule two chances to disagree, and a disagreement here does not fail loudly \u2014 it splits one blob into two, found much later as storage that will not deduplicate.",
    file: "packages/hub/src/rpc/audit.ts",
    from: '    if (typeof name !== "string" || name.length === 0) {',
    to: "    if (false) {",
    suite: "packages/hub/src/rpc/audit.test.ts",
    expect: ["a blob with no name"],
  },
  {
    id: "missing-blobs-refuses-without-naming-which",
    defect:
      "The `AUDIT_MISSING_BLOBS` refusal stopped carrying `missing_sha256`. The refusal is transient by design \u2014 the client uploads and retries \u2014 but a client told only that *some* attachment is missing has to re-upload all of them, which is the cost this list exists to avoid.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "      missing_sha256: missing,",
    to: "      missing_sha256: [],",
    suite: "packages/hub/src/rpc/audit.test.ts",
    expect: ["attachments whose bytes are not on disk, naming each"],
  },
  {
    id: "refused-proxy-claim-still-gets-the-replay",
    defect:
      "The pending-mail replay walked the *declared* proxy list instead of the granted one, so a claim the caller was not entitled to still had that identity's queued mail sent down this socket and the rows flipped to `delivered`. The rightful recipient never receives it \u2014 a delivered row is never replayed \u2014 and the audit trail says they did. \u00a7 8.2 says a refused entry is not wired into the socket's routing, and the replay is routing. The comment above the loop already said `granted, not declared`; nothing asked whether the code agreed.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "  for (const pid of granted) {",
    to: "  for (const pid of proxyFor) {",
    suite: "packages/hub/src/rpc/connect.test.ts",
    expect: ["its queued mail is neither sent to that socket nor marked delivered"],
  },
  {
    id: "connect-admits-an-identity-nobody-provisioned",
    defect:
      "`mesh.connect` stopped requiring the identity to exist in the agents table. That is the pattern `POST /api/v1/agents` was made the registration SSOT to end (\u00a7 10.1): connecting auto-created a typeless row, and the console showed the agent as `Unknown` for ever with nothing to say why.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "  if (!exists) {",
    to: "  if (false) {",
    suite: "packages/hub/src/rpc/connect.test.ts",
    expect: ["an identity that was never provisioned"],
  },
  {
    id: "a-contender-evicts-the-live-owner",
    defect:
      "The duplicate-identity guard stopped refusing, so a second socket claiming a live identity took the online map from the socket that was already there. The incumbent stays connected and silently stops receiving \u2014 the P0 stall this ownership check was added for. First established owner wins, however late the collision arrives.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "  if (!ownership.ok) {",
    to: "  if (false) {",
    suite: "packages/hub/src/rpc/connect.test.ts",
    expect: ["a second socket claiming a live identity, keeping the incumbent"],
  },
  {
    id: "any-socket-may-proxy-any-identity",
    defect:
      "The entitlement verdict on each `proxy_for` entry stopped being consulted, so a socket was wired into `proxyMap` for identities it may not act for (\u00a7 8.2). Combined with the replay above this is impersonation with delivery attached; alone it is enough, because `mesh.send` then routes that identity's traffic to a socket nobody entitled.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "      if (!verdict.ok) {",
    to: "      if (false) {",
    suite: "packages/hub/src/rpc/connect.test.ts",
    expect: ["an entry the caller may not act for is dropped"],
  },
  {
    id: "signature-required-only-where-a-key-exists",
    defect:
      "Whether a request must be signed stopped being a property of the identity's *type*. That is the open door this file's header describes: `requires_key = 1` means there is no unsigned path at all, and verifying only where an approved key already exists lets a caller register without one and then connect unsigned \u2014 skipping the authentication the audit trail depends on. It reads as backward compatibility, which is why it survived a draft.",
    file: "packages/hub/src/signature.ts",
    from: "    if (!mustSign) return OK_UNSIGNED;",
    to: "    return OK_UNSIGNED;",
    suite: "packages/hub/src/signature.test.ts",
    expect: ["an unsigned request from a type that requires one is refused"],
  },
  {
    id: "signature-freshness-window-stops-biting",
    defect:
      "The \u00b1window check on `iat` stopped refusing, so a captured envelope verifies for ever. Freshness is checked before the nonce is claimed on purpose \u2014 a stale request is rejected without its nonce entering the window, so an attacker cannot fill the map with entries that were never going to be accepted \u2014 and with this gone both properties fall together.",
    file: "packages/hub/src/signature.ts",
    from: "  if (Math.abs(now - iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {",
    to: "  if (false) {",
    suite: "packages/hub/src/signature.test.ts",
    expect: ["an iat outside the freshness window is refused, on both sides"],
  },
  {
    id: "a-spent-nonce-can-be-spent-again",
    defect:
      "The replay guard stopped consulting the nonce window, so one captured envelope can be presented repeatedly inside its freshness window. The claim happens *before* the signature is checked (\u00a7 8.1), which is what makes a failed attempt consume the nonce as well \u2014 recording only on success would let a captured envelope be replayed unboundedly against a hub whose key state had changed, because each attempt would fail verification and leave the nonce spendable.",
    file: "packages/hub/src/signature.ts",
    from: "  if (!nonces.claim(identity, nonce, iat)) {",
    to: "  if (false) {",
    suite: "packages/hub/src/signature.test.ts",
    expect: ["a nonce already seen in the window is refused the second time"],
  },
  {
    id: "no-approved-key-reported-as-a-bad-signature",
    defect:
      "`KEY_NOT_APPROVED` collapsed into the generic signature refusal, so a client cannot tell *wait for an operator* (`pending`) from *stop and ask a person* (`denied`, `revoked`) from *your signature is wrong*. Reporting them as one error makes a client retry through a shutoff, and the key status the refusal carries is the only thing that tells it which.",
    file: "packages/hub/src/signature.ts",
    from: '  if (outcome.reason === "no-approved-key") {',
    to: "  if (false) {",
    suite: "packages/hub/src/signature.test.ts",
    expect: ["an identity with no approved key is refused with its key status"],
  },
  {
    id: "signed-mailbox-surface-stops-checking-the-signature",
    defect:
      "The REST mailbox surface stopped acting on the authentication verdict, so every route beneath it \u2014 taking delivery, reading history, listing and recalling \u2014 answers an unsigned caller. \u00a7 9.2.1 is the whole reason these routes exist as a *signed* surface rather than a mailer with a token.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: "  if (!auth.ok) return json(auth.refusal.status, auth.refusal.body);",
    to: "  if (false) return json(401, { ok: false });",
    suite: "packages/hub/src/rest/mailbox-routes.test.ts",
    expect: ["every owned path when nothing is signed"],
  },
  {
    id: "capabilities-falls-behind-the-signature-it-precedes",
    defect:
      "`/api/v1/capabilities` stopped being answered here, so it falls past the mailbox branch and the hub answers `404`. It is unsigned deliberately (\u00a7 9.2.1): the values matter most while a caller cannot yet sign, so a `pending` key can read the lease window it needs to size its retry loop before an operator has approved anything. Putting it behind the signature it exists to precede is a deadlock, not a hardening.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: '  if (pathname === "/api/v1/capabilities") {',
    to: "  if (false) {",
    suite: "packages/hub/src/rest/mailbox-routes.test.ts",
    expect: ["capabilities answers without a signature"],
  },
  {
    id: "history-without-a-peer-is-answered-instead-of-refused",
    defect:
      "`GET /api/v1/mailbox/history` stopped requiring `peer`. The route is a conversation between two identities; without the other one it either answers everything the caller can see or nothing, and both are a different question from the one the route is for.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: '      return json(400, { ok: false, error: "peer is required", rpc_code: MESH_ERROR.INVALID_PARAMS });',
    to: "      return json(200, { ok: true, messages: [] });",
    suite: "packages/hub/src/rest/mailbox-routes.test.ts",
    expect: ["a history request with no peer"],
  },
  {
    id: "recall-of-a-stranger-message-answers-something-else",
    defect:
      "A recall scoped to the sender stopped refusing a message this sender never sent. The refusal is the same sentence as for an id that does not exist, on purpose \u2014 the alternative tells a caller whether an id they guessed is real, which is an enumeration oracle over every message on the mesh.",
    file: "packages/hub/src/rest/mailbox.ts",
    from: '    return json(404, { ok: false, error: "no such message from this sender" });',
    to: "    return json(200, { ok: true, recalled: false });",
    suite: "packages/hub/src/rest/mailbox-routes.test.ts",
    expect: ["a recall of a message this sender never sent"],
  },
  {
    id: "dedup-key-is-unique-for-ever-not-while-pending",
    defect:
      "The reminder dedup index stopped being scoped to `active`, so an idempotency key could be used once and never again. \u00a7 8.5 makes the key unique among a caller's *pending* reminders precisely so it can be reused after the previous one fired or was cancelled \u2014 without that, a daily job is schedulable exactly once. The careless refactor is small: dropping the status clause still leaves a valid, unique, plausible-looking index.",
    file: "packages/store/src/schema/self-reminder.ts",
    from: "      WHERE status = 'active' AND idempotency_key IS NOT NULL;",
    to: "      WHERE idempotency_key IS NOT NULL;",
    suite: "packages/store/src/schema/self-reminder.test.ts",
    expect: ["the key is free once the first has fired or been cancelled"],
  },
  {
    id: "dedup-key-is-global-instead-of-per-owner",
    defect:
      "The reminder dedup index stopped leading with the owner, making an idempotency key unique across the whole mesh. One caller's `daily-summary` would then refuse every other caller's \u2014 a cross-tenant collision on a value each of them chooses freely, and a way to discover that another identity holds a given key.",
    file: "packages/store/src/schema/self-reminder.ts",
    from: "      ON reminders (agent_id, idempotency_key)",
    to: "      ON reminders (idempotency_key)",
    suite: "packages/store/src/schema/self-reminder.test.ts",
    expect: ["two owners may hold the same key at once"],
  },
  {
    id: "reminder-schedule-type-stops-being-constrained",
    defect:
      "`reminders.type` stopped constraining itself to `once`, `cron` and `interval`. The scheduler switches on that column, so an unrecognised value is a row that is never fired and never reported \u2014 the reminder simply does not happen, and nothing says why.",
    file: "packages/store/src/schema/self-reminder.ts",
    from: "      type TEXT NOT NULL CHECK (type IN ('once','cron','interval')),",
    to: "      type TEXT NOT NULL,",
    suite: "packages/store/src/schema/self-reminder.test.ts",
    expect: ["a schedule type outside the three"],
  },
  {
    id: "delivery-status-stops-being-constrained",
    defect:
      "`audit_log.delivery_status` stopped constraining itself to the six outcomes. This column is the delivery record for a reminder (\u00a7 3.3), and a value outside the set is a row that reads as neither delivered nor failed \u2014 an audit trail that answers a question nobody can act on.",
    file: "packages/store/src/schema/self-reminder.ts",
    from: "        CHECK (delivery_status IN ('firing','delivered','queued','failed','skipped','dedup')),",
    to: "        CHECK (delivery_status IS NOT NULL),",
    suite: "packages/store/src/schema/self-reminder.test.ts",
    expect: ["a delivery status outside the six"],
  },
  {
    id: "upload-grant-authorises-another-key",
    defect:
      "`checkGrant` stopped comparing `blob_key`, so a grant issued for one blob authorises a write to any other. Every bound field is compared rather than trusted from the request because the request is what is being authorised \u2014 without this an upload can be redirected over an unrelated blob, using a grant its holder was legitimately given.",
    file: "packages/store/src/nonces.ts",
    from: '  if (row.blob_key !== blobKey) return { ok: false, reason: "wrong-blob" };',
    to: "  // no key check",
    suite: "packages/store/src/nonces.test.ts",
    expect: ["a write aimed at a different key"],
  },
  {
    id: "upload-grant-outlives-its-window",
    defect:
      "`checkGrant` stopped refusing an expired grant. The sweep is deliberately not on the upload path \u2014 an expired row is already refused by this check, so sweeping there would make every upload pay for the whole table \u2014 which means removing the check leaves nothing at all enforcing the window: an old grant works until a sweep happens to run.",
    file: "packages/store/src/nonces.ts",
    from: '  if (row.expired) return { ok: false, reason: "expired" };',
    to: "  // never expires",
    suite: "packages/store/src/nonces.test.ts",
    expect: ["a grant whose window has passed"],
  },
  {
    id: "upload-grant-is-transferable",
    defect:
      "`checkGrant` stopped comparing the identity, so any caller holding a nonce can upload under the grant it was issued to. Grants travel in a response body; the binding is what stops one being used by whoever reads it next.",
    file: "packages/store/src/nonces.ts",
    from: '  if (row.identity !== identity) return { ok: false, reason: "wrong-identity" };',
    to: "  // anyone may present it",
    suite: "packages/store/src/nonces.test.ts",
    expect: ["another identity presenting it"],
  },
  {
    id: "fetch-messages-reaches-past-its-ceiling",
    defect:
      "`mesh.fetch_messages` stopped clamping `limit` to 200. \u00a7 8.4 dropped the cursor, so `limit` is the only reach a caller has and the ceiling is the only thing bounding one request \u2014 an unclamped value asks the store for the whole conversation in a single frame.",
    file: "packages/hub/src/rpc/messages.ts",
    from: '  const limit = Math.min(Math.max(parseInt(params.limit ?? "20", 10) || 20, 1), 200);',
    to: '  const limit = Math.max(parseInt(params.limit ?? "20", 10) || 20, 1);',
    suite: "packages/hub/src/rpc/messages.test.ts",
    expect: ["down to two hundred, whatever is asked for"],
  },
  {
    id: "fetch-messages-answers-one-side-of-a-conversation",
    defect:
      "The history query stopped being symmetric, so `mesh.fetch_messages` answers only what the peer sent. History *with a peer* is not *what they sent me*: whoever spoke last sees an empty conversation, and a client rendering it draws a thread missing every one of its own messages.",
    file: "packages/hub/src/db.ts",
    from: "  WHERE (from_agent = ?1 AND to_agent = ?2)\n     OR (from_agent = ?2 AND to_agent = ?1)",
    to: "  WHERE (from_agent = ?2 AND to_agent = ?1)",
    suite: "packages/hub/src/rpc/messages.test.ts",
    expect: ["the conversation, not one side of it, newest first"],
  },
  {
    id: "torn-down-and-already-gone-look-the-same",
    defect:
      "The console folded `soft-deleted` into `already-deleted`, so an identity destroyed on this click reads as one that was already gone. The route has answered all three since 071db59 and the screen threw the distinction away for a day; teardown is irreversible, and a console that cannot say whether *this* call did it is the most expensive place to be vague.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: '            testId: "teardown-result-soft-deleted",',
    to: '            testId: "teardown-result-already-deleted",',
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-18", "soft-deleted was folded"],
  },
  {
    id: "already-gone-reads-as-torn-down-now",
    defect:
      "The other direction: `already-deleted` drawn as `soft-deleted`, so a second confirm on an identity somebody else tore down reports a destruction this operator did not cause. Worse than the first fold, because the route is idempotent and answers `200` \u2014 nothing else on the screen contradicts it.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: '            testId: "teardown-result-already-deleted",',
    to: '            testId: "teardown-result-soft-deleted",',
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-19", "already-deleted was folded"],
  },
  {
    id: "an-identity-that-was-never-there-reads-as-torn-down",
    defect:
      "`not-found` drawn as `soft-deleted`. The operator typed or clicked an identity this mesh does not hold, and the console tells them they destroyed it \u2014 a report of an irreversible act that never happened, against a name that may belong to a mesh they are not looking at.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: '            testId: "teardown-result-not-found",',
    to: '            testId: "teardown-result-soft-deleted",',
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-20", "not-found was folded"],
  },
  {
    id: "teardown-confirm-sends-twice",
    defect:
      "The in-flight guard on the teardown confirm was removed, so a second click while the `DELETE` is still going sends a second one. The dialog closes only after the await returns, which is what leaves the armed button live for the whole request. Bounded by the route being idempotent \u2014 which is exactly why nothing on screen would have shown it.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: "    if (!teardownTarget || teardownInFlight.current) return;",
    to: "    if (!teardownTarget) return;",
    suite: "test/fe-render.test.ts",
    expect: ["SC-WRITE-21"],
  },
  {
    id: "an-unparseable-last-seen-reads-as-no-record",
    defect:
      "`lastSeen` folded its `invalid` branch into `never`, so a timestamp the mesh *did* send but that will not parse is drawn as *no presence record*. \u00a7 9.1 makes those two different facts \u2014 `null` means the mesh holds no record, and a malformed value means something upstream is broken \u2014 and collapsing them hides the second behind a sentence that reads as normal.",
    file: "packages/platform-web/src/api/agents.ts",
    from: '  if (Number.isNaN(seen)) return { kind: "invalid" };',
    to: '  if (Number.isNaN(seen)) return { kind: "never" };',
    suite: "test/fe-render.test.ts",
    expect: ["SC-INVENT-08"],
  },
  {
    id: "the-console-union-drifts-from-the-store",
    defect:
      "The console's local `TeardownAction` stopped matching `packages/store/src/teardown.ts`. It is a copy on purpose \u2014 `@agent-mesh/store` opens `bun:sqlite` and a browser bundle must not take its type graph, and `@agent-mesh/contracts` does not carry teardown yet \u2014 so nothing but a source comparison can see the two come apart. Neither module imports the other, so both halves compile; the screen then tests `action === \"not-found\"` against a value the route never sends and every teardown falls through to the failure branch.",
    file: "packages/platform-web/src/api/agents.ts",
    from: 'export type TeardownAction = "soft-deleted" | "already-deleted" | "not-found";',
    to: 'export type TeardownAction = "soft-deleted" | "already-deleted" | "missing";',
    suite: "test/teardown-union.test.ts",
    expect: ["the console's local copy matches the store's"],
  },
  {
    id: "blob-upload-skips-the-grant-check",
    defect:
      "The blob upload stopped asking whether the grant authorises *this* upload, so a nonce issued for one blob writes to any key, at any size. The grant is the whole authorisation \u2014 `identity` is taken from it rather than from the request \u2014 and without the comparison a caller with any valid nonce can overwrite any content-addressed blob it can name.",
    file: "packages/http/src/audit-blobs.ts",
    from: "  if (!check.ok) {",
    to: "  if (false) {",
    suite: "packages/http/src/audit-blobs.test.ts",
    expect: ["a key the grant was not issued for"],
  },
  {
    id: "blob-upload-names-which-bound-field-disagreed",
    defect:
      "The grant refusal put `check.reason` back into the message. Naming which bound field disagreed lets a caller holding a nonce probe what it was issued for \u2014 key, size, or holder \u2014 one request at a time. The reason belongs in the log, where the operator is and the caller is not. This is not hypothetical: the message carried the reason under a comment forbidding it from the commit that introduced both.",
    file: "packages/http/src/audit-blobs.ts",
    from: "    return refuse(403, 'upload grant does not authorise this upload')",
    to: "    return refuse(403, `upload grant does not authorise this upload (${check.reason})`)",
    suite: "packages/http/src/audit-blobs.test.ts",
    expect: ["a key the grant was not issued for"],
  },
  {
    id: "a-stolen-nonce-is-enough-to-upload",
    defect:
      "The upload stopped verifying the signature, so possession of a nonce is possession of the grant. Grants travel in a response body and the signature is what makes a stolen one useless \u2014 it is checked against the *grant holder's* approved key, not against any identity the request names, so a thief cannot substitute a key of their own either.",
    file: "packages/http/src/audit-blobs.ts",
    from: "  if (!outcome.ok) {",
    to: "  if (false) {",
    suite: "packages/http/src/audit-blobs.test.ts",
    expect: ["someone else's key over the right grant"],
  },
  {
    id: "blob-stored-without-matching-its-digest",
    defect:
      "The upload stopped comparing what arrived against the digest the grant authorised, so bytes land under a content-addressed key that does not describe them. Every later reader trusts the key as the digest; an audit event referencing that blob then claims an attachment it does not have. The rename happens last precisely so nothing exists under that name until the digest matches.",
    file: "packages/http/src/audit-blobs.ts",
    from: "  if (digest !== grant.sha256) {",
    to: "  if (false) {",
    suite: "packages/http/src/audit-blobs.test.ts",
    expect: ["refuses bytes whose digest is not the one the grant authorised"],
  },
  {
    id: "a-truncated-upload-is-accepted-as-whole",
    defect:
      "The upload stopped checking that the byte count it received is the one the grant authorised, so a connection that drops mid-stream is stored as a complete blob. `prepare_blobs` reports a blob present only when the stored size matches, for exactly this reason \u2014 a file of the right name and the wrong length is an interrupted upload, and accepting it lets an event reference truncated bytes as verified.",
    file: "packages/http/src/audit-blobs.ts",
    from: "  if (received !== grant.size) {",
    to: "  if (false) {",
    suite: "packages/http/src/audit-blobs.test.ts",
    expect: ["refuses a body shorter than the declaration"],
  },
  {
    id: "a-refused-oauth-code-mints-a-session",
    defect:
      "`exchangeCodeForToken` stopped reading the error GitHub returns. GitHub answers `200` with an error *body* for a stale or replayed code, so the status is not the signal \u2014 dropping the payload check makes a refused exchange look like a successful one, and the callback then signs a JWT around `undefined`.",
    file: "packages/http/src/auth.ts",
    from: "  if (data.error || !data.access_token) {",
    to: "  if (false) {",
    suite: "packages/http/src/auth-github.test.ts",
    expect: ["throws GitHub's own description when it refuses the code"],
  },
  {
    id: "a-rejected-github-token-reads-as-a-user",
    defect:
      "`getGithubUser` stopped checking `res.ok`, so a `401` from GitHub is parsed as a user record. Every field then arrives `undefined`, and the identity a session is minted around is nobody \u2014 which is worse than an error, because it succeeds.",
    file: "packages/http/src/auth.ts",
    from: "  if (!res.ok) {",
    to: "  if (false) {",
    suite: "packages/http/src/auth-github.test.ts",
    expect: ["throws with the status when GitHub refuses the token"],
  },
  {
    id: "oauth-callback-runs-without-a-code",
    defect:
      "The callback stopped requiring `code`, so an arrival with no parameter reaches the token exchange and fails there instead. The person sees a `500` where they should see a plain refusal, and the service makes a request to GitHub on behalf of a request that carried nothing.",
    file: "packages/http/src/main.ts",
    from: "  if (!code) {",
    to: "  if (false) {",
    suite: "packages/http/src/auth-github.test.ts",
    expect: ["refuses to start without a code"],
  },
  {
    id: "nobody-learns-an-account-is-waiting",
    defect:
      "An unapproved sign-in stopped leaving a pending approval behind. From the browser it is indistinguishable from an approved one \u2014 same `302`, same cookie \u2014 and the only difference is a row an operator later reads. Without it nobody ever learns somebody is waiting, and the person meets a console that refuses them with no way to ask.",
    file: "packages/http/src/main.ts",
    from: "      if (!existing || existing.status === 'denied') {",
    to: "      if (false) {",
    suite: "packages/http/src/auth-github.test.ts",
    expect: ["leaves a pending approval behind for someone not yet approved"],
  },
  {
    id: "an-attachment-route-that-names-what-it-holds",
    defect:
      "The attachment route stopped answering *not party to it* and *does not exist* with one sentence. The ids are digests, so an answer distinguishing them is a probe for which content the mesh holds \u2014 a caller who has seen an id in a log line, an audit event or a forwarded `download_url` can then confirm the bytes are here without being party to anything.",
    file: "packages/http/src/main.ts",
    from: "    return c.json({ error: 'Not found' }, 404)\n  }\n\n  const filePath = join(UPLOAD_DIR, id)",
    to: "    return c.json({ error: 'Not a party to this attachment' }, 403)\n  }\n\n  const filePath = join(UPLOAD_DIR, id)",
    suite: "packages/http/src/attachments.test.ts",
    expect: ["an attachment the caller is not party to reads as not found"],
  },
  {
    id: "a-proxy-counts-as-party-to-what-it-carried",
    defect:
      "`mayDownload` began counting `sent_by`, so a proxy that carried a message may read its attachments. \u00a7 8.2 distinguishes the two names for exactly this: carrying a message is not being party to it, and the http server declares every approved person on one socket \u2014 so one proxy entitlement would open every conversation it ever relayed.",
    file: "packages/http/src/attachment-access.ts",
    from: "        WHERE (from_agent = ? OR to_agent = ?)",
    to: "        WHERE (from_agent = ? OR to_agent = ? OR sent_by = ?)",
    suite: "packages/http/src/attachments.test.ts",
    expect: ["neither does the proxy that carried it"],
  },
  {
    id: "an-unapproved-session-is-told-to-sign-in-again",
    defect:
      "A signed-in but unapproved person was answered `401` instead of `403`. They proved who they are; what they lack is permission, and telling them to sign in sends them to fix the wrong thing \u2014 into a loop through an identity provider that will keep succeeding.",
    file: "packages/http/src/main.ts",
    from: "      ? { identity: session.github_login as string }\n      : { refusal: 403 }",
    to: "      ? { identity: session.github_login as string }\n      : { refusal: 401 }",
    suite: "packages/http/src/attachments.test.ts",
    expect: ["a signed-in person the operator has not approved yet"],
  },
  {
    id: "the-tenant-dashboard-invents-its-egress-total",
    defect:
      "The dashboard stopped summing the egress rules the route returned and drew a total of its own. A number on a dashboard is read as measured; one the screen computed from nothing reads identically to one the mesh reported, and an operator sizing a tenant's exposure by it is sizing it by a constant.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "  const totalEgressRules = groups.every((group) => Array.isArray(group.egress_allowed))\n    ? groups.reduce((total, group) => total + group.egress_allowed!.length, 0)\n    : null;",
    to: "  const totalEgressRules = groups.reduce((total, group) => total + (group.egress_allowed?.length ?? 0), 0);",
    suite: "packages/platform-web/src/pages/DashboardPage.test.tsx",
    expect: ["does not turn an omitted delivery-rule list into zero allowed destinations"],
  },
  {
    id: "the-login-canvas-never-starts",
    defect:
      "The login page's canvas effect inverted its own guard and returned when the context *was* available, so the first frame is never scheduled. Nothing throws and nothing logs — the page renders with a dead background, which is the class of defect only a test that watches for the first frame can see.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "    if (!ctx) return;",
    to: "    if (ctx) return;",
    suite: "packages/platform-web/src/pages/LoginPage.test.tsx",
    expect: ["product-defined canvas frame"],
  },
  {
    id: "topology-search-answers-the-wrong-key",
    defect:
      "The topology search moved its camera on `Escape` instead of `Enter`. Both keys reach the handler with results on screen, so nothing errors: pressing `Enter` does nothing and pressing the key that means *cancel* flies the camera at the first hit \u2014 the two most-pressed keys in a search box, swapped.",
    file: "packages/platform-web/src/pages/creator/TopologyPage.tsx",
    from: '    if (e.key === "Enter" && searchResults.length > 0) {',
    to: '    if (e.key === "Escape" && searchResults.length > 0) {',
    suite: "packages/platform-web/src/pages/creator/TopologyPage.test.tsx",
    expect: ["without losing the selected node"],
  },
  {
    id: "message-search-runs-on-an-empty-query",
    defect:
      "`GET /api/v1/messages/search` stopped refusing an absent or blank `q`, so the `LIKE '%%'` it builds matches every message the caller is party to. A search box that returns everything on an accidental Enter reads as a feature until somebody notices the response is the whole history.",
    file: "packages/http/src/main.ts",
    from: "  if (!q || typeof q !== 'string' || q.trim().length === 0) {",
    to: "  if (false) {",
    suite: "packages/http/src/streams.test.ts",
    expect: ["refuses a query that is absent, empty, or only spaces"],
  },
  {
    id: "the-event-stream-opens-without-its-first-frame",
    defect:
      "The per-agent stream stopped sending `connected`, so the socket opens and says nothing. A client waiting for its first frame before rendering hangs on a connection that is working, and the failure is indistinguishable from a slow mesh — which is the reason a stream sends a frame it does not otherwise need.",
    file: "packages/http/src/main.ts",
    from: "      send('connected', { agent: agentId })",
    to: "      void agentId",
    suite: "packages/http/src/streams.test.ts",
    expect: ["opens with a connected frame naming the agent"],
  },
  {
    id: "a-departed-sse-client-is-never-unregistered",
    defect:
      "The abort listener stopped removing the client from the module-level set. Nothing fails at the time: the set grows for the life of the process and every push writes to controllers whose sockets are gone. Invisible until a long-running deployment is broadcasting to thousands of dead connections.",
    file: "packages/http/src/main.ts",
    from: "        removeSSEClient(agentId, userLogin, controller)",
    to: "        void controller",
    suite: "packages/http/src/streams.test.ts",
    expect: ["unregisters the client when the caller goes away"],
  },
  {
    id: "the-source-list-total-counts-only-what-it-returned",
    defect:
      "`agent-sources` reported the length of the page it returned instead of the number of rows there are. The list stops at 500, so a screen drawing 500 out of 3000 reports a smaller fleet than the one running \u2014 and with the total agreeing, no field in the response contradicts it. Undercounting reads as calm, which is the failure this count exists to prevent.",
    file: "packages/http/src/main.ts",
    from: "    : (db.prepare(`SELECT count(*) AS n FROM agent_sources`).get() as { n: number }).n",
    to: "    : rows.length",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["caps the list at five hundred while still reporting the real total"],
  },
  {
    id: "forwarded-addresses-lose-the-condition-they-depend-on",
    defect:
      "The `forwarded` evidence note dropped the qualifier. `X-Forwarded-For` is evidence only while the hub is unreachable except through the trusted proxy \u2014 a condition the hub cannot verify \u2014 and without that sentence an operator reads a header value as an observation. The two modes are not equally good evidence, and the prose is the only place that says so.",
    file: "packages/http/src/main.ts",
    from: "        ? 'Addresses come from X-Forwarded-For via a trusted proxy. They are evidence only while the hub is unreachable except through that proxy, which the hub cannot verify.'",
    to: "        ? 'Addresses come from X-Forwarded-For via a trusted proxy.'",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["says what the addresses are evidence of, per mode"],
  },
  {
    id: "an-unknown-capability-is-refused-without-naming-the-known-ones",
    defect:
      "The grant filter stopped answering with the vocabulary when it refused an unknown capability. A caller then guesses the valid set one request at a time, and a screen building a capability matrix has to compile its own copy \u2014 which is how a capability added here quietly never appears there.",
    file: "packages/http/src/main.ts",
    from: "      return c.json({ ok: false, error: `unknown capability: ${capability}`, capabilities: ALL_CAPABILITIES }, 400)",
    to: "      return c.json({ ok: false, error: `unknown capability: ${capability}` }, 400)",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["hands the vocabulary over"],
  },
  {
    id: "an-unshaped-identity-reaches-the-source-query",
    defect:
      "`agent-sources` stopped checking the identity's shape before using it in a query. The parameter is bound rather than interpolated, so this is not injection \u2014 it is a route that answers an empty list for a value that could never be an identity, which reads as *this identity has no observed sources* rather than *that is not an identity*.",
    file: "packages/http/src/main.ts",
    from: "  if (identity !== undefined && !IDENTITY_RE.test(identity)) {",
    to: "  if (false) {",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["refuses an identity that is not shaped like one"],
  },
  {
    id: "a-broken-audit-query-answers-an-empty-list",
    defect:
      "`chat-audits/agents` went back to answering `{ agents: [] }` when its query throws, so *the audit holds nobody* and *the query did not run* become one sentence to every caller. That is the shape `SC-DOWN-*` measures on the front end \u2014 a screen drawing zero for a backend that never answered \u2014 and it is invisible from inside: a test written as this route's happy path passed through the `catch` without noticing, which is how the defect was found (D-736).",
    file: "packages/http/src/audit-agents.ts",
    from: "    return {\n      status: 503,\n      body: {\n        ok: false,\n        error: \"the audit store did not answer, so who appears in it is unknown\",\n        code: \"AUDIT_AGENTS_UNAVAILABLE\",\n      },\n    };",
    to: "    return { status: 200, body: { agents: [] } };",
    suite: "packages/http/src/audit-degraded.test.ts",
    expect: ["refuses rather than reporting an empty audit, when the store will not answer"],
  },
  {
    id: "the-proxy-claim-is-made-before-the-people-exist",
    defect:
      "The http server claimed `proxy_for` without provisioning the people first. \u00a7 8.2 checks both halves of a claim against stored rows rather than against what the socket says, so a person the hub has no `human` row for is dropped from the claim \u2014 and every message sent on their behalf is then refused, with nothing on this side reporting anything. The order is the whole defence, and it is invisible in a passing connect.",
    file: "packages/http/src/main.ts",
    from: "      await provisionAllHumans(webUsers)",
    to: "      void provisionAllHumans",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["provisions before it claims"],
  },
  {
    id: "the-proxy-claim-names-everyone-in-the-registry",
    defect:
      "The claim was built from every registry row rather than the approved ones. The hub drops the unapproved entries anyway, so nothing breaks \u2014 what changes is that this service tells the mesh it believes it may speak for someone an operator has not admitted, on every reconnect.",
    file: "packages/http/src/main.ts",
    from: "      const webUsers = listApprovedWebUserIds()",
    to: "      const webUsers = listRegistryAgentIds()",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["does not claim a person the operator has not approved"],
  },
  {
    id: "a-refused-approval-still-reads-as-approved",
    defect:
      "`approve` on a key proposal moved the row to `approved` and drew the success toast **before knowing the server had taken it** \u2014 the `return` after the failure toast is what stops it. Without that line a refused decision looks like a made one and the proposal leaves the queue, so the one screen that would have let anybody retry no longer shows it. SC-WRITE-10.",
    file: "packages/platform-web/src/pages/creator/RegisterAgentPage.tsx",
    from: '        testId: "registration-approve-failed",\n        message: `${t("reg.toast.approveFailed", "\uc5d0\uc774\uc804\ud2b8 \uc2b9\uc778 \uc2e4\ud328")}: ${identity} \u2014 ${err.message}`,\n      });\n      return;',
    to: '        testId: "registration-approve-failed",\n        message: `${t("reg.toast.approveFailed", "\uc5d0\uc774\uc804\ud2b8 \uc2b9\uc778 \uc2e4\ud328")}: ${identity} \u2014 ${err.message}`,\n      });',
    suite: "packages/platform-web/src/pages/creator/RegisterAgentPage.test.tsx",
    expect: ["keeps a refused approval pending and names the failed write in its own place"],
  },
  {
    id: "a-refused-denial-still-reads-as-denied",
    defect:
      "The same on the other decision: a refused `deny` marked the row `rejected` and drew the success toast. The two halves are written separately and fail separately, so one being guarded says nothing about the other. SC-WRITE-10.",
    file: "packages/platform-web/src/pages/creator/RegisterAgentPage.tsx",
    from: '        testId: "registration-deny-failed",\n        message: `${t("reg.toast.denyFailed", "\uc5d0\uc774\uc804\ud2b8 \ub4f1\ub85d \uac70\uc808 \uc2e4\ud328")}: ${identity} \u2014 ${err.message}`,\n      });\n      return;',
    to: '        testId: "registration-deny-failed",\n        message: `${t("reg.toast.denyFailed", "\uc5d0\uc774\uc804\ud2b8 \ub4f1\ub85d \uac70\uc808 \uc2e4\ud328")}: ${identity} \u2014 ${err.message}`,\n      });',
    suite: "packages/platform-web/src/pages/creator/RegisterAgentPage.test.tsx",
    expect: ["keeps an unreachable denial pending and names the failed write in its own place"],
  },
  {
    id: "a-decided-proposal-still-offers-its-hover",
    defect:
      "The notification bell offered its hover affordance on a proposal that is no longer actionable. An affordance is a promise: hovering a decided row lights up as though a decision were still available there, and the click that follows does nothing.",
    file: "packages/platform-web/src/components/layout/NotificationBell.tsx",
    from: '                  onMouseEnter={(e) => {\n                    if (req.status === "pending") {',
    to: '                  onMouseEnter={(e) => {\n                    if (req.status === "approved") {',
    suite: "packages/platform-web/src/components/layout/NotificationBell.test.tsx",
    expect: ["hover affordance only on a proposal that is still actionable"],
  },
  {
    id: "the-language-already-chosen-offers-to-be-chosen",
    defect:
      "The sidebar's language switch lit its hover on the option already selected rather than the other one. Backwards feedback on a two-item control: the row that does nothing looks live and the one that would change something looks inert.",
    file: "packages/platform-web/src/components/layout/Sidebar.tsx",
    from: '                if (language !== "ko") e.currentTarget.style.background = "var(--color-bg-surface-hover, #F8FAFC)";',
    to: '                if (language === "ko") e.currentTarget.style.background = "var(--color-bg-surface-hover, #F8FAFC)";',
    suite: "packages/platform-web/src/components/layout/Sidebar.test.tsx",
    expect: ["hover feedback on whichever language is not selected"],
  },
  {
    id: "an-unknown-teardown-action-is-not-refused",
    defect:
      "The console stopped naming an `action` outside the three the route may answer. The three are exhaustive today, so this is a boundary rather than a live defect \u2014 and it is the boundary that decides what happens when the contract grows: refusing loudly, or drawing whichever branch happens to be last.",
    file: "packages/platform-web/src/pages/creator/AgentsPage.tsx",
    from: "          throw new Error(`unknown teardown action: ${unknownAction}`);",
    to: "          throw new Error(`teardown action: ${unknownAction}`);",
    suite: "packages/platform-web/src/pages/creator/AgentsPage.test.tsx",
    expect: ["refuses an action outside the three teardown results"],
  },
  {
    id: "a-denial-marks-the-proposal-approved",
    defect:
      "`deny` wrote `approved` into the row it decided. The server was told to deny and did; the screen then shows the opposite of what happened, on the one queue an operator uses to decide who may join the mesh.",
    file: "packages/platform-web/src/pages/creator/RegisterAgentPage.tsx",
    from: '      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "rejected" } : r))',
    to: '      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "approved" } : r))',
    suite: "packages/platform-web/src/pages/creator/RegisterAgentPage.test.tsx",
    expect: ["marks only the proposal whose fingerprint the server accepted for denial"],
  },
  {
    id: "the-minimap-letterbox-is-treated-as-world-space",
    defect:
      "The minimap's navigation maths used the box height for a world wider than the box, so the letterbox bars either side of the rendered map counted as places to navigate to. A click in the empty margin moves the camera somewhere the world does not extend. Anchored on the six-space block in `navigateFromMinimap`; the four-space one that draws the overlay is a different call site.",
    file: "packages/platform-web/src/pages/creator/TopologyPage.tsx",
    from: "      if (aspectWorld > aspectBox) {\n        renderW = MINIMAP_W;\n        renderH = MINIMAP_W / aspectWorld;",
    to: "      if (aspectWorld > aspectBox) {\n        renderW = MINIMAP_W;\n        renderH = MINIMAP_H;",
    suite: "packages/platform-web/src/pages/creator/TopologyPage.test.tsx",
    expect: ["does not treat a wide world's minimap letterbox as navigable world space"],
  },
  {
    id: "a-dropped-hub-frame-goes-unmentioned",
    defect:
      "The socket handler's `catch` went back to swallowing. A frame this service cannot handle then disappears with no line anywhere \u2014 the hub has recorded a delivery and this side has nothing, and nobody is told. Logging is not the repair, the frame is still dropped; it is the difference between a mesh that loses a message and one that loses it silently (D-737).",
    file: "packages/http/src/main.ts",
    from: "        const reason = err instanceof Error ? err.message : String(err)\n        log.error(",
    to:
      "        const reason = err instanceof Error ? err.message : String(err)\n" +
      "        void reason\n" +
      "        void ((..._unused: unknown[]) => {})(",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["names a frame it could not even parse, and why"],
  },
  {
    id: "a-write-that-cannot-happen-is-ignored-like-a-duplicate",
    defect:
      "`insertMessage` went back to `INSERT OR IGNORE`, which tolerates a repeated id \u2014 what is wanted \u2014 and everything else with it, including a `NOT NULL` violation. A `mesh.message` with no `content` is then silently not stored while the handler runs on to push it to the operator's screen, broadcast it to the audit stream and send a notification: on screen, in the audit trail, absent from the history. A reload loses it and the audit says it was delivered (D-737).",
    file: "packages/http/src/db.ts",
    from: "    INSERT INTO messages (id, from_agent, to_agent, content, reply_to, file_path, status, ts)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?)\n    ON CONFLICT(id) DO NOTHING",
    to: "    INSERT OR IGNORE INTO messages (id, from_agent, to_agent, content, reply_to, file_path, status, ts)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["is not drawn, not audited, and not pushed"],
  },
  {
    id: "a-hub-reply-resolves-whichever-request-is-waiting",
    defect:
      "`sendViaHub` stopped correlating its reply by id and took the first frame it saw. One socket carries every caller's traffic, so a send would resolve on somebody else's answer and hand this caller another message's id \u2014 which is then written into the row and reported as the delivery.",
    file: "packages/http/src/main.ts",
    from: "        if (data.id === reqId) {",
    to: "        if (true) {",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["ignores an answer that is not to its request"],
  },
  {
    id: "losing-the-hub-is-only-worth-a-mention",
    defect:
      "Losing the link was logged at `info`. It reads fine in a full journal and disappears from every filter an operator actually runs \u2014 and this is the line that explains why sends during the outage were answered with nothing, so the one time it is read is the one time it is not there.",
    file: "packages/http/src/main.ts",
    from: '      log.warn(`lost the hub link, redialling in ${HUB_RECONNECT_MS}ms`',
    to: '      log.info(`lost the hub link, redialling in ${HUB_RECONNECT_MS}ms`',
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["says the link is gone"],
  },
  {
    id: "a-lost-link-still-reads-as-connected",
    defect:
      "`onclose` left `hubConnected` true. Every later send is written to a socket the hub is no longer on and waits out its full five-second timeout before answering `null`, and `redeclareProxies` claims people over a link that is gone.",
    file: "packages/http/src/main.ts",
    from: 'hubWs.onclose = () => {\n      hubConnected = false',
    to: 'hubWs.onclose = () => {\n      hubConnected = true',
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["nothing is sent on the socket it just lost"],
  },
  {
    id: "the-redial-arms-a-timer-nobody-owns",
    defect:
      "The reconnect reached for the module's default schedule instead of the one it was given. In production nothing changes; in a shared test process the second close arms a real five-second dial that fires inside whatever file is running by then, and the failure lands on a test that never touched the hub.",
    file: "packages/http/src/main.ts",
    from: "      schedule(() => connectToHub(schedule), HUB_RECONNECT_MS)",
    to: "      schedule(() => connectToHub(), HUB_RECONNECT_MS)",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["scheduled on the same clock"],
  },
  {
    id: "a-dial-that-never-connected-reads-as-a-disconnect",
    defect:
      "The constructor throwing was reported as `hub_disconnected`. The two want opposite responses \u2014 a link that was lost comes back on its own, a dial that threw is a URL somebody has to fix \u2014 and merging them means the second is waited out as if it were the first.",
    file: "packages/http/src/main.ts",
    from: "'hub_dial_failed', {",
    to: "'hub_disconnected', {",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["reported as a dial, not as a disconnect"],
  },
  {
    id: "the-dial-failure-says-nothing-about-the-dial",
    defect:
      "The line dropped what the socket constructor actually said. `hub_dial_failed` on its own does not separate a typo in the hub URL from a hub that is not listening, and those are not the same repair.",
    file: "packages/http/src/main.ts",
    from: "      detail: err instanceof Error ? err.message : String(err),",
    to: "      detail: 'dial failed',",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["reported as a dial, not as a disconnect"],
  },
  {
    id: "the-hub-refusing-this-server-passes-for-success",
    defect:
      "The self-provisioning check ran backwards, so a refusal was silent. \u00a7 8.2 reads the proxy grant off the row this call creates: without it every message sent on a person's behalf is refused at the far end, one refusal per message, with nothing on this side naming the cause.",
    file: "packages/http/src/main.ts",
    from: "      if (!self.ok) {",
    to: "      if (self.ok) {",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["connects anyway"],
  },
  {
    id: "a-dirty-checkout-reports-itself-clean",
    defect:
      "The `dirty` flag was inverted. An instance serving uncommitted work says its commit describes what it is serving, and it does not \u2014 which is the whole failure this file was written after: twice, an instance was running something other than what its commit said, and both first diagnoses were wrong.",
    file: "packages/hub/src/provenance.ts",
    from: '    dirty: git("status", "--porcelain") !== "",',
    to: '    dirty: git("status", "--porcelain") === "",',
    suite: "packages/hub/src/provenance.test.ts",
    expect: ["a tree with uncommitted work says so"],
  },
  {
    id: "provenance-reads-whatever-directory-it-was-started-from",
    defect:
      "`git -C <root>` became a bare `git`. The answer is then about the process's working directory rather than about this checkout, so a hub started from a home directory reports that directory's commit \u2014 or `unknown`, which reads exactly like a tarball deployment.",
    file: "packages/hub/src/provenance.ts",
    from: '      const p = spawn(["git", "-C", root, ...args]);',
    to: '      const p = spawn(["git", ...args]);',
    suite: "packages/hub/src/provenance.test.ts",
    expect: ["asks about its own checkout"],
  },
  {
    id: "a-git-that-will-not-spawn-takes-the-hub-with-it",
    defect:
      "The catch around the spawn re-threw. This is read at import, so a machine with no `git` on the PATH \u2014 a container built from a tarball, most often \u2014 cannot start the hub at all, and the failure is in a module whose entire contract is *never fatal*.",
    file: "packages/hub/src/provenance.ts",
    from: '    } catch {\n      return "";\n    }',
    to: '    } catch (err) {\n      throw err;\n    }',
    suite: "packages/hub/src/provenance.test.ts",
    expect: ["caught, not carried up"],
  },
  {
    id: "a-failed-contract-read-falls-back-to-a-list",
    defect:
      "The capability check fell back to its own list when the contract could not be read \u2014 the exact defect it exists to catch. It printed nine verified names while the contract held twelve, and a guard whose denominator is its own copy of the answer reports agreement with itself.",
    file: "scripts/lint-preview.ts",
    from: "    CAPABILITIES = [];",
    to: "    CAPABILITIES = ['key.approve', 'key.revoke', 'user.admit'];",
    suite: "test/preview-lint.test.ts",
    expect: ["refuses to lint at all"],
  },
  {
    id: "an-empty-vocabulary-passes-the-lint",
    defect:
      "An empty `CAPABILITY` stopped being a failure. The loop below it runs zero times, so the lint reports a clean preview having compared nothing \u2014 the same screen a correct run shows, from a check that did not happen.",
    file: "scripts/lint-preview.ts",
    from: "    if (CAPABILITIES.length === 0) throw new Error('CAPABILITY is empty');",
    to: "    if (CAPABILITIES.length < 0) throw new Error('CAPABILITY is empty');",
    suite: "test/preview-lint.test.ts",
    expect: ["an empty vocabulary is a failure"],
  },
  {
    id: "the-500-hands-back-the-exception",
    defect:
      "The last-resort handler answered with the exception message. Whatever threw decides what the caller reads \u2014 a connection string, a row, a file path, a token that arrived in a query \u2014 and it is the one answer in this service nobody vetted, because it is written by the failure rather than by anyone here.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ error: 'Internal server error' }, 500)",
    to: "  return c.json({ error: err.message }, 500)",
    suite: "packages/http/src/unhandled.test.ts",
    expect: ["told a 500 happened, and nothing else"],
  },
  {
    id: "the-500-logs-the-whole-url",
    defect:
      "The unhandled-error line logged the URL rather than the pathname. The query string is caller input and lands in the journal verbatim; a session token in a pasted link is then written down by the one code path that runs when something has already gone wrong.",
    file: "packages/http/src/main.ts",
    from: "    route: new URL(c.req.url).pathname,",
    to: "    route: c.req.url,",
    suite: "packages/http/src/unhandled.test.ts",
    expect: ["does not follow the route into the log"],
  },
  {
    id: "a-thrown-request-is-only-a-warning",
    defect:
      "A handler throwing was logged at `warn`. Nothing about it worked as designed \u2014 the caller got a 500 \u2014 and at `warn` it sits among the refusals, which are the lines an operator has learned to scroll past.",
    file: "packages/http/src/main.ts",
    from: "  log.error('a request handler threw, so the caller is answered a 500'",
    to: "  log.warn('a request handler threw, so the caller is answered a 500'",
    suite: "packages/http/src/unhandled.test.ts",
    expect: ["which route, and what it said"],
  },
  {
    id: "silence-cannot-reach-the-silence-rule",
    defect:
      "`bootRetryable` stopped stripping the harness's own section headers, which is the state this was found in. The string it is handed always carries `--- hub output ---`, so *the child said nothing* \u2014 the case the rule exists for \u2014 leaves the headers behind and reads as the child having spoken. The retry then only ever fires for a boot that named a port, which is the branch that was already there.",
    file: "test/harness.ts",
    from: '  return said.replace(NEVER_HEALTHY, "").replace(HARNESS_SECTIONS, "").trim() === "";',
    to: '  return said.replace(NEVER_HEALTHY, "").trim() === "";',
    suite: "test/harness-boot.test.ts",
    expect: ["the retry can see what either child said"],
  },
  {
    id: "a-boot-failure-reports-one-child",
    defect:
      "The boot failure went back to appending the hub's output alone. An http server that died on startup is then reported underneath the hub's healthy log \u2014 and `bootRetryable` reads this same string, so every race the http child lost became invisible to the retry.",
    file: "test/harness.ts",
    from: '  const httpSaid = httpOutput === null ? "" : `\\n--- http output ---\\n${httpOutput}`;',
    to: '  const httpSaid = "";',
    suite: "test/harness-boot.test.ts",
    expect: ["carries both children, labelled"],
  },
  {
    id: "a-service-that-is-listening-and-unwell-says-nothing-about-it",
    defect:
      "The health wait stopped carrying the status it got. *Never became healthy* then covers both nothing-is-listening-there and it-is-listening-and-refusing, which are opposite repairs, and the sentence is read at the moment nothing else is working.",
    file: "test/harness.ts",
    from: "      lastError = `status ${res.status}`;",
    to: '      lastError = "not ready";',
    suite: "test/harness-boot.test.ts",
    expect: ["says the status when it is listening and unwell"],
  },
  {
    id: "a-refusal-is-retried-twice-before-being-believed",
    defect:
      "The retry stopped asking whether the failure was worth another port. A service that refuses says why, and retrying it reports the same answer three times as slowly \u2014 worse, `misconfigured-boot.test.ts` asserts those refusals, so a server that stopped refusing would take three attempts to look green rather than one to look red.",
    file: "test/harness.ts",
    from: "      if (!bootRetryable(said)) throw err;",
    to: "      if (false) throw err;",
    suite: "test/harness-boot.test.ts",
    expect: ["does not try again when the boot said why"],
  },
  {
    id: "three-lost-races-end-in-a-sentence-about-counting",
    defect:
      "Giving up threw a fresh error instead of the last one. The only description of what actually happened \u2014 which port, which child, what it said \u2014 is dropped and replaced by the fact that it happened three times.",
    file: "test/harness.ts",
    from: "  throw last;",
    to: '  throw new Error("gave up after 3 attempts");',
    suite: "test/harness-boot.test.ts",
    expect: ["with what the third one said"],
  },
  {
    id: "a-whole-error-page-in-the-failure",
    defect:
      "The not-JSON failure pasted the entire body. An HTML error page is thousands of characters of markup around the one line that matters, and the sentence naming the route disappears above the scrollback.",
    file: "test/harness.ts",
    from: "      `POST /api/v1/rpc (${method}) answered ${status} with a body that is not JSON: ${text.slice(0, 200)}`,",
    to: "      `POST /api/v1/rpc (${method}) answered ${status} with a body that is not JSON: ${text}`,",
    suite: "test/harness-boot.test.ts",
    expect: ["does not paste a whole page"],
  },
  {
    id: "attachments-are-dropped-off-the-wire",
    defect:
      "A message carrying attachments went to the hub as its plain text. \u00a7 15.2 requires the `attachments` array to be *in* the message body and \u00a7 8.2's content is a flat string, so the two are reconciled by sending JSON holding both \u2014 without it the recipient gets the words and no `download_url`, and \u00a7 15.4's pull-on-demand loop has nothing to pull.",
    file: "packages/http/src/main.ts",
    from: "    ? JSON.stringify({ text, attachments })",
    to: "    ? text",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["wraps a message with attachments, and leaves a plain one alone"],
  },
  {
    id: "a-refused-message-stays-pending-in-the-row",
    defect:
      "A message the hub would not take was corrected in the object the response is built from and not in the table. The history route, the conversation view and search all serve the stored value, so the caller was told the truth once and every later read was told it is still waiting for its recipient \u2014 a message that never left this machine, labelled `pending` for ever.",
    file: "packages/http/src/main.ts",
    from: "    markSendFailed(msg.id)",
    to: "",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["marks a message the hub would not take as failed, in the row too"],
  },
  {
    id: "an-unapproved-session-may-register-for-delivery",
    defect:
      "`POST /api/v1/push/subscribe` stopped requiring approval and accepted any session. These were once the only `JWT` routes that stopped at `extractJwt`, which is how the gap got here the first time: somebody an operator has not granted access to registers a delivery endpoint against this deployment, and is then holding a subscription for a mesh they cannot read.",
    file: "packages/http/src/main.ts",
    from: "  if (!isUserApproved(payload.github_login, payload.role)) {\n    return c.json({ error: 'Forbidden' }, 403)\n  }\n\n  let body: Record<string, unknown>\n  try {\n    body = await c.req.json()\n  } catch {\n    return c.json({ error: 'Invalid JSON body' }, 400)\n  }\n\n  const subscription = body.subscription",
    to: "  if (false) {\n    return c.json({ error: 'Forbidden' }, 403)\n  }\n\n  let body: Record<string, unknown>\n  try {\n    body = await c.req.json()\n  } catch {\n    return c.json({ error: 'Invalid JSON body' }, 400)\n  }\n\n  const subscription = body.subscription",
    suite: "packages/http/src/push-routes.test.ts",
    expect: ["refuses a signed-in person the operator has not approved"],
  },
  {
    id: "a-subscription-is-stored-without-the-keys-it-needs",
    defect:
      "The subscribe route stopped checking that a subscription carries both keys. A row missing either is one this service can never deliver to, and it goes into the table the sender iterates \u2014 so every message to that person walks a permanently failing endpoint, and the failure handler decides whether to keep or drop it on a reason that has nothing to do with the browser.",
    file: "packages/http/src/main.ts",
    from: "  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {",
    to: "  if (!subscription?.endpoint) {",
    suite: "packages/http/src/push-routes.test.ts",
    expect: ["refuses a subscription missing the endpoint or either key"],
  },
  {
    id: "an-unapproved-session-may-drop-a-delivery-endpoint",
    defect:
      "`POST /api/v1/push/unsubscribe` stopped requiring approval. The mirror of the subscribe gap, and the worse half while the removal is unscoped: an unapproved session could then remove any endpoint it can name.",
    file: "packages/http/src/main.ts",
    from: "  const endpoint = body.endpoint as string | undefined\n  if (!endpoint) {",
    to: "  const endpoint = body.endpoint as string | undefined\n  if (false) {",
    suite: "packages/http/src/push-routes.test.ts",
    expect: ["refuses a body that is not JSON, and one with no endpoint"],
  },
  {
    id: "an-upload-is-accepted-without-declaring-its-size",
    defect:
      "`POST /api/v1/upload` stopped requiring `Content-Length`. It is the only bound available *before* bytes are accepted, and the reason it is there is measured: `formData()` parses the whole body into memory and `arrayBuffer()` copied it again, so a 100 MiB upload cost 200 MiB and the size check ran after both \u2014 a handful of concurrent uploads took the process down. Without the declaration the ceiling can only be enforced by counting an unbounded stream that has already arrived.",
    file: "packages/http/src/main.ts",
    from: "  if (declared === undefined) {",
    to: "  if (false) {",
    suite: "packages/http/src/upload.test.ts",
    expect: ["a request that declares no length"],
  },
  {
    id: "the-declared-upload-size-is-not-bounded",
    defect:
      "The declared length stopped being compared against the ceiling, so the refusal moves after the parse \u2014 which is the arrangement this check replaced. The envelope is bounded rather than the file because multipart adds a boundary and headers, and bounding the envelope bounds what is inside it.",
    file: "packages/http/src/main.ts",
    from: "  if (declaredSize > UPLOAD_MAX_BYTES + UPLOAD_ENVELOPE_SLACK) {",
    to: "  if (false) {",
    suite: "packages/http/src/upload.test.ts",
    expect: ["a declared length over the ceiling plus its envelope slack"],
  },
  {
    id: "a-group-read-that-could-not-answer-is-drawn-as-empty",
    defect:
      "The dashboard folded *still asking*, *refused* and *unreachable* into *empty* for its group reads. An operator reads an empty list as an answer, and three of the four states are not answers \u2014 the screen then says a tenant has no groups when nobody has been told anything.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "  const state = read.kind === \"ready\"\n    ? read.groups.length > 0 ? \"present\" : \"empty\"\n    : read.kind;",
    to: "  const state = read.kind === \"ready\"\n    ? read.groups.length > 0 ? \"present\" : \"empty\"\n    : \"empty\";",
    suite: "packages/platform-web/src/pages/DashboardPage.test.tsx",
    expect: ["keeps the tenant group read's pending, refused, and unreachable states out of empty"],
  },
  {
    id: "a-refused-group-read-is-reported-as-unreachable",
    defect:
      "The group read stopped asking `failureKind` what kind of failure it was and called every one unreachable. The two send a person to different places \u2014 one is a permission somebody must grant, the other is a service that is down \u2014 and `api/client.ts` carries the split precisely so a screen does not have to guess.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "        setRead({ kind: failureKind(err), groups: [], missing: refusedCapability(err) });",
    to: "        setRead({ kind: \"unreachable\", groups: [], missing: refusedCapability(err) });",
    suite: "packages/platform-web/src/pages/DashboardPage.test.tsx",
    expect: ["keeps the tenant group read's pending, refused, and unreachable states out of empty"],
  },
  {
    id: "a-list-read-that-could-not-answer-is-drawn-as-empty",
    defect:
      "The same fold one level up, in the helper the agents and pending-key reads share. Those three reads are why `SC-DOWN-13` exists: each drew `0` for a read that had failed, and the state recording the failure was never read by anything. One helper now decides for all of them, so folding it here is the whole defect in one line.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "function dashboardListState<T>(read: DashboardListRead<T>): DashboardListState {\n  return read.kind === \"ready\" ? read.items.length > 0 ? \"present\" : \"empty\" : read.kind;\n}",
    to: "function dashboardListState<T>(read: DashboardListRead<T>): DashboardListState {\n  return read.kind === \"ready\" ? read.items.length > 0 ? \"present\" : \"empty\" : \"empty\";\n}",
    suite: "packages/platform-web/src/pages/DashboardPage.test.tsx",
    expect: ["keeps the tenant agents read's pending, refused, and unreachable states out of empty"],
  },
  {
    id: "a-refused-list-read-is-reported-as-unreachable",
    defect:
      "The agents and pending-key reads stopped distinguishing a refusal from no answer. The pending-key panel is where an operator admits an identity to the mesh, so being told the service is down when the truth is *you may not read this* sends them to check a network that is fine.",
    file: "packages/platform-web/src/pages/DashboardPage.tsx",
    from: "        setRead({ kind: failureKind(err), items: [], missing: refusedCapability(err) });",
    to: "        setRead({ kind: \"unreachable\", items: [], missing: refusedCapability(err) });",
    suite: "packages/platform-web/src/pages/DashboardPage.test.tsx",
    expect: ["keeps the tenant pending-key read's pending, refused, and unreachable states out of empty"],
  },
  {
    id: "a-sign-in-in-flight-looks-like-one-not-started",
    defect:
      "The login button stopped saying a credential was in flight. The only feedback was the result, so a person who saw nothing pressed again \u2014 which is the case the handler guard exists for, and the guard is invisible if nothing shows the pending state either.",
    file: "packages/platform-web/src/pages/LoginPage.tsx",
    from: "            {isSubmitting ? (\n              <span data-testid=\"login-pending\">{t(\"login.pending\", \"\ub85c\uadf8\uc778 \ud655\uc778 \uc911...\")}</span>\n            ) : (\n              t(\"login.submit\", \"Sign in\")\n            )}",
    to: "            {t(\"login.submit\", \"Sign in\")}",
    suite: "packages/platform-web/src/pages/LoginPage.test.tsx",
    expect: ["shows an in-flight credential as pending in its own place"],
  },
  {
    id: "a-legacy-attachment-loses-the-name-it-kept",
    defect:
      "A legacy `<ts>-<name>` id stopped being served under the name inside it, so the one id shape that still carries a person's filename hands the browser a timestamp instead. Digest-keyed ids have no name to lose \u2014 that is why they fall back to the id \u2014 but these do, and it is the whole difference between the two shapes.",
    file: "packages/http/src/main.ts",
    from: "    filename = dashIdx > 0 ? id.slice(dashIdx + 1) : id",
    to: "    filename = id",
    suite: "packages/http/src/attachments.test.ts",
    expect: ["a legacy id after the name inside it"],
  },
  {
    id: "an-admitted-person-may-message-nobody",
    defect:
      "Approving stopped writing the wildcard messaging policy, so a person is admitted, appears in the registry, holds a mesh identity \u2014 and `isAllowedToMessage` refuses every recipient they name. The screen lets them in and nothing they send goes anywhere, with no line saying why.",
    file: "packages/http/src/main.ts",
    from: "  db.prepare(`INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, '*')`).run(githubLogin)",
    to: "  void githubLogin",
    suite: "packages/http/src/admission.test.ts",
    expect: ["approves, registers, provisions, and grants a policy"],
  },
  {
    id: "an-admitted-person-is-not-in-the-registry",
    defect:
      "Approving stopped adding the registry row. That table is what `listApprovedWebUserIds` builds the hub proxy claim from, so an admitted person is never claimed on the socket \u2014 \u00a7 8.2 then refuses every message sent on their behalf, and this side reports nothing.",
    file: "packages/http/src/main.ts",
    from: "  upsertApprovedWebUser(githubLogin)",
    to: "  void 0",
    suite: "packages/http/src/admission.test.ts",
    expect: ["approves, registers, provisions, and grants a policy"],
  },
  {
    id: "a-denial-grants-what-an-approval-does",
    defect:
      "Denying began writing the registry row an approval writes. A person turned away then appears in the list this service speaks for \u2014 the asymmetry between the two routes is the design: one write for a denial, because there is nothing to withdraw later if nothing was granted.",
    file: "packages/http/src/main.ts",
    from: "  const updated = dbDenyUser(githubLogin)",
    to: "  const updated = dbDenyUser(githubLogin)\n  upsertApprovedWebUser(githubLogin)",
    suite: "packages/http/src/admission.test.ts",
    expect: ["marks the row denied and grants nothing"],
  },
  {
    id: "a-pairing-code-records-the-address-the-client-chose",
    defect:
      "The redemption recorded the first entry in `x-forwarded-for` instead of the last. That header is client-appended, so everything but the hop nearest this server is a value the caller typed \u2014 and this is the one transaction \u00a7 8.11 gets to observe an agent's host from.",
    file: "packages/http/src/main.ts",
    from: "    (c.req.header('x-forwarded-for')?.split(',').pop() ?? '').trim() ||",
    to: "    (c.req.header('x-forwarded-for')?.split(',').shift() ?? '').trim() ||",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["records the nearest address in x-forwarded-for"],
  },
  {
    id: "three-redemption-failures-collapse-into-one",
    defect:
      "Every redemption failure answered 409. `unknown` and `already-redeemed` call for different reactions \u2014 ask for another code, or find out who took yours \u2014 and collapsing them hides a race from the person who lost it.",
    file: "packages/http/src/main.ts",
    from: "    const status = outcome.reason === 'unknown' ? 404 : 409",
    to: "    const status = 409",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["distinguishes unknown, expired, and already-redeemed"],
  },
  {
    id: "a-spent-pairing-code-is-spent-again",
    defect:
      "The single-statement spend stopped checking `redeemed_at`, so a second caller redeeming the same code was handed the identity the first one already claimed. `changes` is what decides this in one statement; the guard is half of that statement.",
    file: "packages/store/src/ownership.ts",
    from: "        WHERE code = ? AND redeemed_at IS NULL AND expires_at > datetime('now')",
    to: "        WHERE code = ? AND expires_at > datetime('now')",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["gives the loser of a race no ownership"],
  },
  {
    id: "ownership-credits-the-person-who-typed-the-code",
    defect:
      "The ownership row recorded the redeemer as its own grantor. The authenticated party is the operator who issued the code; the redeemer is a CLI holding a string. Writing `pairing:<redeemer>` makes the record vouch for itself.",
    file: "packages/store/src/ownership.ts",
    from: ").run(row.tenant, row.identity, owner, `pairing:${row.issued_by}`);",
    to: ").run(row.tenant, row.identity, owner, `pairing:${owner}`);",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["records the issuer as the grantor, not the redeemer"],
  },
  {
    id: "the-granted-window-stops-travelling-with-the-code",
    defect:
      "`ttl_seconds` left the response. The console then fell back to `res.ttl_seconds || selectedTtl` \u2014 the value it asked for \u2014 so the screen reported a window derived from the request rather than from the server that granted it.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ ok: true, code: code.code, identity, expires_at: code.expires_at, ttl_seconds: ttl }, 201)",
    to: "  return c.json({ ok: true, code: code.code, identity, expires_at: code.expires_at }, 201)",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["issues a code, and says how long it is good for"],
  },
  {
    id: "a-pairing-window-with-no-ceiling",
    defect:
      "The ttl bound stopped refusing anything above the hour. A pairing code good for a day is a password, and one good for a negative window is a row SQLite writes with no expiry at all.",
    file: "packages/http/src/main.ts",
    from: "  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > PAIRING_TTL_MAX_SECONDS) {",
    to: "  if (!Number.isFinite(ttl)) {",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["refuses a ttl outside 1..3600"],
  },
  {
    id: "proxy-rights-widen-to-the-whole-tenant",
    defect:
      "The `can_proxy` gate stopped scoping to the identity being changed. Holding `agent.provision` on one agent then flipped proxy rights on any of them \u2014 the strongest capability in the system, widened by dropping one argument.",
    file: "packages/http/src/main.ts",
    from: "  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION, identity)",
    to: "  const actor = await requireCapability(c, CAPABILITY.AGENT_PROVISION)",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["refuses a grant held on a different identity"],
  },
  {
    id: "can-proxy-accepts-anything-truthy",
    defect:
      "The boolean check became a presence check, so the string `\"false\"` \u2014 what an HTML form sends \u2014 turned proxy rights on.",
    file: "packages/http/src/main.ts",
    from: "  if (typeof body?.can_proxy !== 'boolean') {",
    to: "  if (body?.can_proxy === undefined) {",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["refuses can_proxy that is not a boolean"],
  },
  {
    id: "a-torn-down-identity-can-still-be-given-proxy-rights",
    defect:
      "The registry lookup stopped excluding torn-down rows, so an identity somebody had removed could be handed the right to speak for others.",
    file: "packages/http/src/main.ts",
    from: "  const exists = db.prepare(`SELECT 1 FROM agents WHERE identity = ? AND deleted_at IS NULL`).get(identity)",
    to: "  const exists = db.prepare(`SELECT 1 FROM agents WHERE identity = ?`).get(identity)",
    suite: "packages/http/src/ownership-routes.test.ts",
    expect: ["refuses an identity that has been torn down"],
  },
  {
    id: "a-lapsed-lease-still-counts-as-held",
    defect:
      "Queue depth counted every lease ever taken as live. An operator asking why an agent is not receiving is then told the queue is held by a caller that died hours ago, when those messages are pending again.",
    file: "packages/http/src/main.ts",
    from: "           sum(CASE WHEN leased_until IS NOT NULL AND leased_until >= datetime('now') THEN 1 ELSE 0 END) AS leased,",
    to: "           sum(CASE WHEN leased_until IS NOT NULL THEN 1 ELSE 0 END) AS leased,",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["counts pending per agent, and only live leases as leased"],
  },
  {
    id: "the-queued-total-counts-messages-that-are-not-queued",
    defect:
      "The total dropped its `status = 'pending'` filter and counted delivered messages too. The tile reading `0` on a backed-up mesh was the last bug in this number; a total that only grows is the same failure facing the other way.",
    file: "packages/http/src/main.ts",
    from: "    .prepare(`SELECT count(*) AS n FROM messages WHERE status = 'pending'`)",
    to: "    .prepare(`SELECT count(*) AS n FROM messages`)",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["answers a total it counted itself"],
  },
  {
    id: "a-negative-limit-empties-the-queue-view",
    defect:
      "The limit floor dropped to zero, so `?limit=-5` answered `LIMIT 0` \u2014 an empty list for a queue that is not empty, which is the one answer an operator must never be given by accident.",
    file: "packages/http/src/main.ts",
    from: "  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500)",
    to: "  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 0), 500)",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["clamps the limit, and defaults what it cannot read"],
  },
  {
    id: "leased-is-served-as-sqlite-wrote-it",
    defect:
      "`leased` went out as SQLite's `1`/`0` instead of a boolean. A reader doing `m.leased === true` then sees every message as unleased, and one doing `if (m.leased)` is right by luck.",
    file: "packages/http/src/main.ts",
    from: "    messages: messages.map((m) => ({ ...m, leased: m.leased === 1 })),",
    to: "    messages: messages.map((m) => ({ ...m, leased: m.leased })),",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["lists one agent's pending messages, oldest first"],
  },
  {
    id: "watching-the-audit-stream-is-not-recorded",
    defect:
      "The stream stopped recording the read. It serves whole message bodies, and \u00a7 11.0.1 is explicit that holding `audit.read.content` is defensible and holding it without the record is not \u2014 this route already shipped once with a role check and no record.",
    file: "packages/http/src/main.ts",
    from: "  const refused = logContentRead(c, actor, true, 'chat-audits:stream', c.req.query())",
    to: "  const refused: Response | null = null",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["records the read, with the query and not the content"],
  },
  {
    id: "a-gap-of-exactly-a-hundred-is-refused",
    defect:
      "The gap boundary moved to `>= 100`, so a client that missed exactly a hundred messages was told the gap was too large instead of being sent it.",
    file: "packages/http/src/main.ts",
    from: "            if (gapCount > 100) {",
    to: "            if (gapCount >= 100) {",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["sends a hundred, and refuses only past it"],
  },
  {
    id: "the-anchor-is-replayed-to-the-client-that-has-it",
    defect:
      "The tie-break became `id >= ?`, so every reconnect replayed the last message the client had already seen. Two messages sharing a timestamp is what makes the second half of that clause load-bearing.",
    file: "packages/http/src/main.ts",
    from: "            const where: string[] = ['(ts > ? OR (ts = ? AND id > ?))']",
    to: "            const where: string[] = ['(ts > ? OR (ts = ? AND id >= ?))']",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["does not replay the anchor to the client that already has it"],
  },
  {
    id: "a-replay-looks-like-a-live-message",
    defect:
      "Replayed messages lost the `recovered` flag, so a console could not tell history from what is happening now \u2014 and an audit view that cannot is one that reports the past as the present.",
    file: "packages/http/src/main.ts",
    from: "Object.assign({}, m, { recovered: true })",
    to: "m",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["replays what happened while the client was away"],
  },
  {
    id: "every-conversation-appears-twice",
    defect:
      "The dedup guard stopped short-circuiting. The hub socket and the audit poller both see every message, so without it a console shows the whole mesh doubled.",
    file: "packages/http/src/main.ts",
    from: "  if (recentSentIds.has(msg.id)) return",
    to: "  if (recentSentIds.has(msg.id)) void 0",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["sends one id once"],
  },
  {
    id: "the-audit-search-became-case-sensitive",
    defect:
      "The content half of the search filter stopped folding case, so a filter typed in lower case silently missed every message that used capitals.",
    file: "packages/http/src/main.ts",
    from: "  if (f.search && !msg.content.toLowerCase().includes(f.search.toLowerCase())) return false",
    to: "  if (f.search && !msg.content.includes(f.search)) return false",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["passes only what the filters name"],
  },
  {
    id: "a-filtered-stream-receives-everybody-elses-messages",
    defect:
      "The recipient filter stopped excluding anything, so a stream scoped to one conversation was handed the whole mesh \u2014 content the operator's own filter said they were not reading.",
    file: "packages/http/src/main.ts",
    from: "  if (f.to_agent && msg.to_agent !== f.to_agent) return false",
    to: "  if (f.to_agent && msg.to_agent !== f.to_agent) void 0",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["decides per subscriber, not per message"],
  },
  {
    id: "a-message-id-can-open-an-sse-frame",
    defect:
      "`id:` stopped stripping newlines, so a message id containing one injects fields into every watcher's stream \u2014 the envelope is line-oriented and the id is a line in it.",
    file: "packages/http/src/main.ts",
    from: "  return String(id).replace(/[\\r\\n\\0]/g, '')",
    to: "  return String(id).replace(/[\\r\\0]/g, '')",
    suite: "packages/http/src/audit-stream.test.ts",
    expect: ["strips newlines out of the id line"],
  },
  {
    id: "a-deployment-with-no-keys-pushes-anyway",
    defect:
      "The VAPID check went, so a deployment holding no keys still reached for the subscription table and handed payloads to `webpush` \u2014 an error per device, for every message, on a deployment that had deliberately not configured push.",
    file: "packages/http/src/push.ts",
    from: "  if (!deps.configured) {",
    to: "  if (false) {",
    suite: "packages/http/src/push.test.ts",
    expect: ["sends nothing, and asks nothing, without VAPID keys"],
  },
  {
    id: "the-same-message-arrives-twice",
    defect:
      "The open-stream check went. Somebody reading a conversation then gets a lock-screen notification for the message already on their screen.",
    file: "packages/http/src/push.ts",
    from: "  if (deps.watching(toUser)) {",
    to: "  if (false && deps.watching(toUser)) {",
    suite: "packages/http/src/push.test.ts",
    expect: ["sends nothing to somebody already watching"],
  },
  {
    id: "a-whole-message-claims-to-be-cut-short",
    defect:
      "The preview boundary moved to `>=`, so a message of exactly a hundred characters arrived with an ellipsis. That is a claim something was left out, on a notification whose reader cannot check.",
    file: "packages/http/src/push.ts",
    from: "      body: content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) + \"...\" : content,",
    to: "      body: content.length >= PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) + \"...\" : content,",
    suite: "packages/http/src/push.test.ts",
    expect: ["truncates past a hundred characters, and not at a hundred"],
  },
  {
    id: "any-failure-costs-the-subscription-again",
    defect:
      "The drop decision stopped being consulted: every rejection deleted the subscription again, which is the defect `readPushFailure` was written for arriving one level up.",
    file: "packages/http/src/push.ts",
    from: "        if (drop) deps.drop(sub.endpoint);",
    to: "        deps.drop(sub.endpoint);",
    suite: "packages/http/src/push.test.ts",
    expect: ["keeps a subscription through a service failure"],
  },
  {
    id: "a-body-asking-for-more-than-it-gets-is-told-yes",
    defect:
      "The create route went back to dropping fields it does not implement. This repository's own fixture sent `members` and `name` for four months and was answered 201 every time \u2014 the groups were empty and the response said the whole request had happened.",
    file: "packages/http/src/main.ts",
    from: "  const unsupported = Object.keys(body).filter((k) => !GROUP_CREATE_FIELDS.has(k))",
    to: "  const unsupported: string[] = []",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["refuses a field it does not implement, and names it"],
  },
  {
    id: "a-new-group-is-given-the-one-rule-it-was-made-to-state",
    defect:
      "Creating a group seeded a rule letting it send to itself. That guesses the single thing the operator created the group in order to say, and a guessed rule is indistinguishable from a stated one afterwards.",
    file: "packages/http/src/main.ts",
    from: "  const created = groupsStore.createGroup(db_(), {\n    tenant,\n    groupId, description: typeof body?.description === 'string' ? body.description : null, createdBy: actor,\n  })",
    to: "  const created = groupsStore.createGroup(db_(), {\n    tenant,\n    groupId, description: typeof body?.description === 'string' ? body.description : null, createdBy: actor,\n  })\n  groupsStore.allowEgress(db_(), { tenant, fromGroup: groupId, toGroup: groupId, grantedBy: actor })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["grants the new group nothing, not even to itself"],
  },
  {
    id: "a-description-is-whatever-was-sent",
    defect:
      "The description stopped being checked for being a string, so a number went into the column and out to every reader of the group list.",
    file: "packages/http/src/main.ts",
    from: "    groupId, description: typeof body?.description === 'string' ? body.description : null, createdBy: actor,",
    to: "    groupId, description: body?.description ?? null, createdBy: actor,",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["keeps a description only when it is a string"],
  },
  {
    id: "somebody-is-moved-into-a-group-that-does-not-exist",
    defect:
      "The membership route stopped checking that the group exists. The identity lands somewhere no egress rule can ever name, which is silence rather than an error \u2014 it can send nowhere and nothing says why.",
    file: "packages/http/src/main.ts",
    from: "  if (!groupsStore.listGroups(db, tenant).some((g) => g.group_id === groupId)) {",
    to: "  if (false) {",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["refuses a group that does not exist"],
  },
  {
    id: "a-move-reports-the-place-it-moved-to-as-the-place-it-came-from",
    defect:
      "The previous group was read after the move instead of before, so `from_group` and `to_group` were always the same. An operator is then told nothing about what the identity stopped being able to do.",
    file: "packages/http/src/main.ts",
    from: "  const from = groupsStore.groupOf(db, identity, tenant)\n  groupsStore.moveTo(db, { tenant, identity, groupId, movedBy: actor })",
    to: "  groupsStore.moveTo(db, { tenant, identity, groupId, movedBy: actor })\n  const from = groupsStore.groupOf(db, identity, tenant)",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["reports where the identity came from"],
  },
  {
    id: "egress-became-symmetric",
    defect:
      "Granting egress opened the reverse direction too. Agents allowed to report into an aggregator became agents it may command, and the narrower grant is no longer expressible at all.",
    file: "packages/http/src/main.ts",
    from: "  groupsStore.allowEgress(db_(), { tenant, fromGroup: c.req.param('group_id'), toGroup, grantedBy: actor })",
    to: "  groupsStore.allowEgress(db_(), { tenant, fromGroup: c.req.param('group_id'), toGroup, grantedBy: actor })\n  groupsStore.allowEgress(db_(), { tenant, fromGroup: toGroup, toGroup: c.req.param('group_id'), grantedBy: actor })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["grants one direction and not the other"],
  },
  {
    id: "a-revoke-that-removed-nothing-says-it-deleted",
    defect:
      "The revoke answer stopped distinguishing the two outcomes. An operator who mistyped a group is told the rule was deleted, and the rule they meant is still there.",
    file: "packages/http/src/main.ts",
    from: "  // about the same call, and a contract scenario had ratified the `404`.\n  return c.json({ ok: true, action: removed ? 'deleted' : 'not-found' })",
    to: "  // about the same call, and a contract scenario had ratified the `404`.\n  return c.json({ ok: true, action: 'deleted' })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["says which of delete and not-found happened, and never disagrees with itself"],
  },
  {
    id: "a-revoke-takes-both-directions",
    defect:
      "Revoking one direction removed the other as well, so withdrawing a reply path silently withdrew the reporting path it was answering.",
    file: "packages/http/src/main.ts",
    from: "  const removed = groupsStore.revokeEgress(db_(), {\n    tenant, fromGroup: c.req.param('group_id'), toGroup: c.req.param('to_group'),\n  })",
    to: "  const removed = groupsStore.revokeEgress(db_(), {\n    tenant, fromGroup: c.req.param('group_id'), toGroup: c.req.param('to_group'),\n  })\n  groupsStore.revokeEgress(db_(), { tenant, fromGroup: c.req.param('to_group'), toGroup: c.req.param('group_id') })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["takes back only the direction it names"],
  },
  {
    id: "a-send-names-a-file-that-is-not-there",
    defect:
      "The send route stopped stating the path. The message is accepted and delivered, and fails at the far end with an error about a file the recipient never had \u2014 \u00a7 15.2 puts the check on the side that can actually answer it.",
    file: "packages/http/src/main.ts",
    from: "    if (!existsSync(filePath)) {",
    to: "    if (false) {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["refuses a path this server cannot see, and names it"],
  },
  {
    id: "a-proxy-claim-is-sent-down-a-link-that-is-not-there",
    defect:
      "`redeclareProxies` stopped checking for a live socket. Called from the approval route it then throws into a request that had otherwise succeeded \u2014 or is swallowed by the `.catch(() => {})` at the call site, and the approval reports success with nothing sent.",
    file: "packages/http/src/main.ts",
    from: "export async function redeclareProxies(): Promise<void> {\n  if (!hubConnected || !hubWs) return",
    to: "export async function redeclareProxies(): Promise<void> {\n  if (!hubConnected) void 0",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["does nothing when the hub is not connected"],
  },
  {
    id: "a-newly-approved-person-is-claimed-but-never-registered",
    defect:
      "The re-declaration named the new person without registering them first. \u00a7 8.2 checks both halves of a claim against stored rows, so the hub drops it: every message sent on their behalf is refused and nothing on this side reports anything.",
    file: "packages/http/src/main.ts",
    from: "  const webUsers = listApprovedWebUserIds()\n  await provisionAllHumans(webUsers)\n  hubWs.send(JSON.stringify({",
    to: "  const webUsers = listApprovedWebUserIds()\n  hubWs.send(JSON.stringify({",
    suite: "packages/http/src/hub-link.test.ts",
    expect: ["provisions the new person, then names them in a fresh claim"],
  },
  {
    id: "the-owners-route-answers-about-a-name-that-cannot-exist",
    defect:
      "The owners route stopped checking the identity's shape, so it answers 200 with an empty list for a string no identity could ever be \u2014 a caller cannot tell *nobody owns this* from *that is not a name*.",
    file: "packages/http/src/main.ts",
    from: "  if (!IDENTITY_RE.test(identity)) return c.json({ ok: false, error: 'invalid identity format' }, 400)\n  return c.json({ ok: true, identity, owners: ownership.owners(agentsDb(), identity) })",
    to: "  return c.json({ ok: true, identity, owners: ownership.owners(agentsDb(), identity) })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["refuses a caller without agent.provision, and an off-pattern name"],
  },
  {
    id: "the-route-answers-past-the-reader-it-delegates-to",
    defect:
      "The agents route stopped serving what the reader answered and built its own empty list again, so the refusal `auditAgents` exists to produce could never reach a caller.",
    file: "packages/http/src/main.ts",
    from: "  const r = auditAgents(getHubDb)\n  return c.json(r.body, r.status)",
    to: "  void auditAgents\n  return c.json({ agents: [] }, 200)",
    suite: "packages/http/src/admin-reads.test.ts",
    expect: ["serves what the reader answered, rather than an answer of its own"],
  },
  {
    id: "the-same-identity-is-offered-twice",
    defect:
      "An identity on both sides of a conversation appears twice in the operator's list \u2014 once per message sent and once per message received.\n\n**Registered against both guards at once, because either alone is sufficient.** The query dedups twice: `UNION` (not `UNION ALL`) inside, and `SELECT DISTINCT` outside. Changing one survived the suite, and it should have \u2014 the other still holds. That is not a guard nobody checks; it is one fact with two owners, and only removing both is a defect. Written down so a reader who deletes one of them knows they are right, and knows what the second deletion would cost.",
    file: "packages/http/src/audit-agents.ts",
    from: "SELECT DISTINCT a FROM (SELECT from_agent AS a FROM messages UNION SELECT to_agent AS a FROM messages) ORDER BY a COLLATE NOCASE",
    to: "SELECT a FROM (SELECT from_agent AS a FROM messages UNION ALL SELECT to_agent AS a FROM messages) ORDER BY a COLLATE NOCASE",
    suite: "packages/http/src/audit-degraded.test.ts",
    expect: ["names both ends of every message, once each"],
  },
  {
    id: "the-agent-list-sorts-by-byte",
    defect:
      "The list lost `COLLATE NOCASE`, so it sorts by byte and every capitalised name comes before every lower-case one. An operator scanning a dropdown for `zeta` finds it above `alpha`.",
    file: "packages/http/src/audit-agents.ts",
    from: " ORDER BY a COLLATE NOCASE",
    to: " ORDER BY a",
    suite: "packages/http/src/audit-degraded.test.ts",
    expect: ["sorts without regard to case"],
  },
  {
    id: "an-env-file-overrides-the-unit-that-started-the-service",
    defect:
      "The env file stopped yielding to what the process already had, so a file on disk silently beats systemd's `EnvironmentFile`. The symptom is a service running with settings nobody can find by reading the unit.",
    file: "packages/http/src/env-file.ts",
    from: "      if (!env[key]) env[key] = value;",
    to: "      env[key] = value;",
    suite: "packages/http/src/env-file.test.ts",
    expect: ["never replaces something the process was already given"],
  },
  {
    id: "a-line-with-no-key-becomes-a-variable-with-no-name",
    defect:
      "`eq <= 0` became `eq < 0`, so a line beginning with `=` is read as a setting whose name is the empty string.",
    file: "packages/http/src/env-file.ts",
    from: "    if (eq <= 0) continue;",
    to: "    if (eq < 0) continue;",
    suite: "packages/http/src/env-file.test.ts",
    expect: ["skips a line with no key and a line with no equals"],
  },
  {
    id: "a-value-is-cut-at-every-equals",
    defect:
      "The value stopped being everything after the first `=`. A base64 key ending in `==` arrives truncated, and nothing reports a malformed secret \u2014 it simply does not work.",
    file: "packages/http/src/env-file.ts",
    from: "    pairs.push([trimmed.slice(0, eq), trimmed.slice(eq + 1)]);",
    to: "    pairs.push([trimmed.slice(0, eq), trimmed.slice(eq + 1).split(\"=\")[0]!]);",
    suite: "packages/http/src/env-file.test.ts",
    expect: ["splits on the first equals and not the rest"],
  },
  {
    id: "an-unreadable-env-file-takes-the-service-down",
    defect:
      "The loader stopped swallowing its own failure. It runs before anything else in the process, so a missing optional file now takes the service down with no route registered \u2014 the convenience became a requirement.",
    file: "packages/http/src/env-file.ts",
    from: "  } catch {\n    // Optional means optional.\n  }",
    to: "  } catch (err) {\n    throw err\n  }",
    suite: "packages/http/src/env-file.test.ts",
    expect: ["says nothing when the file cannot be read"],
  },
  {
    id: "an-unrecordable-read-is-let-through",
    defect:
      "The access log went back to failing open: a read whose record could not be written was served anyway. \u00a7 15.6 answers the analogous routing question the other way for a reason that does not transfer \u2014 a delivery failing open loses nothing that was going to be recorded, and an access log failing open loses the only record that the access happened.",
    file: "packages/http/src/audit-access-log.ts",
    from: "    record(r)\n    return null",
    to: "    try { record(r) } catch {}\n    return null",
    suite: "packages/http/src/audit-degraded.test.ts",
    expect: ["refuses, and says so in a shape a caller can act on"],
  },
  {
    id: "the-refusal-quotes-the-database-path-back",
    defect:
      "The refusal started carrying the failure's own words, so whoever is probing an audit surface is handed a description of the deployment's internals \u2014 file paths, driver codes \u2014 one refused request at a time.",
    file: "packages/http/src/audit-access-log.ts",
    from: "      error: 'content reads are recorded, and the record could not be written',",
    to: "      error: `content reads are recorded, and the record could not be written (${message})`,",
    suite: "packages/http/src/audit-degraded.test.ts",
    expect: ["keeps the failure's own words out of the answer"],
  },
  {
    id: "a-code-nothing-names-reaches-a-caller",
    defect:
      "A service emitted a refusal code the contract does not name and nothing objected. That is how `-32000` reached a client which had to hard-code its own constant for it, and it is what `test/versioning.test.ts` exists to stop.\n\nRegistered because the checker itself was the thing that was wrong: it matched `code: \"X\"` only, and `main.ts` writes single quotes, so four real gaps sat behind a green check for as long as they existed. A checker seen only green is the same evidence as no checker.",
    file: "packages/http/src/audit-agents.ts",
    from: "        code: \"AUDIT_AGENTS_UNAVAILABLE\",",
    to: "        code: \"AUDIT_NOBODY_NAMED_THIS\",",
    suite: "test/versioning.test.ts",
    expect: ["every data.code the services emit has a name in contracts"],
  },
  {
    id: "the-service-answers-before-it-is-ready",
    defect:
      "The listen moved ahead of `startup()`, so the port was open while the seed, the migrations and the audit poller had not run. A caller that arrives in that window gets an answer from a service that has not read its own state \u2014 the failure mode is not an error, it is a *wrong answer*, which is why it needs a test rather than a smoke check.\n\nThis block ran only in a spawned process until `startHttpServer` took its dangerous pieces as parameters, so nothing counted it and nothing could mutate it.",
    file: "packages/http/src/main.ts",
    from: "  await begin()",
    to: "",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["the service answered before `startup()` ran"],
  },
  {
    id: "one-signal-gets-a-shutdown-the-other-does-not",
    defect:
      "`SIGINT` and `SIGTERM` were wired to two different shutdowns. Whichever one the tests send is the one that works, and the other is discovered by an operator: `systemctl stop` sends `SIGTERM`, a terminal sends `SIGINT`, and a service that only drains cleanly under one of them loses writes under the other.",
    file: "packages/http/src/main.ts",
    from: "  onSignal('SIGINT', shutdown)",
    to: "  onSignal('SIGINT', () => {})",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["SIGINT and SIGTERM were wired to different shutdowns"],
  },
  {
    id: "shutdown-closes-everything-except-the-server",
    defect:
      "Shutdown ran every closer and left the server listening. The log says it is going down, the closers say they closed, and the port stays held by a process that has already said goodbye \u2014 the next start fails to bind and the reason is three lines of *successful* shutdown away.",
    file: "packages/http/src/main.ts",
    from: "    stop: () => server.stop(),",
    to: "    stop: () => {},",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a shutdown that does not stop the server leaves the port held"],
  },
  {
    id: "a-named-refusal-nothing-answers-with",
    defect:
      "A code the contract names went out of this repository and nothing objected. The direction beside it \u2014 a code emitted that the contract does not name \u2014 has been checked since `-32000`; this one could not be, because the eleven http-admin codes were written out by hand in the checker itself and a list copied from the code agrees with the code by construction. `HTTP_ADMIN_ERROR` (contracts v0.30.0, D-748) made them readable from one place, and the cost of that is a new way to be wrong: a console keeps branching on a refusal this repository stopped answering with, and the dead branch looks live from where it is written.",
    file: "packages/http/src/main.ts",
    from: "      code: 'TENANT_EXISTS',",
    to: "",
    suite: "test/versioning.test.ts",
    expect: ["no name in the http admin vocabulary is one nothing answers with", "TENANT_EXISTS"],
  },
  {
    id: "one-unclosable-store-costs-every-other-one",
    defect:
      "The closers went back to running in a row with nothing catching them, so the first failure skipped every close after it and the exit too. A process asked to stop then stays up until systemd `SIGKILL`s it \u2014 the ungraceful ending the closers exist to avoid, reached by way of the closers.",
    file: "packages/http/src/shutdown.ts",
    from: "    try {\n      close();\n    } catch (err) {\n      warn(`agent-mesh-http: could not close ${name} cleanly`, err);\n    }",
    to: "    close();\n    void name;\n    void warn;",
    suite: "packages/http/src/shutdown.test.ts",
    expect: ["keeps closing after one refuses, and still leaves"],
  },
  {
    id: "the-server-stops-before-its-databases-close",
    defect:
      "Serving stopped before the stores closed, so a request still in flight is answered by a handler whose database has already gone.",
    file: "packages/http/src/shutdown.ts",
    from: "  for (const [name, close] of w.closers) {",
    to: "  w.stop();\n  for (const [name, close] of w.closers) {",
    suite: "packages/http/src/shutdown.test.ts",
    expect: ["does not stop the server before the stores are closed"],
  },
  {
    id: "a-server-that-will-not-stop-keeps-the-process-alive",
    defect:
      "The exit moved inside the stop's success path, so a server that refuses to stop leaves the process running after everything it was serving with is closed \u2014 alive, useless, and holding its port.",
    file: "packages/http/src/shutdown.ts",
    from: "  } catch (err) {\n    warn(\"agent-mesh-http: could not stop the server cleanly\", err);\n  }\n\n  w.exit(0);",
    to: "    w.exit(0);\n  } catch (err) {\n    warn(\"agent-mesh-http: could not stop the server cleanly\", err);\n  }",
    suite: "packages/http/src/shutdown.test.ts",
    expect: ["leaves even when the server will not stop"],
  },
  {
    id: "a-store-is-opened-and-never-closed",
    defect:
      "A store's closer was imported and left out of the shutdown list \u2014 the exact omission that left `audit.db`'s read-write handle unfolded, and the exact thing no runtime test can see, because an uncalled import leaves nothing behind.",
    file: "packages/http/src/main.ts",
    from: "  ['audit (access log)', closeAuditAccessLog],\n]",
    to: "]",
    suite: "packages/http/src/shutdown.test.ts",
    expect: ["every closer main.ts imports is one it closes"],
  },
  {
    id: "the-user-listing-starts-carrying-the-hash",
    defect:
      "The listing stopped naming its columns and took whatever the table has, so the password hash goes out to every caller of the admin user list. The route above it exists so that the temporary password lives in one response and nowhere else; this is the second route being helpful.",
    file: "packages/http/src/db.ts",
    from: "      `SELECT username, display_name, role, created_at,",
    to: "      `SELECT *, COALESCE(tenant, 'default') AS tenant2, username, display_name, role, created_at,",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["hands back a password that appears nowhere else"],
  },
  {
    id: "a-reissue-and-an-admission-report-the-same-absence",
    defect:
      "A reissue for a name nobody holds answered 409, the same as admission refusing a name somebody does. Two different absences with one answer sends an operator looking for the wrong thing \u2014 and it is how the missing reissue route hid: the attempt came back 409 and read as *already exists*.",
    file: "packages/http/src/main.ts",
    from: "    return c.json({ ok: false, error: `no local account named '${username}'` }, 404)",
    to: "    return c.json({ ok: false, error: `no local account named '${username}'` }, 409)",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["answers a different absence than admission does"],
  },
  {
    id: "a-flagged-session-is-only-redirected",
    defect:
      "The password gate stopped refusing. A redirect is what the operator sees; it is not what stops `curl` carrying the same cookie, and a guard that only moves a page looks like authorisation and is decoration.",
    file: "packages/http/src/main.ts",
    from: "  const payload = await extractJwt(c)\n  if (payload && mustChangePassword(payload.github_login)) {",
    to: "  const payload = await extractJwt(c)\n  if (false && payload && mustChangePassword(payload.github_login)) {",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["is refused everywhere, with the reason in the body"],
  },
  {
    id: "a-flagged-session-cannot-even-change-its-password",
    defect:
      "The allowlist emptied, so an account behind the first-login gate is refused on the very route that would let it through \u2014 and on `/auth/me`, so the console cannot even find out why. The account becomes unusable rather than restricted.",
    file: "packages/http/src/main.ts",
    from: "const OPEN_WHILE_FLAGGED = new Set(['/auth/local/password', '/auth/me', '/auth/logout'])",
    to: "const OPEN_WHILE_FLAGGED = new Set<string>([])",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["may change its password, ask why, and leave"],
  },
  {
    id: "an-unstated-key-requirement-defaults-to-none",
    defect:
      "`requires_key` defaulted to 0 when the caller said nothing. Every identity of a type created without the field then connects without a key \u2014 \u00a7 8.1's signing requirement disarmed by an omission in a request body.",
    file: "packages/http/src/main.ts",
    from: "  const requiresKey = body.requires_key === 0 || body.requires_key === false ? 0 : 1",
    to: "  const requiresKey = body.requires_key === 1 || body.requires_key === true ? 1 : 0",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["requires a key unless told otherwise in so many words"],
  },
  {
    id: "adding-a-type-updates-the-one-that-is-there",
    defect:
      "`addType` became an upsert. An operator re-adding an existing type with `requires_key: 0` then lowers it for every identity already carrying that type \u2014 provisioned long before anybody thought about it, and connecting without a key from the next reconnect.",
    file: "packages/store/src/schema/agents.ts",
    from: "      `INSERT INTO agent_types (type, description, requires_key) VALUES (?, ?, ?)\n       ON CONFLICT(type) DO NOTHING`,",
    to: "      `INSERT INTO agent_types (type, description, requires_key) VALUES (?, ?, ?)\n       ON CONFLICT(type) DO UPDATE SET requires_key = excluded.requires_key`,",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["refuses to update an existing type rather than lowering its guard"],
  },
  {
    id: "a-torn-down-identity-stops-holding-its-type",
    defect:
      "The in-use check stopped counting soft-deleted identities, so a type could be removed out from under one. Bringing that identity back then restores it as a kind that no longer exists.",
    file: "packages/store/src/schema/agents.ts",
    from: "  return (db.prepare(`SELECT identity FROM agents WHERE type = ?`).all(type) as Array<{ identity: string }>)",
    to: "  return (db.prepare(`SELECT identity FROM agents WHERE type = ? AND deleted_at IS NULL`).all(type) as Array<{ identity: string }>)",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["counts an identity that has been torn down"],
  },
  {
    id: "a-refusal-lists-every-identity-there-is",
    defect:
      "The refusal stopped capping the identities it names. An operator needs enough of them to go and look, not all of them \u2014 a type carried by ten thousand agents answers with ten thousand names.",
    file: "packages/http/src/main.ts",
    from: "      identities: result.inUseBy.slice(0, 20),",
    to: "      identities: result.inUseBy,",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["names at most twenty of them"],
  },
  {
    id: "a-wake-arrives-with-nothing-said-about-what-it-is-for",
    defect:
      "The delivery stopped carrying the standing order. Mail is a wake, and a wake with no closing sentence gets read as an assignment: the turn answers the message, reports, and stops, with the standing work parked and nobody typing. That is the failure the sentence exists for, and it happened repeatedly before it existed.",
    file: ".claude/hooks/mailbox.ts",
    from: "    ``,\n    STANDING_ORDER,\n  ].join(\"\\n\");",
    to: "  ].join(\"\\n\");",
    suite: "test/mailbox-hooks.test.ts",
    expect: ["ends on what the wake is for"],
  },
  {
    id: "the-idle-notification-says-only-that-mail-arrived",
    defect:
      "The watcher announced the mail and stopped there. A notification that says only *mail arrived* is answered and stopped on \u2014 the same failure as the delivery losing its closing sentence, arriving through the other component.",
    file: ".claude/hooks/mailbox-watch.ts",
    from: "  await emit(STANDING_ORDER.replace(/\\n/g, \" \"));",
    to: "  void STANDING_ORDER;",
    suite: "test/mailbox-hooks.test.ts",
    expect: ["announces new mail with a preview, and says what the wake is for"],
  },
  {
    id: "mail-is-quoted-before-it-is-qualified",
    defect:
      "The delivery quoted the message before saying what a message is worth. Another agent's mail carries no more authority than a code review comment, and a reader who meets the text first has already begun acting on it by the time the qualifier arrives.",
    file: ".claude/hooks/mailbox.ts",
    from: "  return [\n    `${messages.length} message(s) from the agent mailbox. Kept there \u2014 the mailbox is the audit record.`,",
    to: "  return [\n    ...parts,\n    `${messages.length} message(s) from the agent mailbox. Kept there \u2014 the mailbox is the audit record.`,",
    suite: "test/mailbox-hooks.test.ts",
    expect: ["says what a message is worth before quoting it"],
  },
  {
    id: "mail-that-lands-mid-turn-waits-for-the-next-prompt",
    defect:
      "The Stop hook stopped blocking, so mail arriving during a turn sits until somebody types \u2014 possibly hours, with the other side blocked that whole time on an answer already sent. Continuing the turn is the entire reason this hook runs on Stop.",
    file: ".claude/hooks/mailbox.ts",
    from: "if (input.hook_event_name === \"Stop\") {\n  console.log(JSON.stringify({\n    decision: \"block\",",
    to: "if (input.hook_event_name === \"Stop\") {\n  console.log(JSON.stringify({\n    decision: undefined,",
    suite: "test/mailbox-hooks.test.ts",
    expect: ["continues the turn, carrying the message and who sent it"],
  },
  {
    id: "a-closed-tab-is-written-to-for-ever",
    defect:
      "The `catch` around `enqueue` went, so a controller whose browser has gone is never dropped. The set grows for the life of the process and nothing reports it \u2014 a leak that is invisible until the service is writing to thousands of dead controllers.",
    file: "packages/http/src/main.ts",
    from: "    try { controller.enqueue(payload) } catch { set.delete(controller) }",
    to: "    controller.enqueue(payload)",
    suite: "packages/http/src/sse-fanout.test.ts",
    expect: ["forgets a browser that has gone, the next time it writes"],
  },
  {
    id: "a-sent-message-never-appears-as-sent",
    defect:
      "The second fan-out went, so a frame reaches the recipient's stream and not the sender's. A person watching their own outbox sees nothing when their message lands \u2014 the screen they are looking at is the one direction that stopped being pushed.",
    file: "packages/http/src/main.ts",
    from: "          // Also push to user\u2192agent direction (sent confirmation)\n          pushToSSE(msg.to, msg.from, 'message', sseMsg)",
    to: "          // Also push to user\u2192agent direction (sent confirmation)\n          void sseMsg",
    suite: "packages/http/src/sse-fanout.test.ts",
    expect: ["reaches the sender's own view as well as the recipient's"],
  },
  {
    id: "a-new-password-may-be-one-character",
    defect:
      "The length floor went. An account handed a temporary password may replace it with a single character, which is the one moment the deployment gets to insist on anything.",
    file: "packages/http/src/main.ts",
    from: "  if (typeof current !== 'string' || typeof next !== 'string' || next.length < 8) {",
    to: "  if (typeof current !== 'string' || typeof next !== 'string') {",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["refuses a next that is missing, short, or not a string"],
  },
  {
    id: "changing-a-password-to-itself-passes-the-gate",
    defect:
      "The same-password check went, so an account clears the first-login flag by re-entering the password it was handed. The gate exists to stop a password read aloud from being the account's password, and this walks straight through it.",
    file: "packages/http/src/main.ts",
    from: "  if (next === current) {\n    return c.json({ error: '`next` must differ from `current`' }, 400)\n  }",
    to: "  if (false) {\n    return c.json({ error: '`next` must differ from `current`' }, 400)\n  }",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["refuses a next that is the current one"],
  },
  {
    id: "a-wrong-password-says-the-account-is-not-there",
    defect:
      "A wrong current password started answering 404 \u2014 the answer that means *no such account*. A prober then tells a real account from an invented one by getting the password wrong, which is the cheapest possible probe.",
    file: "packages/http/src/main.ts",
    from: "  if (outcome === 'wrong-current') return c.json({ error: '`current` is not this account\\'s password' }, 403)",
    to: "  if (outcome === 'wrong-current') return c.json({ error: '`current` is not this account\\'s password' }, 404)",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["refuses a wrong current password without denying the account exists"],
  },
  {
    id: "the-password-changed-and-the-gate-stayed-shut",
    defect:
      "The change reported success while still declaring the account must change its password. The console then sends the person back to the change screen they just came from, with no way to tell that anything happened.",
    file: "packages/http/src/main.ts",
    from: "  return c.json({ ok: true, must_change_password: false })",
    to: "  return c.json({ ok: true, must_change_password: true })",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["clears the flag, and the refusal with it"],
  },
  {
    id: "a-red-run-leaves-the-window-held",
    defect:
      "The release moved behind a green run, so a window announced before a failing gate is never released. That is exactly the case where the other side most needs to know the machine is free \u2014 and where remembering to send it by hand fails, which is why this is a script at all.",
    file: "scripts/gate.ts",
    from: "const counts = summarise(captured);\nawait release(",
    to: "const counts = summarise(captured);\nif (code === 0) await release(",
    suite: "test/gate-window.test.ts",
    expect: ["releases the window when the run fails"],
  },
  {
    id: "a-stopped-run-never-says-the-machine-is-free",
    defect:
      "The signal handlers went. Somebody stops a gate with ^C and the machine is free that instant, with nothing about to say so \u2014 the other side waits on a release that cannot come, which is the observed failure this script was written for.",
    file: "scripts/gate.ts",
    from: "for (const signal of [\"SIGINT\", \"SIGTERM\"] as const) {",
    to: "for (const signal of [] as const) {",
    suite: "test/gate-window.test.ts",
    expect: ["releases the window when the run is stopped"],
  },
  {
    id: "exiting-zero-is-reported-as-a-result",
    defect:
      "A run that printed no counts started being reported by its exit code. A process can exit zero having run nothing, and calling that a pass is the shape this repository keeps finding behind its own checks \u2014 green that nobody measured.",
    file: "scripts/gate.ts",
    from: "    ? `exit ${code} \u00b7 \uc218\uce58 \uc5c6\uc74c \u2014 \uc2e4\ud589\uc774 pass/fail \uc904\uc744 \ucc0d\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.`",
    to: "    ? `${code === 0 ? \"0 pass / 0 fail\" : \"\uc2e4\ud328\"} \u00b7 exit ${code}`",
    suite: "test/gate-window.test.ts",
    expect: ["says it measured nothing rather than reading the exit code as a result"],
  },
  {
    id: "a-mailer-that-is-down-takes-the-gate-with-it",
    defect:
      "A broadcast failure stopped being swallowed, so a machine with no mailer cannot run its own gates. The run is the point and the broadcast is the courtesy; inverting that makes the coordination a dependency of the work it coordinates.",
    file: "scripts/gate.ts",
    from: "    } catch (err) {\n      // A mailer that is down must not take the gate with it: the run is the\n      // point and the broadcast is the courtesy. Said on stderr so the gap is\n      // visible here rather than only as silence on the other side.\n      console.error(`[gate] could not tell ${to}: ${err instanceof Error ? err.message : String(err)}`);\n    }",
    to: "    } catch (err) {\n      throw err;\n    }",
    suite: "test/gate-window.test.ts",
    expect: ["runs anyway when nobody is listening"],
  },
  {
    id: "lifecycle-stop-category",
    swept: true,
    defect:
      "A `stop()` that rejected the in-flight RPC with the wrong category told the caller the hub had gone away, when what happened is that this process is shutting down. The scheduler retries one of those and not the other.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: '      this.rejectGeneration(current.generation, new HubRpcError("hub lifecycle stopped", "stopped"));',
    to: '      this.rejectGeneration(current.generation, new HubRpcError("hub lifecycle stopped", "hub_closed"));',
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["rejects the in-flight request as stopped and closes the socket", "hub_closed"],
  },
  {
    id: "lifecycle-stop-closes-socket",
    swept: true,
    defect:
      "Stopping without closing the socket leaves the hub holding a registration for a process that is going away, and the identity taken until the connection times out on the other side.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: '      try { current.ws.close(1000, "self-reminder stopping"); } catch {}',
    to: "      void current;",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["rejects the in-flight request as stopped and closes the socket"],
  },
  {
    id: "lifecycle-stop-disarms-reconnect",
    swept: true,
    defect:
      "A `stop()` that left the reconnect timer armed reconnected after the shutdown — the guard is one inverted condition away, and `stopped` alone does not stop it, because the timer's callback is what consults it.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: "    if (!this.reconnectTimer) return;",
    to: "    if (this.reconnectTimer) return;",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["disarms a reconnect that was already scheduled"],
  },
  {
    id: "lifecycle-request-needs-open-socket",
    swept: true,
    defect:
      "`ready` says the hub accepted the registration; it does not say the socket is still open. Sending on a closing socket throws where a real socket is used, and the caller gets `rpc_send_failed` for what is really an unavailable hub.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: "    if (!this.owns(current.generation, current.ws) || current.ws.readyState !== 1) {",
    to: "    if (!this.owns(current.generation, current.ws)) {",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["is unavailable while the registered socket is closing", "rpc_send_failed"],
  },
  {
    id: "lifecycle-request-needs-registration",
    swept: true,
    defect:
      "A request sent before `mesh.connect` was answered goes onto a socket the hub has not associated with an identity. The hub answers nothing, so it does not fail — it waits for the RPC deadline, once per call, for as long as registration is in flight.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: "    if (!this.ready || !current) {",
    to: "    if (!current) {",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["is unavailable before the hub has accepted the registration", "mesh.connect"],
  },
  {
    id: "lifecycle-rpc-timeout-category",
    swept: true,
    defect:
      "A timeout reported as `hub_unavailable` is indistinguishable from a hub that never registered, and the two want different responses: one waits for the reconnect, the other is a hub that is up and slow.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: "        reject(new HubRpcError(`rpc timeout: ${method}`, \"rpc_timeout\"));",
    to: "        reject(new HubRpcError(`rpc timeout: ${method}`, \"hub_unavailable\"));",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["times out at the configured deadline", "hub_unavailable"],
  },
  {
    id: "lifecycle-rpc-timeout-deadline",
    swept: true,
    defect:
      "The RPC deadline armed from the reconnect backoff instead of `rpcTimeoutMs`: the same number in the default configuration, and an unrelated one in any deployment that tunes either.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: "      }, this.rpcTimeoutMs);",
    to: "      }, this.reconnectBaseMs);",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["times out at the configured deadline"],
  },
  {
    id: "lifecycle-stale-socket-error",
    swept: true,
    defect:
      "Every callback in this file is tied to a generation so a superseded socket cannot act on the live one. The error handler only logs — and a log attributed to the wrong generation is how a reconnect that worked reads as one that did not.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from:
      '    ws.on("error", () => {\n' +
      "      if (!this.owns(generation, ws)) return;\n" +
      '      this.log.warn("the hub socket reported an error", "hub_socket_error", { generation });\n' +
      "    });",
    to:
      '    ws.on("error", () => {\n' +
      '      this.log.warn("the hub socket reported an error", "hub_socket_error", { generation });\n' +
      "    });",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["an error from a superseded socket is not logged"],
  },
  {
    id: "lifecycle-post-registration-reason",
    swept: true,
    defect:
      "The post-registration failure log carried the category and discarded the message, which is the half that says what actually failed. `String(error)` on an `Error` is its class name and message glued together, not the message.",
    file: "packages/self-reminder/src/lifecycle.ts",
    from: "          error: error instanceof Error ? error.message : String(error),",
    to: "          error: String(error),",
    suite: "packages/self-reminder/src/lifecycle.test.ts",
    expect: ["a failure carries its category and message", "state write failed"],
  },
  {
    id: "conversation-order",
    swept: true,
    defect:
      "The conversation query reads newest-first and reverses, so the `LIMIT` keeps the newest messages. Ordering ascending keeps the oldest instead — a thread that shows its first twenty messages and never its last.",
    file: "packages/http/src/db.ts",
    from: `    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
    ORDER BY ts DESC`,
    to: `    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)
    ORDER BY ts ASC`,
    suite: "packages/http/src/db-store.test.ts",
    expect: ["the limit keeps the newest and still answers oldest first"],
  },
  {
    id: "conversation-chronological",
    swept: true,
    defect:
      "Dropping the reverse serves a conversation newest-first, which every caller renders top-down.",
    file: "packages/http/src/db.ts",
    from: `  const rows = stmt.all(agent1, agent2, agent2, agent1, limit) as DbMessage[]
  return rows.reverse() // chronological order`,
    to: `  const rows = stmt.all(agent1, agent2, agent2, agent1, limit) as DbMessage[]
  return rows`,
    suite: "packages/http/src/db-store.test.ts",
    expect: ["returns both directions between the two agents and nothing else"],
  },
  {
    id: "conversation-both-directions",
    swept: true,
    defect:
      "One direction of a conversation is not a conversation: the replies vanish and the thread reads as though nobody answered.",
    file: "packages/http/src/db.ts",
    from: "    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)",
    to: "    WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ? AND 0)",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["returns both directions between the two agents and nothing else"],
  },
  {
    id: "registry-count",
    swept: true,
    defect:
      "The registry count is what the admin screens page on. A count that does not move with the table pages a list that does.",
    file: "packages/http/src/db.ts",
    from: `  const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_registry').get() as { cnt: number }
  return row.cnt`,
    to: `  const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_registry WHERE 0').get() as { cnt: number }
  return row.cnt`,
    suite: "packages/http/src/db-store.test.ts",
    expect: ["rises by one for a registry agent that is new"],
  },
  {
    id: "admin-seed-stated-password",
    defect:
      "`AGENT_MESH_ADMIN_PASSWORD` is how a deployment refuses the published `admin`/`admin`. Seeding the default while the variable is set is that refusal being ignored, silently, on exactly the host that asked for it.",
    file: "packages/http/src/db.ts",
    from: "    const hash = await Bun.password.hash(supplied ?? 'admin', { algorithm: 'bcrypt' })",
    to: "    const hash = await Bun.password.hash('admin', { algorithm: 'bcrypt' })",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["with a password stated, seeds that one and names the variable"],
  },
  {
    id: "admin-seed-must-change",
    defect:
      "The owner's decision is that the first login always lands on the change screen. Without the mark, a stated password becomes the permanent one and nothing ever says so.",
    file: "packages/http/src/db.ts",
    from: `    // leave every deployment's first password permanent.
    db.prepare(\`UPDATE local_users SET must_change_password = 1 WHERE username = ?\`).run(SEED_ADMIN_USERNAME)`,
    to: `    // leave every deployment's first password permanent.
    void db`,
    suite: "packages/http/src/db-store.test.ts",
    expect: ["a stated password is an initial one"],
  },
  {
    id: "admin-reseed-verifies-first",
    defect:
      "The re-seed marks an admin that still has its initial password. Marking without asking locks out somebody who already chose one — the boot after their change sends them back to the change screen with a password the screen will not accept.",
    file: "packages/http/src/db.ts",
    from: "      if (await Bun.password.verify(initial, admin.password_hash)) {",
    to: "      if (true) {",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["an admin who chose a password is left alone"],
  },
  {
    id: "admin-reseed-initial-is-stated",
    defect:
      "The password being checked for is whatever this deployment seeded, not the documented default. Checking `admin` on a host that stated one asks a question whose answer is always no, and the account keeps its initial password with nothing marked.",
    file: "packages/http/src/db.ts",
    from: "      const initial = process.env.AGENT_MESH_ADMIN_PASSWORD ?? 'admin'",
    to: "      const initial = 'admin'",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["the initial password it checks against is the stated one"],
  },
  {
    id: "admin-reseed-skips-marked",
    defect:
      "An admin already marked is asked again on every boot, which costs a bcrypt verify per start and warns about an initial password that the next login is already going to change.",
    file: "packages/http/src/db.ts",
    from: "    if (admin && admin.must_change_password !== 1) {",
    to: "    if (admin) {",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["an admin already marked is not re-checked against the initial password"],
  },
  {
    id: "http-db-close-folds",
    defect:
      "`close()` on a handle with statements still prepared against it is a safe close in bun: marked closed to JavaScript, file left open, nothing checkpointed. `agent-mesh.db` folded on a bare close and `audit.db` did not, in the same process on the same run — which is why the checkpoint is explicit here rather than left to the close.",
    file: "packages/http/src/db.ts",
    from: "    checkpointForShutdown(_db)",
    to: "    void _db",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["folds the log rather than leaving it beside a one-page database"],
  },
  {
    id: "http-db-close-forgets-handle",
    defect:
      "Closing without forgetting the handle hands the next caller a closed database, and every read after a shutdown fails with `Database has closed` rather than reopening.",
    file: "packages/http/src/db.ts",
    from: `    _db.close()
    _db = null`,
    to: "    _db.close()",
    suite: "packages/http/src/db-store.test.ts",
    expect: ["opens a new handle rather than handing back the closed one"],
  },
  {
    id: "declared-proxies-trim",
    swept: true,
    defect:
      "`AGENT_MESH_PROXY_IDENTITIES=a, b` is how anybody writes a list. Without the trim the second identity is ` b`, which matches no row, and the proxy silently cannot proxy.",
    file: "packages/hub/src/db.ts",
    from: "      .map((s) => s.trim())",
    to: "      .map((s) => s)",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["reads a comma-separated list, spacing and all"],
  },
  {
    id: "declared-proxies-empty-segment",
    swept: true,
    defect:
      "An unset variable splits to one empty string, so without the filter every deployment declares the empty identity a proxy. Harmless only for as long as no row has that identity.",
    file: "packages/hub/src/db.ts",
    from: "      .filter(Boolean),",
    to: "      .filter(() => true),",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["an empty segment is not an identity"],
  },
  {
    id: "declared-proxy-guard",
    defect:
      "Speaking on behalf of other identities is the strongest thing a participant holds, and § 8.2 has an operator declare who may. Applying it to whoever asks is the hole the declaration exists to close.",
    file: "packages/hub/src/db.ts",
    from: "  if (!declared.has(identity)) return;",
    to: "  if (declared.has(identity)) return;",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["grants the declared identity"],
  },
  {
    id: "shutdown-folds-audit",
    defect:
      "`audit` is the store § 8.9 keeps indefinitely and the one the hub never closes. Leaving it out of the fold is invisible in every suite and shows up as a log beside a database that never grew.",
    file: "packages/hub/src/db.ts",
    from: "  for (const store of [stores.routing, stores.agents, stores.audit, stores.selfReminder]) {",
    to: "  for (const store of [stores.routing, stores.agents, stores.selfReminder]) {",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["folds every log it owns, including the store it does not close", "audit.db"],
  },
  {
    id: "shutdown-closes-agents",
    swept: true,
    defect:
      "The closes are what stops further use after the fold — a smaller job than the checkpoint, and the one that keeps a shutdown from being a suggestion.",
    file: "packages/hub/src/db.ts",
    from: "  stores.agents.close();",
    to: "  void stores.agents;",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["stops further use of the routing and identity stores"],
  },
  {
    id: "shutdown-keeps-lazy-handle",
    swept: true,
    defect:
      "Forgetting the module's lazy handle whenever anything is shut down means a caller closing stores it opened itself takes the hub's scheduler handle with it, and the next reminder RPC opens a second one against a file that already has a writer.",
    file: "packages/hub/src/db.ts",
    from: "  if (stores.selfReminder === _srDb) _srDb = null;",
    to: "  _srDb = null;",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["closing another caller's stores does not take this module's lazy handle with it"],
  },
  {
    id: "sr-db-memoised",
    swept: true,
    defect:
      "A getter that reopens on every call hands out a new writer per reminder RPC, each with its own lock on the same file — the shape that produces `database is locked` under any concurrency at all.",
    file: "packages/hub/src/db.ts",
    from: "  if (!_srDb) {",
    to: "  if (true) {",
    suite: "packages/hub/src/db-stores.test.ts",
    expect: ["opens the scheduler's store on first use and hands back the same handle after"],
  },
  {
    id: "keys-decision-store-failure",
    swept: true,
    defect:
      "`KeyTransitionError` says the operator's request was wrong — the fingerprint does not exist, or somebody decided it first. Anything else says this server could not answer at all, and reporting that as a 404 sends an operator looking for a fingerprint that is sitting exactly where they left it.",
    file: "packages/http/src/keys-admin.ts",
    from: "    if (err instanceof KeyTransitionError) {",
    to: "    if (true) {",
    suite: "packages/http/src/keys-admin.test.ts",
    expect: ["a store that cannot answer is a 500 carrying the reason"],
  },
  {
    id: "agents-handle-reopened",
    swept: true,
    defect:
      "A close that does not forget the handle hands the next caller a closed database, and every key decision after a shutdown fails with `Database has closed` rather than opening the store again.",
    file: "packages/http/src/keys-admin.ts",
    from: `    _agentsDb.close()
  }
  _agentsDb = null`,
    to: `    _agentsDb.close()
  }`,
    suite: "packages/http/src/store-handles.test.ts",
    expect: ["hands out a new handle rather than the closed one"],
  },
  {
    id: "agents-close-folds",
    swept: true,
    defect:
      "`close()` on a handle with statements prepared against it is a safe close in bun: marked closed to JavaScript, file left open, nothing checkpointed. The fold has to be explicit or the identity store goes out with its log beside it.",
    file: "packages/http/src/keys-admin.ts",
    from: "    checkpointForShutdown(_agentsDb)",
    to: "    void _agentsDb",
    suite: "packages/http/src/store-handles.test.ts",
    expect: ["folds the identity store's log"],
  },
  {
    id: "audit-query-handle-reopened",
    swept: true,
    defect:
      "The § 9.1 query handle is read-only and lazy. Closing it without forgetting it leaves every audit read after a shutdown failing on a closed database.",
    file: "packages/http/src/audit-query.ts",
    from: `  _auditDb?.close()
  _auditDb = null`,
    to: "  _auditDb?.close()",
    suite: "packages/http/src/store-handles.test.ts",
    expect: ["the query handle is reopened for the next caller"],
  },
  {
    id: "access-log-handle-reopened",
    swept: true,
    defect:
      "The § 8.9 access log is written before a read is served, and its handle is lazy. A close that keeps the closed handle means the first read after a shutdown cannot be recorded — and a read that cannot be recorded is refused, so the store closing quietly stops audit reads.",
    file: "packages/http/src/audit-access-log.ts",
    from: `    _db.close()
  }
  _db = null`,
    to: `    _db.close()
  }`,
    suite: "packages/http/src/store-handles.test.ts",
    expect: ["the next read is recorded, on a handle opened again"],
  },
  {
    id: "blob-handle-reopened",
    swept: true,
    defect:
      "Same shape on the upload path: the handle the § 8.9.2 grant is checked against is lazy, and a close that keeps it means the next upload is refused by a closed database rather than by its grant.",
    file: "packages/http/src/audit-blobs.ts",
    from: `    _agentsDb.close()
  }
  _agentsDb = null`,
    to: `    _agentsDb.close()
  }`,
    suite: "packages/http/src/audit-blobs.test.ts",
    expect: ["the upload after a shutdown gets a working handle"],
  },
  {
    id: "provision-identity-rule",
    swept: true,
    defect:
      "§ 10.1 compares identities case-sensitively and the hub applies the pattern. Sending a login the rule rejects means the refusal comes back from the hub as an opaque 400 instead of naming the rule, and nothing local ever says which login could not be a mesh identity.",
    file: "packages/http/src/provision.ts",
    from: "  if (!IDENTITY_RE.test(identity)) {",
    to: "  if (!/^.*$/.test(identity)) {",
    suite: "packages/http/src/provision.test.ts",
    expect: ["a login § 10.1 would refuse is reported, not mangled to fit"],
  },
  {
    id: "provision-reports-hub-reason",
    swept: true,
    defect:
      "`HTTP 409` on its own does not say whether the identity is taken, torn down, or misspelled. The hub sends the reason and this is the only place a person sees it.",
    file: "packages/http/src/provision.ts",
    from: "    if (parsed?.error) detail = `${detail}: ${parsed.error}`",
    to: "    void parsed",
    suite: "packages/http/src/provision.test.ts",
    expect: ["a refusal carries the hub's own reason"],
  },
  {
    id: "provision-names-the-failures",
    swept: true,
    defect:
      "An unregistered person still signs in, sends and receives — the hub simply has no record of who they are. Nothing else in the service announces that, so a silent loop here is a mesh half of whose people do not exist.",
    file: "packages/http/src/provision.ts",
    from:
      "    log.warn(`could not register ${failures.length} person(s) as mesh identities`, \"people_provision_failed\", {\n" +
      "      count: failures.length,\n" +
      "      failures,\n" +
      '      outcome: "failed",\n' +
      '      reason: "hub_refused",\n' +
      "    })",
    to: "    void failures",
    suite: "packages/http/src/provision.test.ts",
    expect: ["names everyone it could not register, and why"],
  },
  {
    id: "jwt-secret-required",
    defect:
      "It used to fall back to a published constant, which is worse than no authentication: every session token this process issued could be forged by anyone who had read the source, and a deployment that forgot the variable looked exactly like one that had set it. An empty string is the same misconfiguration wearing a different value.",
    file: "packages/http/src/auth.ts",
    from: "  if (secret) return secret",
    to: "  if (secret !== undefined) return secret",
    suite: "packages/http/src/auth-github.test.ts",
    expect: ["an empty secret is an unset one"],
  },
  {
    id: "key-proposal-poll-reports",
    defect:
      "The first version swallowed the error in silence, under a comment saying silence is the failure this file exists to prevent. A broken query then left the § 10.2.1 stream looking perfectly healthy while it pushed nothing.",
    file: "packages/http/src/key-proposals.ts",
    from: "      log.error(",
    to: "      void 0 && log.error(",
    suite: "packages/http/src/key-proposals.test.ts",
    expect: ["a read that fails is reported and does not take the poll down"],
  },
  {
    id: "refusal-counts-ordering",
    swept: true,
    defect:
      "The counters exist so an operator can ask *is something failing to get in*. A list not ordered by how often each reason fired answers that question with a directory, and the reason that is firing hundreds of times a minute sits wherever the map happened to put it.",
    file: "packages/hub/src/refusals.ts",
    from: "    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));",
    to: "    .sort((a, b) => a.reason.localeCompare(b.reason));",
    suite: "packages/hub/src/refusals.test.ts",
    expect: ["most frequent first, and ties broken by reason so the order is stable"],
  },
  {
    id: "teardown-records-actor",
    defect:
      "§ 10.2 requires each key transition to carry who caused it, and this is the whole reason teardown goes through an authenticated caller. Writing a constant records that a revocation happened without recording who is answerable for it.",
    file: "packages/store/src/teardown.ts",
    from: "      ).run(randomUUID(), identity, fingerprint, actor);",
    to: "      ).run(randomUUID(), identity, fingerprint, 'hub');",
    suite: "packages/store/src/teardown.test.ts",
    expect: ["writes one history row per revoked key, naming the actor and the reason"],
  },
  {
    id: "teardown-revokes-only-live-keys",
    swept: true,
    defect:
      "The fingerprints are read before the revocation so the history explains the transition. Reading every key of the identity instead writes a second `revoked` event for one that was revoked months ago — and reports it in `revoked`, so the caller is told a key changed state that did not.",
    file: "packages/store/src/teardown.ts",
    from: "    .prepare(`SELECT fingerprint FROM agent_keys WHERE identity = ? AND status IN ('pending','approved')`)",
    to: "    .prepare(`SELECT fingerprint FROM agent_keys WHERE identity = ?`)",
    suite: "packages/store/src/teardown.test.ts",
    expect: ["a key already revoked is left where it is, and writes no second event"],
  },
  {
    id: "send-persist-failure-answered",
    defect:
      "Unguarded, a failed write threw out of the WebSocket message handler and the send simply never answered. On a full volume that is routing stopping because storage filled, which is the inversion § 15.6 exists to forbid.",
    file: "packages/hub/src/rpc/send.ts",
    from: "    return rpcError(id, SERVER_ERROR, `could not persist message: ${message}`, {",
    to: "    throw err; return rpcError(id, SERVER_ERROR, `could not persist message: ${message}`, {",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["a write that fails is answered, as a transient the caller can retry"],
  },
  {
    id: "send-dropped-frame-is-queued",
    defect:
      "A socket in the map is somebody who connected, not somebody who received: `ws.send` reports a drop by returning 0 rather than by throwing. Deciding the recorded status from presence and never revisiting it made every send to a socket that had gone away an audited delivery.",
    file: "packages/hub/src/rpc/send.ts",
    from: `      stmtUpdateMessageStatus.run("pending", msgId);
      status = "pending";`,
    to: `      stmtUpdateMessageStatus.run("pending", msgId);
      status = "delivered";`,
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["a frame the socket drops is queued, not recorded as delivered"],
  },
  {
    id: "send-throwing-socket-is-queued",
    defect:
      "The other half of the same defect: a socket that throws on the way out is a message that did not arrive, and treating the throw as a delivery records one that never happened.",
    file: "packages/hub/src/rpc/send.ts",
    from: `      landed = false;
      why = err instanceof Error ? err.message : String(err);`,
    to: "      landed = true;",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["a socket that throws on the way out is queued the same way"],
  },
  {
    id: "dormancy-check-wired",
    defect:
      "§ 8.11.2 is a checker in `dormancy.ts` and one call in the send path. The checker is tested beside itself; unwiring the call leaves every one of those tests green while a key silent for months sends from anywhere it likes.",
    file: "packages/hub/src/rpc/send.ts",
    from: "  const dormancy = checkDormantSource(agentsDb, effectiveSender, senderIdentity, observedOf(ws));",
    to: "  const dormancy = { refusal: null } as ReturnType<typeof checkDormantSource>;",
    suite: "packages/hub/src/rpc/send.test.ts",
    expect: ["is refused, and told what an operator has to review"],
  },
  {
    id: "signed-freshness-checked",
    defect:
      "Without the freshness window a captured `Authorization` header is valid forever — the nonce stops it being replayed inside the window, and nothing stops it outside one.",
    file: "packages/hub/src/rest/signed.ts",
    from: "  if (Math.abs(now - auth.iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {",
    to: "  if (false) {",
    suite: "packages/hub/src/rest/signed.test.ts",
    expect: ["an iat outside the freshness window, in either direction"],
  },
  {
    id: "signed-nonce-spent",
    defect:
      "§ 8.1 spends the nonce before anything else can fail, so a captured request has one attempt whatever is wrong with it. Recording only on success leaves it replayable without limit.",
    file: "packages/hub/src/rest/signed.ts",
    from: "  if (!nonceWindow.claim(auth.kid, auth.nonce, auth.iat)) {",
    to: "  if (false && !nonceWindow.claim(auth.kid, auth.nonce, auth.iat)) {",
    suite: "packages/hub/src/rest/signed.test.ts",
    expect: ["a nonce is spent even by a request whose signature does not verify"],
  },
  {
    id: "signed-budget-taken",
    defect:
      "§ 14 exists so one lane cannot starve the others. A limiter that is consulted and never spends is decoration, and decoration and protection look identical from outside: no errors either way.",
    file: "packages/hub/src/rest/signed.ts",
    from: "  const budget = SIGNED_LIMIT.take(identity);",
    to: "  const budget = { ok: true, retryAfter: 0, remaining: 0 };",
    suite: "packages/hub/src/rest/signed.test.ts",
    expect: ["a caller over its § 14 budget, with how long to wait"],
  },
  {
    id: "signed-source-recorded",
    defect:
      "§ 8.11 records where each identity has been seen, and § 8.11.2 refuses a dormant key arriving from somewhere new by reading exactly that table. A signed surface that records nothing leaves the dormancy check with no history to compare against, so it never refuses anything.",
    file: "packages/hub/src/rest/signed.ts",
    from: "  sources.recordSource(agentsDb, identity, observed);",
    to: "  void observed;",
    suite: "packages/hub/src/rest/signed.test.ts",
    expect: ["the address it was seen on is recorded"],
  },
  {
    id: "audit-duplicate-check-answered",
    swept: true,
    defect:
      "A duplicate check that cannot be read used to reach the dispatcher's last-resort handler, which answers a worse error than this one — and one § 8.9.3 does not classify, so a conformant client does not know whether to retry it.",
    file: "packages/hub/src/rpc/audit.ts",
    from:
      '    log.error("could not read the audit store to check for a duplicate", "audit_duplicate_check_failed", {\n' +
      "      id: eventId,\n" +
      '      outcome: "failed",\n' +
      '      reason: "store_unreadable",\n' +
      "      error: message,\n" +
      "    });",
    to: "    throw err;",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["a duplicate check that cannot be read is answered, not thrown"],
  },
  {
    id: "audit-exhaustion-is-transient",
    defect:
      "§ 15.6: audit exhaustion must not take message delivery with it, and a full volume is the realistic case because separate volumes are a deployment choice. Reported as a permanent failure the client drops the event instead of holding it until an operator frees space.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    if (/disk|full|SQLITE_FULL|no space/i.test(message)) {",
    to: "    if (false) {",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["a full volume is transient, and says so in its own code"],
  },
  {
    id: "audit-unknown-failure-is-permanent",
    defect:
      "**Not `AUDIT_BUSY`.** § 8.9.3 classes that transient, and a conformant client retries transient errors with backoff and no maximum attempt count. A constraint violation or a bug in the handler fails identically on every attempt, so reporting one that way is the infinite retry the same paragraph exists to prevent.",
    file: "packages/hub/src/rpc/audit.ts",
    from: "    if (/locked|busy/i.test(message)) {",
    to: "    if (true) {",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["anything else is permanent, so the client stops rather than retrying forever"],
  },
  {
    id: "audit-own-event-never-throws",
    defect:
      "The hub's own § 8.9.4 records are written on the delivery path. An audit store that throws there takes routing down with it, which is § 15.6 inverted — so they are logged and swallowed, and nothing had ever made one fail.",
    file: "packages/hub/src/rpc/audit.ts",
    from:
      '    log.error(`could not record ${eventType}, and the change went through anyway`, "audit_own_event_failed", {\n' +
      "      actor: fields.identity,\n" +
      "      event_type: eventType,\n" +
      '      outcome: "unrecorded",\n' +
      '      reason: "store_unwritable",\n' +
      "      error: err instanceof Error ? err.message : String(err),\n" +
      "    });",
    to: "    throw err;",
    suite: "packages/hub/src/rpc/audit-append.test.ts",
    expect: ["the hub's own identity event is logged rather than thrown"],
  },
  {
    id: "replay-stops-on-a-dropped-frame",
    defect:
      "`ws.send` returns 0 for a dropped frame instead of throwing, so the replay used to walk a closing socket to the end, flip every row to `delivered`, and write an audit event per message saying a participant received mail that went nowhere. Not recoverable: a row marked delivered is not pending, so the next connect never replays it.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "      if (!landed) {",
    to: "      if (false) {",
    suite: "packages/hub/src/rpc/connect.test.ts",
    expect: ["a dropped frame stops the replay and leaves the rest queued"],
  },
  {
    id: "replay-stops-on-a-throwing-socket",
    swept: true,
    defect:
      "The other ending: a socket that throws mid-replay. Carrying on marks the rest delivered to a connection that is already gone, and each row is then invisible to the replay that would have handed it over.",
    file: "packages/hub/src/rpc/connect.ts",
    from: "      });\n      break; // stop if connection is broken",
    to: "      });",
    suite: "packages/hub/src/rpc/connect.test.ts",
    expect: ["a socket that fails once keeps what landed and stops there"],
  },
  {
    id: "upload-counts-the-file-itself",
    defect:
      "`Content-Length` bounds the envelope and the envelope is not the file: the slack that covers the multipart boundary and headers is exactly the gap a file just over the ceiling fits into. The declaration is what an honest client always sends; the count is what a dishonest one cannot avoid.",
    file: "packages/http/src/main.ts",
    from: "  if (file.size > UPLOAD_MAX_BYTES) {",
    to: "  if (false) {",
    suite: "packages/http/src/upload.test.ts",
    expect: ["a file inside the envelope's slack and over the ceiling itself"],
  },
  {
    id: "attachment-must-be-a-file",
    swept: true,
    defect:
      "The path policy answers *where*, not *what*. A directory satisfies it and `existsSync`, and streaming one is not a download — it is a handler throwing where a `400` belongs.",
    file: "packages/http/src/main.ts",
    from: "  const stat = statSync(filePath)\n  if (!stat.isFile()) {",
    to: "  const stat = statSync(filePath)\n  if (false) {",
    suite: "packages/http/src/attachments.test.ts",
    expect: ["an id that names a directory is not a file, and says so"],
  },
  {
    id: "teardown-failure-is-reported",
    defect:
      "A teardown is destructive and irreversible, so a write that did not happen has to be said out loud. Answering anything but an error reports an identity torn down that is still live and still routing.",
    file: "packages/http/src/main.ts",
    from: "    return c.json({ ok: false, error: `db error: ${msg}` }, 500)",
    to: "    return c.json({ ok: true, action: 'soft-deleted' }, 200)",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a teardown that could not be written is a 500 that says so"],
  },
  {
    id: "telemetry-queue-unknown-is-null",
    swept: true,
    defect:
      "§ 11.3's document is assembled from several stores. A queue depth that could not be read reported as `0` is the answer an operator hopes for, which is exactly when nobody questions it — the same reasoning as the mailbox column that reports `— 미보고` rather than zero.",
    file: "packages/http/src/main.ts",
    from: "        return { waiting: null, oldest: null }",
    to: "        return { waiting: 0, oldest: null }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a queue depth it cannot read is null, and the rest of the document still answers"],
  },
  {
    id: "audit-stream-survives-a-gap-fetch",
    swept: true,
    defect:
      "The § 8.9 stream's gap fetch is a convenience — it hands a reconnecting console what it missed. A failure there taking the stream with it turns a store hiccup into every open console being unable to reconnect.",
    file: "packages/http/src/main.ts",
    from:
      "          log.error('the gap fetch failed, and the stream stays open', 'audit_gap_failed', {\n" +
      "            id: lastEventId,\n" +
      "            outcome: 'failed',\n" +
      "            reason: 'store_unreadable',\n" +
      "            error: err instanceof Error ? err.message : String(err),\n" +
      "          })",
    to: "          throw err",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a gap fetch that fails leaves the stream open and live"],
  },
  {
    id: "jwt-refusal-says-why",
    swept: true,
    defect:
      "Exiting without saying why is a process that dies at boot with nothing in the log — the operator sees a service that will not start and no reason, which is the same investigation as the misconfiguration itself.",
    file: "packages/http/src/auth.ts",
    from: "  console.error(message)",
    to: "  void message",
    suite: "packages/http/src/auth-github.test.ts",
    expect: ["the default refusal reports the reason and stops the process"],
  },
  {
    id: "harness-close-wait-answers-what-it-knows",
    swept: true,
    defect:
      "`closed()` is how a scenario asserts the hub hung up. Waiting again for a socket that has already closed means the answer arrives at the deadline instead of immediately — and for a close that already happened, never: the waiter is registered after the event it is waiting for.",
    file: "test/harness.ts",
    from: "      if (closeCode !== null) return Promise.resolve(closeCode);",
    to: "      if (false) return Promise.resolve(closeCode);",
    suite: "test/hub.test.ts",
    expect: ["waiting for a close the hub never makes answers null, and a real one answers its code"],
  },
  {
    id: "any-cookie-counts-as-a-session",
    defect:
      "The session check went back to *was there a Set-Cookie at all*, which is what `loginAsAdmin` did before the four copies were merged. A CSRF or locale cookie set on the way to the login page then reads as a signed-in account, and every request after it goes out unauthenticated to be refused somewhere else.",
    file: "test/harness.ts",
    from: '  if (!cookie.startsWith("mesh_token=")) {',
    to: "  if (!cookie) {",
    suite: "test/harness-boot.test.ts",
    expect: ["neither is some other cookie"],
  },
  {
    id: "a-cookie-that-merely-starts-like-the-session",
    defect:
      "The `=` came off the session cookie's name, so any cookie whose name begins with `mesh_token` \u2014 a hint, a flag, a next-version cookie set alongside \u2014 is taken for the session and sent as one.",
    file: "test/harness.ts",
    from: '  if (!cookie.startsWith("mesh_token=")) {',
    to: '  if (!cookie.startsWith("mesh_token")) {',
    suite: "test/harness-boot.test.ts",
    expect: ["the name has to be the whole name"],
  },
  {
    id: "the-session-carries-its-own-attributes-back",
    defect:
      "The cookie's attributes stopped being dropped. `Path`, `HttpOnly` and `SameSite` belong to `Set-Cookie` and are not part of what a client sends back, so every later request carries a `Cookie` header the server reads as further cookies with no values.",
    file: "test/harness.ts",
    from: '  const cookie = (setCookie ?? "").split(";")[0] ?? "";',
    to: '  const cookie = setCookie ?? "";',
    suite: "test/harness-boot.test.ts",
    expect: ["drops its attributes"],
  },
  {
    id: "an-agent-that-never-signs-looks-like-an-attack",
    defect:
      "The unsigned refusal is counted as `invalid`, which is the state this was found in \u2014 the label was recovered by matching a message that never matched. The two readings are opposite: `invalid` says signatures are arriving and failing to verify, which is what somebody trying keys looks like; `unsigned` says a client is not signing at all and its operator has to load a key. The second was reported as the first.",
    file: "packages/hub/src/signature.ts",
    from: '      reason: "unsigned",',
    to: '      reason: "invalid",',
    suite: "packages/hub/src/signature.test.ts",
    expect: ["each refusal is counted under its own name"],
  },
  {
    id: "every-signature-refusal-is-the-same-refusal",
    defect:
      "The counter stopped taking the label off the verdict and wrote one constant. Every signature refusal then reads alike, so the metric can say something is failing to get in and never which thing \u2014 a replayed nonce, an expired clock and a stolen key all arrive as one number.",
    file: "packages/hub/src/signature.ts",
    from: '  if (!verdict.ok) recordRefusal("signature", verdict.reason);',
    to: '  if (!verdict.ok) recordRefusal("signature", "invalid");',
    suite: "packages/hub/src/signature.test.ts",
    expect: ["each refusal is counted under its own name"],
  },
  {
    id: "a-stolen-key-counts-as-a-bad-signature",
    defect:
      "A signature made with a key that is not this identity's approved one stopped being named. `wrong-key` is the one refusal in this list that means a key exists, verifies, and belongs to somebody else \u2014 counting it as `invalid` hides the only signal that separates a broken client from a borrowed credential.",
    file: "packages/hub/src/signature.ts",
    from: '    reason: outcome.reason === "wrong-key" ? "wrong-key" : "invalid",',
    to: '    reason: "invalid",',
    suite: "packages/hub/src/signature.test.ts",
    expect: ["each refusal is counted under its own name"],
  },
  {
    id: "a-counter-key-written-as-a-sentence",
    defect:
      "A logged `reason` became prose. The counter map is keyed on it, so the logger files it under `other` \u2014 the line still says what happened and the metric stops being able to. `push_failed` is then a number with no breakdown, which is the state it was in before it had one.",
    file: "packages/http/src/push.ts",
    from: '            reason: drop ? "endpoint_gone" : "push_service_error",',
    to: '            reason: drop ? "endpoint is gone" : "push_service_error",',
    suite: "test/logging-ops.test.ts",
    expect: ["every reason a service logs is one a counter can key on"],
  },
  {
    id: "the-last-grantor-can-revoke-itself",
    defect:
      "The guard on the last `role.grant` went away. It is the one capability that can undo itself \u2014 granting requires holding it \u2014 so the tenant is left with nobody able to grant anything, and the person who could put it back is the person who cannot. A restart re-seeds it, which is a repair asked for by somebody looking at a 403 with no way to know a restart is what they need.",
    file: "packages/http/src/main.ts",
    from: "  if (capability === CAPABILITY.ROLE_GRANT) {",
    to: "  if (false) {",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["refuses to revoke itself"],
  },
  {
    id: "a-narrow-grant-counts-as-somebody-who-can-grant",
    defect:
      "The last-grantor arithmetic stopped looking at scope. `requireCapability` widens a tenant-wide grant to any narrower scope and never the other way, so a subject left holding `role.grant` on one agent cannot use the grant routes at all \u2014 counting them as a holder allows exactly the revoke that strands the tenant.",
    file: "packages/http/src/main.ts",
    from: "  return !left.some((h) => h.scope === SCOPE_TENANT)",
    to: "  return left.length === 0",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["not somebody who can grant"],
  },
  {
    id: "removing-one-row-removes-the-subject",
    defect:
      "The row being removed was matched by subject alone. A subject holding `role.grant` both tenant-wide and on one agent then looks like they are losing everything when they give up the narrow one, and a legitimate revoke is refused \u2014 the guard turning into an obstacle is how a guard gets deleted.",
    file: "packages/http/src/main.ts",
    from: "    (h) => !(h.subject === removing.subject && h.scope === removing.scope),",
    to: "    (h) => h.subject !== removing.subject,",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["keeps the tenant one"],
  },
  {
    id: "the-matrix-says-every-chip-is-clickable",
    defect:
      "The grants map reported every row as revocable. The screen then offers a control the server refuses \u2014 the operator clicks, gets a 409, and the two halves disagree about a rule only one of them is checking.",
    file: "packages/http/src/main.ts",
    from: "    if (cap === CAPABILITY.ROLE_GRANT && revokeStrandsTheTenant(roleGrantHolders, row)) return 'last_grantor'",
    to: "    if (false) return 'last_grantor'",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["says which grant cannot be revoked"],
  },
  {
    id: "a-protected-account-chip-looks-clickable",
    defect:
      "The grants map stopped marking a protected account's rows. Every one of them is re-seeded on the next start, so the console offers a revoke that appears to work, does nothing lasting, and says neither \u2014 the failure D-746 is about, moved from the screen into the payload.",
    file: "packages/http/src/main.ts",
    from: "    if (protectedAccounts.has(row.subject)) return 'protected_account'",
    to: "    if (false) return 'protected_account'",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["every one of its rows is locked"],
  },
  {
    id: "the-locked-row-list-names-nobody",
    defect:
      "`immutable_subjects` went out empty. The console locks a **row**, including the chips a protected account does not hold yet, and an empty list leaves every unassigned chip offered \u2014 a grant written there is then removed by the next revoke the operator is refused.",
    file: "packages/http/src/main.ts",
    from: "    immutable_subjects: [...protectedAccounts],",
    to: "    immutable_subjects: [],",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["is named in the response"],
  },
  {
    id: "a-protected-account-can-be-stripped",
    defect:
      "The `DELETE` guard went away, leaving the rule on the screen alone. The API is reachable without the screen, so the revoke succeeds, the operator sees the chip clear, and the next restart puts it back \u2014 the state that reads as a control working right up until it is relied on.",
    file: "packages/http/src/main.ts",
    from: "  if (protectedSubjects().includes(subject)) {",
    to: "  if (false) {",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["refuses the revoke the screen will not offer"],
  },
  {
    id: "the-tenant-seed-overwrites-a-rename",
    defect:
      "The default tenant's seed stopped conceding to what is there. Every start runs `migrate`, so an operator renames the tenant, watches it work, and finds it back the following morning with nothing in the log about it.",
    file: "packages/store/src/tenants.ts",
    from: "    `INSERT INTO tenants (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING`,",
    to: "    `INSERT INTO tenants (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name`,",
    suite: "packages/store/src/tenants.test.ts",
    expect: ["keeps a rename across the next migration"],
  },
  {
    id: "deleting-a-tenant-removes-the-row",
    defect:
      "The soft delete became a real one. A tenant id is a plain string in `agents`, `local_users`, `agent_groups` and `message_stats` with nothing pointing back at the list \u2014 removing the row leaves last month's traffic attributed to an id that resolves to nothing, and \u00a7 11.4's answer for it becomes blank rather than a name.",
    file: "packages/store/src/tenants.ts",
    from: "      .prepare(`UPDATE tenants SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`)",
    to: "      .prepare(`DELETE FROM tenants WHERE id = ? AND deleted_at IS NULL`)",
    suite: "packages/store/src/tenants.test.ts",
    expect: ["keeps the row the other tables point at"],
  },
  {
    id: "the-default-tenant-can-be-deleted",
    defect:
      "The guard on the default tenant went away. Every row whose tenant nobody stated is in it \u2014 including the seeded administrator's \u2014 so deleting it removes the only tenant the installation is guaranteed to have while everything still points there.",
    file: "packages/store/src/tenants.ts",
    from: "  if (id === DEFAULT_TENANT) return false;",
    to: "  if (false) return false;",
    suite: "packages/store/src/tenants.test.ts",
    expect: ["cannot be deleted"],
  },
  {
    id: "anybody-can-manage-the-tenant-list",
    defect:
      "The platform-administrator stand-in stopped being checked. Any approved session could then create, rename and retire tenants \u2014 including tenants it cannot see \u2014 which is the whole of what T-026 reserved to the installation's administrator while the capability for it does not exist.",
    file: "packages/http/src/main.ts",
    from: "  if (!administratorLogins().includes(actor)) {",
    to: "  if (false) {",
    suite: "packages/http/src/tenants-admin.test.ts",
    expect: ["refuses an ordinary session"],
  },
  {
    id: "the-tenant-directory-shows-everybody-everything",
    defect:
      "The directory stopped filtering. An ordinary session then reads the name of every tenant in the installation from a route that exists so a screen can show *its own* tenant's name instead of an id.",
    file: "packages/http/src/main.ts",
    from: "  const visible = isPlatformAdmin ? all : all.filter((t) => t.id === mine)",
    to: "  const visible = all",
    suite: "packages/http/src/tenants-admin.test.ts",
    expect: ["its own tenant and nothing else"],
  },
  {
    id: "a-pending-session-reads-the-tenant-directory",
    defect:
      "The approval check went away from the one admin route that holds no capability of its own. \u00a7 9.1's three states collapse to two: a person still waiting in `GET /api/v1/admin/pending` reads the tenant list.",
    file: "packages/http/src/main.ts",
    from: "  if (!isUserApproved(actor, payload.role as string)) {",
    to: "  if (false) {",
    suite: "packages/http/src/tenants-admin.test.ts",
    expect: ["refuses a session nobody has approved"],
  },
  {
    id: "an-account-is-admitted-into-any-tenant-the-body-names",
    defect:
      "`tenantForWrite` stopped checking whose tenant was named, so the tenant on a write went back to being whatever the body said. It gates four routes \u2014 admission, group creation, moves and egress \u2014 and the capability in front of each is held *inside* a tenant, so an operator could create accounts and groups in tenants they cannot see.",
    file: "packages/http/src/main.ts",
    from: "  if (tenant !== mine && !administratorLogins().includes(actor)) {",
    to: "  if (false) {",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["refuses a tenant that is not the operator's own"],
  },
  {
    id: "an-account-is-admitted-into-a-tenant-nobody-created",
    defect:
      "The tenant on a write stopped being checked against the list. Every table holding a tenant holds it as a plain string with nothing pointing back, so an account or a group written into a typo sits in a tenant no screen will ever show and no picker can move it out of.",
    file: "packages/http/src/main.ts",
    from: "  if (!tenantsStore.tenantIsOpen(agentsDb(), tenant)) {",
    to: "  if (false) {",
    suite: "packages/http/src/admin-users-types.test.ts",
    expect: ["it has to exist"],
  },
  {
    id: "the-group-listing-reads-one-tenant",
    defect:
      "`GET /api/v1/admin/groups` went back to listing `default` and only `default` \u2014 the state every version of this route was in until T-026. A group created in another tenant is written, is real, decides sends, and is invisible to the one screen that would have shown it.",
    file: "packages/http/src/main.ts",
    from: "  const tenants = administratorLogins().includes(actor)",
    to: "  const tenants = [] as string[] || administratorLogins().includes(actor)",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["visible to the administrator"],
  },
  {
    id: "a-move-looks-the-group-up-in-the-wrong-tenant",
    defect:
      "The existence check for the group being moved into stopped naming a tenant. `(tenant, group_id)` is the key, so a group of that name in *another* tenant satisfied the check \u2014 and the move then wrote a membership row into a tenant whose group list does not contain the group.",
    file: "packages/http/src/main.ts",
    from: "  if (!groupsStore.listGroups(db, tenant).some((g) => g.group_id === groupId)) {",
    to: "  if (!groupsStore.listGroups(db).some((g) => g.group_id === groupId)) {",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["404s in another"],
  },
  {
    id: "a-move-lands-in-the-default-tenant",
    defect:
      "The move itself stopped carrying the tenant. `moveTo` defaults to `default`, so an operator moving an identity into a group of another tenant is answered `200` naming that group, and the membership row lands somewhere the group does not exist.",
    file: "packages/http/src/main.ts",
    from: "  groupsStore.moveTo(db, { tenant, identity, groupId, movedBy: actor })",
    to: "  groupsStore.moveTo(db, { identity, groupId, movedBy: actor })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["404s in another"],
  },
  {
    id: "egress-is-granted-in-the-default-tenant",
    defect:
      "The egress grant stopped carrying the tenant, so a rule written for one tenant's groups landed in `default` \u2014 where the same two group names are two different groups. The route answers `201` and the send it was meant to allow is still refused.",
    file: "packages/http/src/main.ts",
    from: "  groupsStore.allowEgress(db_(), { tenant, fromGroup: c.req.param('group_id'), toGroup, grantedBy: actor })",
    to: "  groupsStore.allowEgress(db_(), { fromGroup: c.req.param('group_id'), toGroup, grantedBy: actor })",
    suite: "packages/http/src/groups-routes.test.ts",
    expect: ["granted and withdrawn inside one tenant"],
  },
  {
    id: "the-agent-list-says-everybody-is-in-the-default-tenant",
    defect:
      "`GET /api/v1/agents` answered a constant for `tenant`. A screen choosing agents for a group then has the group's tenant and a list with nothing to join it on, which is the state that made it offer agents belonging to somebody else.",
    file: "packages/http/src/main.ts",
    from: "    tenant: tenantOfIdentity.get(entry.id) ?? tenantsStore.DEFAULT_TENANT,",
    to: "    tenant: tenantsStore.DEFAULT_TENANT,",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["says which tenant each agent is in"],
  },
  {
    id: "the-agent-list-ignores-the-tenant-it-was-asked-for",
    defect:
      "The `?tenant=` filter stopped narrowing. The caller asked for one tenant's agents and was handed every agent it may see \u2014 a superset answered to a narrowing question, which reads as \u201cthat tenant has all of these\u201d.",
    file: "packages/http/src/main.ts",
    from: "      (tenantOfIdentity.get(entry.id) ?? tenantsStore.DEFAULT_TENANT) === wanted,",
    to: "      true,",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["narrows to one tenant when asked"],
  },
  {
    id: "a-rename-moves-the-login-and-leaves-the-grants",
    defect:
      "The rename stopped carrying the mesh-side rows. The account signs in under its new name holding none of its grants, owning none of its agents and in no group \u2014 every screen answering 403 with nothing anywhere saying why, which is the failure a rename of an *address* is.",
    file: "packages/http/src/rename-account.ts",
    from: "    mesh.transaction(() => {\n      for (const [table, column] of MESH_REFERENCES) move(mesh, table, column)\n    })()",
    to: "    void MESH_REFERENCES",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["moves the login, the registry row, and the grants"],
  },
  {
    id: "a-rename-takes-a-name-somebody-is-already-using",
    defect:
      "The taken-name check went away. Two accounts answer to one name \u2014 or an account takes the name of a registry row a message is addressed to \u2014 which is the state this module exists to avoid creating, and the one it cannot undo.",
    file: "packages/http/src/rename-account.ts",
    from: "      if (present(handle, table, column, from)) {\n        return { ok: false, reason: 'name_taken', blocked_by: `${table}.${column}` }",
    to: "      if (present(handle, table, column, from) && table !== 'local_users') {\n        return { ok: false, reason: 'name_taken', blocked_by: `${table}.${column}` }",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["refuses a name nobody has, and a name somebody does"],
  },
  {
    id: "the-seed-rename-touches-an-ordinary-account-called-admin",
    defect:
      "The rename stopped asking whether the `admin` it found is the seeded administrator. An account somebody was admitted under that name is renamed out from under them at the next restart, and their login stops working with a log line about a migration they were never part of.",
    file: "packages/http/src/main.ts",
    from: "  if (!legacy || legacy.role !== 'admin') return",
    to: "  if (!legacy) return",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["leaves an ordinary account called `admin` where it is"],
  },
  {
    id: "the-message-history-is-rewritten-by-a-rename",
    defect:
      "The rename reached into `messages`. What happened is that the old name sent that message, and rewriting the record makes it say something nobody did \u2014 in the one place on this server whose value is that nobody edited it afterwards.",
    file: "packages/http/src/rename-account.ts",
    from: "  ['agent_registry', 'id'],",
    to: "  ['agent_registry', 'id'],\n  ['messages', 'from_agent'],",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["leaves the message history under the name that sent it"],
  },
  {
    id: "the-backfill-admits-every-identity-the-hub-knows",
    defect:
      "The backfill stopped asking whether a key was approved and admitted whatever the mesh had a row for. That is the thing D-747 refused to decide by fiat \u2014 a route that admits any hub identity has to say whose registry it is adding to \u2014 and it arrives here as a silent widening of somebody else's decision.",
    file: "packages/http/src/keys-admin.ts",
    from: "      `SELECT DISTINCT identity FROM agent_keys WHERE status = 'approved' ORDER BY identity`,",
    to: "      `SELECT identity FROM agents ORDER BY identity`,",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["leaves an identity nobody has decided about where it is"],
  },
  {
    id: "the-backfill-undoes-a-teardown",
    defect:
      "The backfill stopped reading `deleted_at`, so an identity an operator tore down under \u00a7 9.3 is put back on the list by the next restart \u2014 a removal that works until the process restarts is the class of control this repository keeps finding behind its own screens.",
    file: "packages/http/src/keys-admin.ts",
    from: "    .prepare(`SELECT description, type FROM agents WHERE identity = ? AND deleted_at IS NULL`)",
    to: "    .prepare(`SELECT description, type FROM agents WHERE identity = ?`)",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["does not bring back an identity that was torn down"],
  },
  {
    id: "the-backfill-re-admits-on-every-boot",
    defect:
      "The backfill stopped skipping identities already on the list, so it reports work on every boot. The log line then appears whether or not anything changed, which is the line an operator learns to skip \u2014 and the one time it means something is the time it is skipped.",
    file: "packages/http/src/keys-admin.ts",
    from: "    if (isRegistryAgentApproved(identity)) continue",
    to: "    if (false) continue",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["is quiet on the next boot"],
  },
  {
    id: "a-rename-writes-into-a-name-that-is-taken",
    defect:
      "The collision check went away, so the rename ran its `UPDATE`s into a name another row already holds. `agents.identity` is a primary key: it throws `UNIQUE constraint failed` from inside `startup`, and the http service does not come up at all \u2014 which is how this reached a running deployment (reported as a P0 by agent-mesh-local-pm).",
    file: "packages/http/src/rename-account.ts",
    from: "      if (present(handle, table, column, from)) {",
    to: "      if (false) {",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["refuses when both names hold a mesh identity"],
  },
  {
    id: "a-half-finished-rename-is-read-as-a-clash",
    defect:
      "A table the new name already holds and the old one does not was treated as a collision. The two databases cannot share a transaction, so that state is this rename half applied \u2014 refusing strands the deployment on a boot that can never finish what an earlier boot began.",
    file: "packages/http/src/rename-account.ts",
    from: "      if (!present(handle, table, column, to)) continue",
    to: "      if (!present(handle, table, column, to)) continue\n      return { ok: false, reason: 'name_taken', blocked_by: `${table}.${column}` }",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["finishes a rename an earlier boot left half done"],
  },
  {
    id: "a-failed-rename-takes-the-server-down",
    defect:
      "The rename threw out of `startup` again. A migration that cannot run is an account keeping its old name; a migration that takes the service down is every screen and every agent, and it is the failure this whole guard was added for.",
    file: "packages/http/src/main.ts",
    from: "  } catch (err) {\n    log.error(\n      `could not rename '${LEGACY_SEED_ADMIN_USERNAME}'; it keeps its name and the server is starting`,",
    to: "  } catch (err) {\n    throw err\n    log.error(\n      `could not rename '${LEGACY_SEED_ADMIN_USERNAME}'; it keeps its name and the server is starting`,",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["comes up anyway when the rename cannot run"],
  },
  {
    id: "a-refused-write-is-reported-as-a-rename",
    defect:
      "The `catch` around the writes started answering `ok`. A rename the database refused is then logged as one that happened \u2014 `moved` names tables nothing moved in \u2014 and the operator is told to sign in under a name that does not exist.",
    file: "packages/http/src/rename-account.ts",
    from: "    return { ok: false, reason: 'write_failed' }",
    to: "    return { ok: true, moved }",
    suite: "packages/http/src/rename-account.test.ts",
    expect: ["answers write_failed rather than throwing"],
  },
  {
    id: "only-github-admins-are-protected",
    defect:
      "The protected set stopped reading `local_users`. The seeded administrator is a local account and is the one this exists for, so the single row that must be locked is the one left open while every GitHub-admin case still passes.",
    file: "packages/http/src/main.ts",
    from: "  return [...new Set([...admins, ...local].map(r => r.github_login))].sort()",
    to: "  return [...new Set(admins.map(r => r.github_login))].sort()",
    suite: "packages/http/src/grants-writes.test.ts",
    expect: ["counts the local seeded administrator too"],
  },
  {
    id: "approval-is-not-admission",
    defect:
      "Approving a key stopped admitting the identity, which is the state the P1 was reported in. The operator compares a fingerprint, approves it, and the console still does not list the agent \u2014 and `POST /api/v1/messages` still answers `404` for it, so the identity is on the mesh, connected, holding an approved key, and unreachable from here.",
    file: "packages/http/src/keys-admin.ts",
    from: "        admit(row.identity, db)",
    to: "        void row.identity",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["puts the identity on this server's list"],
  },
  {
    id: "denying-a-key-admits-the-identity",
    defect:
      "A denial admitted too. The one decision that says *not ours* would put the identity on the list of identities this console deals with, and an operator refusing a key would be adding its owner to the registry by doing so.",
    file: "packages/http/src/keys-admin.ts",
    from: "        row = keys.denyKey(db, fingerprint, actor, reason)\n        break",
    to: "        row = keys.denyKey(db, fingerprint, actor, reason)\n        admit(row.identity, db)\n        break",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["denying one does not"],
  },
  {
    id: "a-torn-down-identity-is-admitted-again",
    defect:
      "Admission stopped honouring the soft delete. \u00a7 9.3's teardown is a `deleted_at` stamp, so approving a key that was pending when the identity was destroyed puts a destroyed name back on the one screen an operator would check to confirm it was destroyed.",
    file: "packages/http/src/keys-admin.ts",
    from: "    .prepare(`SELECT description, type FROM agents WHERE identity = ? AND deleted_at IS NULL`)",
    to: "    .prepare(`SELECT description, type FROM agents WHERE identity = ?`)",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["torn-down identity is not admitted"],
  },
  {
    id: "re-approval-overwrites-what-an-operator-wrote",
    defect:
      "A second approval rewrote the registry row. A rotated key then resets a name and description an operator has since edited \u2014 the console forgetting somebody's work as a side effect of a routine key rotation, with nothing anywhere saying it happened.",
    file: "packages/http/src/db.ts",
    from: "    VALUES (?, ?, ?, 'native', ?, 1)\n    ON CONFLICT(id) DO UPDATE SET approved = 1, updated_at = CURRENT_TIMESTAMP",
    to: "    VALUES (?, ?, ?, 'native', ?, 1)\n    ON CONFLICT(id) DO UPDATE SET approved = 1, name = excluded.name, description = excluded.description, updated_at = CURRENT_TIMESTAMP",
    suite: "packages/http/src/registry-source.test.ts",
    expect: ["leaves the row an operator has edited alone"],
  },
  {
    id: "held-table-parser-stopped-matching",
    swept: true,
    defect:
      "The row parser stopped matching, and every check in this file went vacuous \u2014 no rows means no stale anchors, no untracked files and nothing to disagree with. A guard that reads its own subject fails open, and the floor that used to notice was a number somebody had to lower each time the table shrank.",
    file: "test/held-uncovered.test.ts",
    from: '  .filter((line) => line.startsWith("| `"))',
    to: '  .filter((line) => line.startsWith("| ``"))',
    suite: "test/held-uncovered.test.ts",
    expect: ["the table is still a table"],
  },
  {
    id: "held-table-anchor-stale",
    swept: true,
    defect:
      "A document naming code is a copy of it. A row whose anchor has been renamed or deleted still reads as a decision somebody made about the code that is there now — which is worse than no document, because the reason is stated with confidence and points at nothing.",
    file: "docs/decisions/what-the-coverage-number-leaves-out.md",
    from: "| `packages/http/src/main.ts` | `webpush.sendNotification(` |",
    to: "| `packages/http/src/main.ts` | `webpush.deliverNotification(` |",
    suite: "test/held-uncovered.test.ts",
    expect: ["every anchor is still in the file it names"],
  },
  {
    id: "held-table-file-moved",
    swept: true,
    defect:
      "The other way a row goes stale: the file moves. A path nothing tracks cannot be checked at all, so the row silently stops being about this repository.",
    file: "docs/decisions/what-the-coverage-number-leaves-out.md",
    from: "| `packages/http/src/main.ts` | `webpush.setVapidDetails(` |",
    to: "| `packages/http/src/where-it-used-to-be.ts` | `webpush.setVapidDetails(` |",
    suite: "test/held-uncovered.test.ts",
    expect: ["every row names a tracked file"],
  },
  {
    id: "held-table-reason-dropped",
    swept: true,
    defect:
      "A row that says where and not why survives every other check and tells the next reader nothing. The failure this table was written against is not an uncovered line — it is an unexplained one.",
    file: "docs/decisions/what-the-coverage-number-leaves-out.md",
    from:
      "| `scripts/lint-preview.ts` | `if (import.meta.main) {` | The CLI block. Its checks are cases in `test/preview-lint.test.ts`; this is the printing. |",
    to: "| `scripts/lint-preview.ts` | `if (import.meta.main) {` | CLI. |",
    suite: "test/held-uncovered.test.ts",
    expect: ["every row says why, rather than only where"],
  },
  {
    id: "boundary-deep-import",
    swept: true,
    defect:
      "A cross-package import that reaches past the barrel takes away the importee's freedom to move its own files, and does it silently — both halves still compile, and the specifier reads like any other relative path.",
    file: "packages/hub/src/db.ts",
    from: 'from "@agent-mesh/store";',
    to: 'from "../../store/src/index";',
    suite: "test/import-graph.test.ts",
    expect: ["no file reaches into another package by relative path"],
  },
  {
    id: "boundary-new-pair",
    swept: true,
    defect:
      "A dependency added between two packages that had none. The table of pairs is the invariant: four at run time and one in a test, each with a reason written beside it, so a fifth arriving quietly is the thing this guard exists to refuse.",
    file: "packages/store/src/index.ts",
    from: 'export * from "./open";',
    to: 'export * from "./open";\nexport * from "@agent-mesh/mailbox";',
    suite: "test/import-graph.test.ts",
    expect: ["has exactly these package pairs, four of them at run time"],
  },
  {
    id: "boundary-cycle",
    swept: true,
    defect:
      "A cycle is not a compile error in bun or in a bundler. It is a module half-initialised at run time, and which half is missing depends on which file was imported first — so it moves when an unrelated import is added, which is the worst property a defect can have.",
    file: "packages/store/src/teardown.ts",
    from: 'import { randomUUID } from "node:crypto";',
    to: 'import { randomUUID } from "node:crypto";\nimport "./index";',
    suite: "test/import-graph.test.ts",
    expect: ["has no import cycle anywhere in it"],
  },
  {
    id: "boundary-outside-consumer",
    swept: true,
    defect:
      "`test/` drives the services as processes rather than importing them, which is what keeps the number of consumers outside `packages/` at one. A script or a suite that imports a package instead links this repository's tooling to its internals.",
    file: "scripts/coverage.ts",
    from: 'import { spawnSync } from "node:child_process";',
    to: 'import { spawnSync } from "node:child_process";\nimport "@agent-mesh/hub";',
    suite: "test/import-graph.test.ts",
    expect: ["one consumer outside the packages, and it uses the front door"],
  },

  // ── T-022: the log line is the artifact, so it is pinned like one ────────
  {
    id: "a-level-the-caller-supplied-wins",
    defect:
      "The four canonical fields went back to being spread over by `fields`. A caller with its own `level` then set the JSON's level while the method still chose the stream, so one line said `info` in the head and `error` in the tail \u2014 and a filter and a reader disagreed about the same event.",
    file: "packages/log/src/index.ts",
    from: "    const payload: LoggedEvent = { ts: now(), level, component, event, ...rest };",
    to: "    const payload: LoggedEvent = { ts: now(), level, component, event, ...fields };",
    suite: "packages/log/src/index.test.ts",
    expect: ["a caller-supplied level field cannot override the method"],
  },
  {
    id: "warn-goes-where-nobody-looks",
    defect:
      "Every level went to stdout. `journalctl -p err` then answers nothing, and *is anything wrong* stops being a question one stream can answer \u2014 which is the only reason the split costs an ordering guarantee between the two.",
    file: "packages/log/src/index.ts",
    from: "    if (level === \"info\") sink.out(line);\n    else sink.err(line);",
    to: "    sink.out(line);",
    suite: "packages/log/src/index.test.ts",
    expect: ["error and warn go to stderr, info to stdout"],
  },
  {
    id: "a-reason-from-a-request-keys-the-counter",
    defect:
      "The bound on `reason` stopped applying, so a string assembled from a request or lifted from a database error became a counter key. The map then grows at a rate the caller chooses \u2014 a memory leak whose size is decided by traffic, in the one structure that exists to be read while everything else is failing.",
    file: "packages/log/src/index.ts",
    from: "        : typeof stated === \"string\" && BOUNDED_REASON.test(stated)",
    to: "        : typeof stated === \"string\"",
    suite: "packages/log/src/index.test.ts",
    expect: ["many distinct unbounded reasons make one key"],
  },
  {
    id: "counters-arrive-without-their-clock",
    defect:
      "The snapshot at boot went away, so the first one an operator sees is fifteen minutes in and every counter on it is already non-zero. The zero beside `COUNTING_SINCE` is what makes a later zero readable as *this ran and found nothing* rather than *this started a minute ago*.",
    file: "packages/log/src/index.ts",
    from: "  emit();\n  const timer = setTimer(emit, intervalMs);",
    to: "  const timer = setTimer(emit, intervalMs);",
    suite: "packages/log/src/index.test.ts",
    expect: ["stamps the zero at boot next to the time counting began"],
  },
  {
    id: "a-recovered-log-goes-unmentioned",
    defect:
      "Opening a store that carries an unfolded write-ahead log stopped saying so. A service killed mid-write and one shut down cleanly then produce the same quiet boot, and *every shutdown was clean* is what a reader takes from silence.",
    file: "packages/store/src/open.ts",
    from: "    const carried = walBytes(path);",
    to: "    const carried = 0;",
    suite: "packages/store/src/wal-recovery.test.ts",
    expect: ["says so, with how much is waiting"],
  },
  {
    id: "a-lapsed-lease-is-handed-back-in-silence",
    defect:
      "The mailbox's only redelivery stopped being reported. A caller whose turn ended before it could persist a batch and a caller stuck in a crash loop are the same rows, and without the line they are also the same log.",
    file: "packages/mailbox/src/receive.ts",
    from: "    if (relet.length > 0) {",
    to: "    if (false) {",
    suite: "packages/mailbox/src/receive.test.ts",
    expect: ["is handed back with a line naming who and how many"],
  },
  {
    id: "a-first-delivery-counts-as-a-redelivery",
    defect:
      "The filter on `leased_until` went away, so every message in a batch was counted as a second offer. A queue doing exactly what it should then reports a redelivery per message \u2014 and the counter that exists to find a crash loop is the one thing that would say there is one.",
    file: "packages/mailbox/src/receive.ts",
    from: "    const relet = page.filter((m) => m.leased_until !== null && m.leased_until !== undefined);",
    to: "    const relet = page;",
    suite: "packages/mailbox/src/receive.test.ts",
    expect: ["counts the re-offered ones only, in a batch that mixes both"],
  },
  {
    id: "a-request-id-is-believed-as-sent",
    defect:
      "The bound on `x-request-id` stopped applying, so whatever a caller sends is written into the record an operator reads \u2014 a kilobyte, a newline, a forged line of its own. The field exists to help somebody read a log and would have become the way to make one unreadable.",
    file: "packages/http/src/main.ts",
    from: "  const requestId = REQUEST_ID.test(offered) ? offered : randomUUID()",
    to: "  const requestId = offered || randomUUID()",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["replaces a value that does not belong in a log line, rather than refusing"],
  },
  {
    id: "the-request-id-reaches-nothing",
    defect:
      "The id was echoed to the caller and never put on a line. A person then holds a reference that appears nowhere in the record \u2014 which is worse than having none, because both sides believe the correlation exists.",
    file: "packages/http/src/main.ts",
    from: "  await withFields({ request_id: requestId }, () => next())",
    to: "  await next()",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["reaches the lines the request writes"],
  },
  {
    id: "the-surroundings-overrule-the-call-site",
    defect:
      "Ambient fields went back over the caller's. A handler naming the identity it refused would then have it replaced by whatever the request scope carried, and the line would describe the wrong subject with complete confidence.",
    file: "packages/log/src/index.ts",
    from: "    const merged: EventFields = { ...ambient.getStore(), ...fields };",
    to: "    const merged: EventFields = { ...fields, ...ambient.getStore() };",
    suite: "packages/log/src/index.test.ts",
    expect: ["lose to an explicit field at the call site"],
  },
  {
    id: "a-refused-sign-in-says-nothing",
    defect:
      "A refused sign-in went back to writing nothing, so \"I cannot sign in\" is answerable only by asking the person to try again while somebody watches. Three different repairs \u2014 wrong shape, wrong password, an account that must change its password first \u2014 and from outside one sentence.",
    file: "packages/http/src/main.ts",
    from: "    refusedSignIn(username, 'bad_credentials')",
    to: "",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a wrong password is another, and names who tried"],
  },
  {
    id: "an-unauthenticated-name-writes-its-own-line",
    defect:
      "The name from a sign-in attempt stopped being truncated and went into the sentence, where nothing escapes it. A caller then puts a newline and a plausible-looking line in its own username and writes whatever it likes into the record an operator reads.",
    file: "packages/http/src/main.ts",
    from: "  log.warn('refused a sign-in', 'sign_in_refused', {\n    actor: typeof username === 'string' ? username.slice(0, 128) : '<absent>',",
    to: "  log.warn(`refused a sign-in for ${String(username)}`, 'sign_in_refused', {\n    actor: String(username),",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a name from an unauthenticated request cannot write its own line"],
  },
  {
    id: "a-notification-nobody-got-has-no-reason",
    defect:
      "The three early exits from the push path went quiet again. `no VAPID keys`, `already watching` and `no device registered` are three different repairs, and without a line they are indistinguishable from the push that was attempted and failed \u2014 which is a fourth.",
    file: "packages/http/src/push.ts",
    from: "  if (!deps.configured) {\n    log.info(\"no notification sent: this deployment holds no push keys\", \"push_skipped\", {",
    to: "  if (!deps.configured) {\n    void ((..._unused: unknown[]) => {})(\"\", \"\", {",
    suite: "packages/http/src/push.test.ts",
    expect: ["a deployment with no push keys says so"],
  },
  {
    id: "an-event-the-document-names-is-renamed",
    defect:
      "An event was renamed and `docs/LOGGING-OPS.md` still tells an operator to grep for the old name. They grep, find nothing, and read it as nothing having gone wrong \u2014 which is the failure the whole of T-022 is about, arriving through the document instead of through the code.",
    file: "packages/store/src/open.ts",
    from: '"wal_recovered"',
    to: '"wal_log_replayed"',
    suite: "test/logging-ops.test.ts",
    expect: ["every event it tells an operator to grep for is one a service emits"],
  },
  {
    id: "the-document-quotes-a-bound-nothing-applies",
    defect:
      "The bound on `reason` changed and the document went on quoting the old pattern. Somebody adding a line then writes a token the document says is fine and the counter files it as `other`, which is the one thing a counter must not do quietly.",
    file: "packages/log/src/index.ts",
    from: "const BOUNDED_REASON = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;",
    to: "const BOUNDED_REASON = /^[a-z0-9][a-z0-9_.:-]{0,31}$/;",
    suite: "test/logging-ops.test.ts",
    expect: ["the bound it quotes for a reason is the bound the logger applies"],
  },
  {
    id: "a-package-the-architecture-does-not-name",
    defect:
      "The architecture document's package tree went back to naming fewer packages than there are. It named four for as long as there were seven \u2014 `mailbox`, `platform-web` and `log` each arrived without it moving \u2014 and a document listing four packages reads exactly like a repository with four.",
    file: "docs/architecture.md",
    from: "\u251c\u2500\u2500 log/              one log line shape, and the counter that shadows it\n",
    to: "",
    suite: "test/import-graph.test.ts",
    expect: ["the architecture document names every package there is"],
  },
  {
    id: "a-queued-message-does-not-say-why",
    defect:
      "The reason a message was queued stopped being named, so *waiting for somebody who is not connected* and *this service could not hand it over* answer the same complaint with the same line. The \u00a7 3 drill exists to be run by somebody who was not here, and a drill that passes on a log that names no cause is a rehearsal of nothing.",
    file: "packages/hub/src/rpc/send.ts",
    from: '      reason: "recipient_offline",',
    to: "",
    suite: "test/logging-drills.test.ts",
    expect: ["names the recipient being offline, and does not say that when they are not"],
  },
  {
    id: "the-build-table-summary-drifts",
    defect:
      "A row in SPEC's 0.2 table flipped to built and the paragraph above it went on stating the old count. That is exactly how the paragraph came to say \"most are not implemented\" while thirteen of fifteen rows said **yes** \u2014 each change made the sentence more wrong, and a reader skimming takes the sentence.",
    file: "SPEC.md",
    from: "| 4.1 | A Claude lane includes a runtime-adapter | no |",
    to: "| 4.1 | A Claude lane includes a runtime-adapter | **yes** |",
    suite: "test/versioning.test.ts",
    expect: ["the paragraph's count is the table's count"],
  },
  {
    id: "a-heading-written-twice",
    defect:
      "Two identical headings in one section, which is how a section gets added to the wrong copy: the next person appends under the first, and their paragraph is invisible to anyone who scrolled to where the list actually is. `docs/proposals/README.md` carried `### Still undecided` twice, one line apart.",
    file: "docs/proposals/README.md",
    from: "### Still undecided\n\n- **Whether `ASN` replaces `prefix`**",
    to: "### Still undecided\n\n### Still undecided\n\n- **Whether `ASN` replaces `prefix`**",
    suite: "test/readme.test.ts",
    expect: ["every heading in docs/ and the root documents is unique within its file"],
  },
  {
    id: "the-proposals-index-contradicts-itself",
    defect:
      "The introduction went back to saying the set is unimplemented while the *Built* section thirty lines down lists where each part of it landed. A reader who stops at the first paragraph \u2014 which is the one they reach first \u2014 gets the opposite of the answer.",
    file: "docs/proposals/README.md",
    from: "arrived. **Every decision they settled is built**",
    to: "arrived. **Nothing in them is implemented.** They are settled contracts",
    suite: "test/readme.test.ts",
    expect: ["the introduction does not say the opposite of it"],
  },
  {
    id: "the-poller-anchor-stands-still",
    defect:
      "The audit poller stopped moving its anchor with the rows it read, so every pass broadcasts the same batch again. On an audit screen that is the mesh appearing to repeat itself for ever, at 1.5-second intervals, with nothing wrong in any store.",
    file: "packages/http/src/main.ts",
    from: "      lastSeenMessageTs = r.ts\n      lastSeenMessageId = r.id",
    to: "",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["picks up what arrived after it, counts it, and does not pick it up twice"],
  },
  {
    id: "a-poller-that-cannot-read-says-nothing",
    defect:
      "A pass against a store that will not answer went back to failing silently. The poller is the only thing that puts other agents' conversations on the audit screen, so a store it cannot read is a screen that quietly stops updating \u2014 which looks exactly like a mesh with nothing happening on it.",
    file: "packages/http/src/main.ts",
    from: "    log.error('the audit poller failed a pass, and will try again', 'audit_poller_failed', {",
    to: "    void ((..._unused: unknown[]) => {})('', '', {",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a pass against a store that will not answer says so and comes back"],
  },
  {
    id: "an-empty-store-anchors-on-nothing",
    defect:
      "A hub store with no messages stopped setting the epoch anchor, leaving `lastSeenMessageTs` null \u2014 so the first pass compares against null, matches nothing, and the poller never reads a row again on a deployment that started empty.",
    file: "packages/http/src/main.ts",
    from: "      lastSeenMessageTs = '1970-01-01 00:00:00'\n      lastSeenMessageId = ''\n    }\n    log.info('the audit poller has its starting point'",
    to: "      lastSeenMessageTs = null\n      lastSeenMessageId = null\n    }\n    log.info('the audit poller has its starting point'",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["an empty store is the epoch, and it says which row it starts after"],
  },
  {
    id: "the-watermark-is-off-by-one",
    defect:
      "The stream watermark started warning *at* fifty rather than past it. A threshold that fires on the boundary it names is one an operator stops reading, and this one exists to be noticed exactly once.",
    file: "packages/http/src/main.ts",
    from: "  if (clients <= SSE_CLIENT_WATERMARK) return",
    to: "  if (clients < SSE_CLIENT_WATERMARK) return",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["says nothing at the watermark"],
  },
  {
    id: "a-keepalive-that-outlives-its-stream",
    defect:
      "The keepalive stopped clearing itself when the write throws, so a timer whose stream is gone writes into a dead controller every twenty seconds for the life of the process \u2014 one per stream anybody ever opened. This rule was written three times before it was written once, and each copy had to remember it.",
    file: "packages/http/src/main.ts",
    from: "    } catch {\n      clearTimer(timer)\n    }",
    to: "    } catch {\n      // nothing\n    }",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a write that throws is the stream ending, and the timer goes quietly"],
  },
  {
    id: "one-persons-open-tab-silences-another",
    defect:
      "The colon left the suffix match, so a name ending in somebody else's matches it \u2014 `joakim` reading a conversation makes `kim` count as watching, and `kim`'s phone stays quiet for a message they never saw. The keys are `agent:person`, and the colon is what makes the suffix a whole name.",
    file: "packages/http/src/main.ts",
    from: "    if (key.endsWith(`:${toUser}`) && set.size > 0) return true",
    to: "    if (key.endsWith(toUser) && set.size > 0) return true",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a name that ends in theirs is not them"],
  },
  {
    id: "an-approval-nobody-was-told-about",
    defect:
      "The admin notification went back to reporting only a thrown send. `sendViaHub` does not throw \u2014 it resolves `null` when the hub socket is down, which is the likeliest way this fails \u2014 so an approval nobody was told about reads exactly like one that was, and the person waits until an operator happens to open the pending list.",
    file: "packages/http/src/main.ts",
    from: "      failed('hub_did_not_accept')",
    to: "",
    suite: "packages/http/src/main.in-process.test.ts",
    expect: ["a send the hub never took is a failure, not a silence"],
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

/**
 * **Everything below runs only when this file is the program.**
 *
 * The manifest above is data, and a check that wants to ask "is one of these
 * mutants sitting in the tree right now" has to be able to import it. Without
 * this guard importing meant *running the sweep* — which edits files — and the
 * unknown-flag refusal a few lines down would have read bun's own test
 * arguments and exited the whole run.
 *
 * The failure this makes checkable is written two comments below, in this
 * file, about this file: a run that dies mid-sweep leaves its mutant in the
 * working tree, and it has happened here — "남은 것이 하필 보안 줄이었다".
 */
if (import.meta.main) {
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
// **모르는 플래그는 거절한다.**
//
// `filter` 가 `--` 로 시작하는 인자를 그냥 버려서, 오타나 **아직 안 올라온 플래그**는
// 조용히 *필터 없음* 이 되고 그러면 **231개 전수 실행**이 된다. platform 이 그 자리를 밟았다:
// `--anchors` 를 알렸는데 그 커밋이 아직 origin 에 없었고, 그쪽 판에서는 모르는 인자라
// 전수 실행이 됐다가 2분 타임아웃에 죽으면서 **감사 가림을 끈 뮤테이션이 트리에 남았다.**
// 남은 것이 하필 보안 줄이었다.
//
// 알리기 전에 안 민 것이 원인이고, 이 거절은 그 종류가 다시 안 나게 하는 자리다.
const KNOWN_FLAGS = new Set(["--self-check", "--anchors", "--repeat"]);
const unknownFlag = argv.find((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
if (unknownFlag) {
  console.error(`unknown flag ${unknownFlag} — refusing rather than running the whole manifest`);
  console.error(`known: ${[...KNOWN_FLAGS].join(" ")}`);
  process.exit(2);
}
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

// **`--anchors`: does every entry still point at something?**
//
// An entry whose `from` no longer appears is a check that has quietly stopped
// existing. The tool already says so — but only for the entry somebody ran, and
// a full pass is one suite per entry, which is hours. This reads the manifest
// against the tree and answers in a second.
//
// It lives here rather than in a script beside it because the manifest is the
// data: agent-mesh-local-pm wrote an outside scanner first and it misread the
// entries whose `from` spans lines, reporting live anchors as dead. A parser of
// somebody else's syntax is a second thing to be wrong about.
//
// Two failures, not one. An anchor matching **twice** is worse than none:
// `String.replace` takes the first, so the mutation lands somewhere the entry
// did not name and the verdict is about a line nobody chose.
if (argv.includes("--anchors")) {
  const problems: string[] = [];
  // **`SELF_CHECK` is not this check's denominator**, so a real mutation parked
  // there is anchored by nothing and raises no count: `234/234` stayed `234/234`
  // while two live entries sat outside it. That is how a guard goes quiet rather
  // than loud. A self-check entry declares the failure it expects — by
  // definition — so one without `expectFailure` is an entry in the wrong array.
  for (const m of SELF_CHECK) {
    if (!m.expectFailure) {
      problems.push(`${m.id}: sits in SELF_CHECK without an \`expectFailure\` — it belongs in MUTATIONS, where anchors are checked`);
    }
  }
  for (const m of selected) {
    if (m.retired) continue;
    // `undefined` 로 본다 — **`to: ""` 는 삭제 뮤테이션**이고 정상이다.
    // 첫 판이 falsy 로 봐서 멀쩡한 엔트리 셋을 *from/to 없음* 으로 냈다.
    if (m.from === undefined || m.to === undefined) {
      problems.push(`${m.id}: no from/to and not marked retired — it would run as a no-op`);
      continue;
    }
    let text: string;
    try {
      text = await Bun.file(m.file).text();
    } catch {
      problems.push(`${m.id}: ${m.file} could not be read`);
      continue;
    }
    const hits = text.split(m.from!).length - 1;
    if (hits === 0) problems.push(`${m.id}: its \`from\` is not in ${m.file} — this entry checks nothing`);
    else if (hits > 1) problems.push(`${m.id}: its \`from\` appears ${hits} times in ${m.file} — replace takes the first`);
  }
  console.log(`${selected.length - problems.length}/${selected.length} anchors point at exactly one place`);
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(problems.length ? 1 : 0);
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
  // 은퇴한 엔트리는 심을 자리가 없다 — 근거만 남아 있다.
  if (m.retired) {
    console.log(`· ${m.id}: retired — ${m.retired}`);
    continue;
  }
  if (m.from === undefined || m.to === undefined) {
    console.error(`${markFor("inconclusive")} ${m.id}: no from/to and not retired`);
    process.exit(2);
  }
  const path = Bun.file(m.file);
  const src = await path.text();
  const occurrences = src.split(m.from).length - 1;
  if (occurrences === 0) {
    // Loud, and counted as a failure. A pattern that no longer matches runs the
    // unmutated source, which passes, which reads as the guard missing it.
    console.error(`${markFor("no-match")} ${m.id}: pattern no longer present in ${m.file} — this mutation checks nothing`);
    missed++;
    kinds.set(m.id, "no-match");
    continue;
  }
  if (occurrences > 1) {
    // **Worse than absent, and this was unmeasured until today.** Zero matches
    // was already a failure; more than one was silently the first, so the
    // verdict described a line the entry had not chosen — `capability-not-role`
    // named a guard that appears under two routes and measured whichever came
    // first in the file. `agent-mesh-local-pm` found it by counting anchors
    // across the manifest (mail #1265), which is a question this loop should
    // have been answering all along, since it is holding the source open.
    console.error(
      `${markFor("no-match")} ${m.id}: pattern appears ${occurrences} times in ${m.file} — the verdict would be about whichever came first, so anchor it to one place`,
    );
    missed++;
    kinds.set(m.id, "no-match");
    continue;
  }

  await Bun.write(m.file, src.replace(m.from!, m.to!));
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

}

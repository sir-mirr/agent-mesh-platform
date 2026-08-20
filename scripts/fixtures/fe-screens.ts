#!/usr/bin/env bun
/**
 * Data the operator screens need in order to be judged — in amounts a constant
 * cannot match.
 *
 * **Two screens cannot be measured on an empty mesh**, and that is not a defect
 * in either of them: `/creator/register` lists keys awaiting a decision and
 * `/creator/lease-queue` lists messages nobody has taken, so with neither
 * present they render the same thing whether the backend is reachable or not.
 * A front-end audit ran for half an hour against exactly that and reported
 * "cannot judge" both times, correctly.
 *
 * ## Why the counts are random, and why that is the point
 *
 * Seeding one pending key and one queued message makes the screens judgeable and
 * still leaves the cheapest possible lie undetected: a screen that renders `1`
 * from a constant passes. Every defect the PM found in the admin front end today
 * was of that shape — `139` sessions, `1024` MB, `99.99%`, a bell reading
 * "2 awaiting" forever. None of them failed a typecheck or a build, because a
 * constant is perfectly well-typed.
 *
 * So the counts here **change every run** and are written to a file:
 *
 *   fixture-pending-<run>-1..N   provisioned, deliberately NOT approved
 *   fixture-recipient-<run>      approved, never receives — M messages wait
 *
 * A screen showing the right number twice, across two runs, is reading the
 * backend. That is the only property here that survives somebody hardcoding the
 * fixture's own values, which is the failure this file would otherwise invite.
 *
 * **Compare the whole expectation, not one field.** Any single count can repeat
 * — the first two runs of this version both drew 6 pending keys, which a
 * hardcoded `6` would have matched twice. The ranges are wider now, but wider is
 * not proof: what makes a repeat implausible is that `run`, both identity names,
 * the pending total and the queue depth would all have to coincide at once.
 * A checker that asserts on `expect.queuedFor.exactly` alone has re-created, one
 * field down, the thing this file exists to catch.
 *
 * **`--emit` is what makes it a check rather than a demo.** It writes what the
 * screens must show, as JSON, so a harness compares against a file instead of
 * against a number a person copied out of a terminal an hour ago. Whoever
 * builds the front-end check — a unit test with a stubbed fetch, a driven
 * browser, anything — reads that file and needs no agreement with this one
 * beyond its shape.
 *
 *   bun run e2e:harness -- --ready-file /tmp/agent-mesh-fe-fixture.json --keep-state
 *   bun scripts/fixtures/fe-screens.ts --emit /tmp/agent-mesh-fe-expect.json
 *
 * Reads the ready file rather than taking ports: they are ephemeral, and a
 * fixture that hardcodes one is a fixture that works until somebody restarts
 * the harness.
 *
 * ## What this deliberately does not do
 *
 * It does not check any screen. Nothing here knows the front end exists, and
 * that is still the split, though not for the reason written here first: the
 * admin front end used to live in a clone whose branch had never been pushed,
 * and `packages/platform-web` is in this repository now. What survives the move
 * is the separation of concerns — this file produces data and states what the
 * screens must show; whoever checks a screen reads `--emit` and owns the
 * assertion.
 */

import { generateKeyPairSync, randomUUID, randomInt, sign as edSign } from "node:crypto";
import { keyFingerprint, requestSignaturePreimage } from "@agent-mesh/contracts";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(name);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};
const emitTo = flag("--emit");

/**
 * Where to seed.
 *
 * The path was written into this line, so the fixture reached exactly one
 * harness invocation: `e2e:harness` takes `--ready-file <path>` and this took
 * none, so the pair worked only on the default path.
 *
 * It stays a ready file rather than a pair of `--hub`/`--http` flags, which is
 * what I tried first. Seeding needs four things, not two — the admin handle to
 * approve nothing and log in, and the state directory to reach the database —
 * and a flag per field is four chances to pass a set that does not describe one
 * mesh. The file is written atomically by the thing that knows all four.
 *
 * To seed a mesh this script did not start — a standing dev stack — hand it a
 * file of the same shape. **Copy the login handle from what `e2e:harness`
 * writes, not from memory:** it is a form post whose session cookie rides a
 * `302`, and the JSON shape written here first answered `200` with HTML and no
 * cookie, which reached `agent-mesh-local-pm` as `null is not an object`
 * (mail #1143).
 *
 *   { "base_url": "http://127.0.0.1:3000", "api_http": "http://127.0.0.1:3100",
 *     "state_dir": "…/state",
 *     "admin_test_handle": {
 *       "login_url": "http://127.0.0.1:3000/auth/local",
 *       "method": "POST",
 *       "content_type": "application/x-www-form-urlencoded",
 *       "body": "username=admin&password=…",
 *       "login_expect_status": 302 } }
 *
 * A JSON body works too, but only with `accept: application/json` — without it
 * the route answers the browser flow, and the browser flow is a page.
 */
const readyFile = flag("--ready-file") ?? "/tmp/agent-mesh-fe-fixture.json";
const readyBlob = Bun.file(readyFile);
if (!(await readyBlob.exists())) {
  console.error(
    `no ready file at ${readyFile}.\n` +
      "Start one:  bun run e2e:harness -- --ready-file <path> --keep-state\n" +
      "or write one describing a mesh that is already up — base_url, api_http, state_dir, admin_test_handle.",
  );
  process.exit(2);
}
const ready = JSON.parse(await readyBlob.text());
const HUB = ready.api_http, HTTP = ready.base_url;

/**
 * A tag per run, so re-running against a `--keep-state` mesh adds a fresh set
 * rather than colliding on identities the last run already provisioned.
 */
const run = randomUUID().slice(0, 6);

/**
 * Ranges chosen to avoid the numbers a placeholder reaches for. Nothing renders
 * `7` or `11` by accident; `0`, `1`, `2`, `3`, `5`, `10`, `24` and `100` are all
 * plausible constants and are therefore all outside these.
 */
const PENDING = randomInt(6, 18);   // 6..17
const QUEUED = randomInt(11, 24);   // 11..23

const newKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  return { publicKey: raw, privateKey, fingerprint: keyFingerprint(raw) };
};

const h = ready.admin_test_handle;
const login = await fetch(h.login_url, {
  method: "POST",
  headers: { "content-type": h.content_type, ...(h.content_type?.includes("json") ? { accept: "application/json" } : {}) },
  body: h.body,
  redirect: "manual",
});
// **A 200 with no cookie is the failure this used to die on.** `!` on the header
// turned a hand-written ready file with the wrong content type into
// `null is not an object`, which says nothing about ready files. The route
// answers the browser flow when it is not asked for JSON, and the browser flow
// is a page.
const setCookie = login.headers.get("set-cookie");
if (!setCookie) {
  throw new Error(
    `admin login answered ${login.status} with no Set-Cookie, using the handle in ${readyFile} ` +
      `(content-type ${h.content_type}).\n` +
      (login.status === 401
        ? "401 is the password: the account exists and the credentials in that file do not match it."
        : "A redirect or a 200 carrying no cookie is the content type: `/auth/local` answers the browser flow — " +
          "a page — unless the request is a form post or accepts JSON. Copy the handle from what `e2e:harness` writes."),
  );
}
const cookie = setCookie.split(";")[0]!;

const provision = (identity: string, publicKey: string) =>
  fetch(`${HUB}/api/v1/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type: "ai-claude", public_key: publicKey }),
  });
const approve = (fingerprint: string) =>
  fetch(`${HTTP}/api/v1/admin/keys/approve`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fingerprint }),
  });

/** One signed `mesh.send` over the HTTP transport, as an agent rather than a person. */
const sendAs = async (
  signer: { privateKey: ReturnType<typeof newKey>["privateKey"]; fingerprint: string },
  params: Record<string, unknown>,
) => {
  const rawParams = JSON.stringify(params);
  const nonce = randomUUID(), iat = Math.floor(Date.now() / 1000);
  const value = Buffer.from(edSign(null, Buffer.from(requestSignaturePreimage({
    method: "mesh.send", kid: signer.fingerprint, nonce, iat,
    rawParams: new TextEncoder().encode(rawParams),
  })), signer.privateKey)).toString("base64url");
  const sig = JSON.stringify({ alg: "ed25519", kid: signer.fingerprint, nonce, iat, value });
  return fetch(`${HUB}/api/v1/rpc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: `{"jsonrpc":"2.0","id":1,"method":"mesh.send","params":${rawParams},"sig":${sig}}`,
  });
};

const senderId = `fixture-sender-${run}`, recipientId = `fixture-recipient-${run}`;

// Sender and recipient: approved, so one can sign and the other can be queued for.
const sender = newKey(), recipient = newKey();
await provision(senderId, sender.publicKey);
await approve(sender.fingerprint);
await provision(recipientId, recipient.publicKey);
await approve(recipient.fingerprint);
console.log(`approved     ${senderId}, ${recipientId}`);

// Proposals for /creator/register: provisioned and deliberately NOT approved.
// Approving any of them makes the screen shorter, which is why they are left
// alone and why that is stated here rather than discovered.
const pendingFingerprints: string[] = [];
for (let i = 1; i <= PENDING; i++) {
  const k = newKey();
  const res = await provision(`fixture-pending-${run}-${i}`, k.publicKey);
  if (res.status !== 201) throw new Error(`provision ${i} answered ${res.status}, not 201`);
  pendingFingerprints.push(k.fingerprint);
}
console.log(`left pending ${PENDING} keys`);

// Queued messages for /creator/lease-queue: sent, never received.
for (let i = 1; i <= QUEUED; i++) {
  const res = await sendAs(sender, { to: recipientId, content: `queued ${i} of ${QUEUED} (run ${run})` });
  if (res.status !== 200) throw new Error(`send ${i} answered ${res.status}, not 200`);
}
console.log(`queued       ${QUEUED} messages for ${recipientId}`);

// ---------------------------------------------------------------------------
// An account that can reach § 11.0's middle state.
//
// **The privacy boundary had no caller who could stand on it.** § 11.0 has
// three outcomes and only two were reachable: `admin` holds every capability
// so it sees content, and a stranger gets 401. The one the audit screen
// advertises in its own subtitle — *[content withheld] for a holder of
// `audit.read.metadata` and not `audit.read.content`* — could be produced by no
// account that existed.
//
// `agent-mesh-local-pm` found it by trying to walk the redaction path and
// discovering there was nobody to walk it as (mail #569). The code was all
// there: the route, the redaction, the `content_length` that survives it, and a
// screen that names the behaviour. Only the caller was missing, and a
// screen-level test cannot notice — the screen renders and the test passes.
//
// The username is the capability subject: `/auth/local` writes it into `users`
// as `github_login`, and `requireCapability` reads exactly that.
//
// Written to `local_users` directly because no route creates one. That is the
// single place this fixture reaches past the API, and it is marked rather than
// hidden — a fixture that quietly opens a database is one nobody can reason
// about.
// ---------------------------------------------------------------------------

const VIEWER = "audit-viewer";
const VIEWER_PASSWORD = "audit-viewer-password";
{
  // **Admission, not an INSERT.** This wrote `local_users` directly and then
  // proved itself with `/auth/me`, which answers for anyone signed in and says
  // nothing about approval. `seedLocalUsers` approves local accounts at boot, so
  // a row written while the server is up is never approved, `isUserApproved`
  // reads `agent_registry` and refuses, and every approval-gated screen this
  // viewer opens is empty. The harness had the identical bug in
  // `capabilityViewer`; `agent-mesh-local-pm` measured it there (mail #1104).
  const admitted = await fetch(`${HTTP}/api/v1/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ username: VIEWER, display_name: "Audit viewer", role: "member" }),
  });
  if (admitted.ok) {
    const { temporary_password: temporary } = (await admitted.json()) as { temporary_password: string };
    const first = await fetch(`${HTTP}/auth/local`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username: VIEWER, password: temporary }),
      redirect: "manual",
    });
    const firstCookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const changed = await fetch(`${HTTP}/auth/local/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: firstCookie },
      body: JSON.stringify({ current: temporary, next: VIEWER_PASSWORD }),
    });
    if (changed.status !== 200) throw new Error(`${VIEWER} could not leave the password gate: ${changed.status}`);
  } else if (admitted.status !== 409) {
    throw new Error(`admitting ${VIEWER} answered ${admitted.status}: ${await admitted.text()}`);
  }
}

// The grant goes through the route, because granting is a thing the product
// does and a fixture that wrote it straight to the table would not notice the
// route refusing.
const granted = await fetch(`${HTTP}/api/v1/admin/grants`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ subject: VIEWER, capability: "audit.read.metadata", scope: "*" }),
});
if (granted.status >= 400) throw new Error(`granting audit.read.metadata answered ${granted.status}`);

// **Logging in is the check.** A row in `local_users` is not an account until a
// session comes back — and a 302 is not a session, which is the reading that
// cost an hour tonight. The cookie is what says it worked.
const viewerLogin = await fetch(`${HTTP}/auth/local`, {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify({ username: VIEWER, password: VIEWER_PASSWORD }),
  redirect: "manual",
});
const viewerCookie = viewerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
if (!viewerCookie.startsWith("mesh_token=")) {
  throw new Error(`${VIEWER} could not sign in: ${viewerLogin.status}, no mesh_token`);
}
const viewerMe = await fetch(`${HTTP}/auth/me`, { headers: { cookie: viewerCookie } });
if (viewerMe.status !== 200) throw new Error(`${VIEWER} signed in but /auth/me answered ${viewerMe.status}`);

// **`/auth/me` is not the check.** It answers for anyone with a session and
// never consults approval, which is why the account above looked fine for as
// long as it was broken. Ask a route that gates on approval instead.
const viewerAgents = await fetch(`${HTTP}/api/v1/agents`, { headers: { cookie: viewerCookie } });
if (viewerAgents.status !== 200) {
  throw new Error(
    `${VIEWER} signed in but an approval-gated route answered ${viewerAgents.status}: ${await viewerAgents.text()}`,
  );
}
console.log(`seeded       ${VIEWER} (audit.read.metadata only) — /auth/me 200, /api/v1/agents 200`);

// ---------------------------------------------------------------------------
// Read the numbers back off the routes rather than trusting the loop above.
// A fixture that reports what it *intended* to create is the same class of
// thing it exists to catch.
// ---------------------------------------------------------------------------

const getJson = async (path: string) =>
  (await fetch(`${HTTP}${path}`, { headers: { cookie } })).json() as Promise<any>;

const pending = await getJson("/api/v1/admin/keys/pending");
const mailbox = await getJson("/api/v1/admin/mailbox");
const tenants = await getJson("/api/v1/admin/tenants");

const minePending = (pending.pending ?? []).filter((p: any) =>
  pendingFingerprints.includes(p.fingerprint ?? p.key_fingerprint),
).length;
const mineQueued = (mailbox.mailboxes ?? []).find((m: any) => (m.identity ?? m.agent) === recipientId);

if (minePending !== PENDING) {
  throw new Error(
    `provisioned ${PENDING} pending keys and /api/v1/admin/keys/pending accounts for ${minePending}. ` +
    `The fixture cannot certify a number it did not read back.`,
  );
}

const expectation = {
  run,
  generatedAt: new Date().toISOString(),
  identities: { sender: senderId, recipient: recipientId },
  /**
   * What a screen reading the backend must show. Absolute counts where the
   * fixture owns the whole number, and `atLeast` where a `--keep-state` mesh may
   * carry rows from an earlier run — a screen showing fewer than this is not
   * reading the backend, and one showing more may simply be older.
   */
  expect: {
    // The screen shows the total, not this run's share, so the total is what a
    // checker compares. `mine` is here to tell "the fixture did nothing" apart
    // from "the screen is stale" when the total looks wrong.
    pendingKeys: { atLeast: (pending.pending ?? []).length, mine: PENDING },
    queuedFor: { identity: recipientId, exactly: QUEUED },
    tenants: { atLeast: 1, includes: "default" },
  },
  // **What the routes said at emit time, and the only way to tell a stale file
  // from a wrong screen.** A consumer that compares these against the routes
  // *now* knows whether it is holding an expectation for a mesh that has since
  // been seeded again: same values, the file still describes this mesh; different
  // values, somebody re-ran the seeder and the right answer is "cannot judge"
  // rather than a failure.
  //
  // `agent-mesh-local-pm` reached for the file's age instead and marked a correct
  // screen FAIL — 1.8 minutes old, and the seeder had run inside those minutes
  // (mail #1149). Age is a proxy for staleness; these are staleness itself.
  observed: {
    pendingTotal: (pending.pending ?? []).length,
    queuedForRecipient: mineQueued?.pending ?? mineQueued?.depth ?? null,
    tenants: tenants.tenants ?? [],
  },
};

console.log("\n--- what the screens must show ---");
console.log(`  /creator/register    at least ${PENDING} awaiting  (total now ${expectation.observed.pendingTotal})`);
console.log(`  /creator/lease-queue ${QUEUED} for ${recipientId}  (route says ${expectation.observed.queuedForRecipient})`);
console.log(`  /platform/tenants    ${JSON.stringify(expectation.observed.tenants)}`);

if (emitTo) {
  await Bun.write(emitTo, JSON.stringify(expectation, null, 2) + "\n");
  console.log(`\nwrote ${emitTo}`);
  console.log("These numbers differ every run on purpose. A screen that matches");
  console.log("them twice, from two runs, is reading the backend; one that matches");
  console.log("once may be a constant that got lucky.");
} else {
  console.log("\n(no --emit: nothing written. A harness comparing against a number");
  console.log(" copied out of this terminal is comparing against a stale one.)");
}

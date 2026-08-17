#!/usr/bin/env bun
/**
 * Data the operator screens need in order to be judged.
 *
 * **Two screens cannot be measured on an empty mesh**, and that is not a defect
 * in either of them: `/creator/register` lists keys awaiting a decision and
 * `/creator/lease-queue` lists messages nobody has taken, so with neither
 * present they render the same thing whether the backend is reachable or not.
 * A front-end audit ran for half an hour against exactly that and reported
 * "cannot judge" both times, correctly.
 *
 * So the fixture is three identities and one message, arranged so each screen
 * has something only a working backend could show it:
 *
 *   fixture-sender      approved, so it can sign
 *   fixture-recipient   approved, and never receives — one message waits for it
 *   fixture-awaiting    provisioned and deliberately NOT approved
 *
 * **The last one is the whole of `/creator/register`.** Approving it makes the
 * screen empty again, which is why it is left alone and why that is stated here
 * rather than discovered.
 *
 *   bun run e2e:harness -- --ready-file /tmp/agent-mesh-fe-fixture.json --keep-state
 *   bun scripts/fixtures/fe-screens.ts
 *
 * Reads the ready file rather than taking ports: they are ephemeral, and a
 * fixture that hardcodes one is a fixture that works until somebody restarts
 * the harness.
 */

import { generateKeyPairSync, randomUUID, sign as edSign, createHash } from "node:crypto";
import { keyFingerprint, requestSignaturePreimage } from "@agent-mesh/contracts";

const ready = JSON.parse(await Bun.file("/tmp/agent-mesh-fe-fixture.json").text());
const HUB = ready.api_http, HTTP = ready.base_url;

const newKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  return { publicKey: raw, privateKey, fingerprint: keyFingerprint(raw) };
};

const h = ready.admin_test_handle;
const login = await fetch(h.login_url, {
  method: "POST", headers: { "content-type": h.content_type }, body: h.body, redirect: "manual",
});
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

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

// Sender and recipient: approved, so one can sign and the other can be queued for.
const sender = newKey(), recipient = newKey();
console.log("provision fixture-sender   ", (await provision("fixture-sender", sender.publicKey)).status);
console.log("approve   fixture-sender   ", (await approve(sender.fingerprint)).status);
console.log("provision fixture-recipient", (await provision("fixture-recipient", recipient.publicKey)).status);
console.log("approve   fixture-recipient", (await approve(recipient.fingerprint)).status);

// The pending proposal for /creator/register: provisioned and deliberately NOT approved.
const waiting = newKey();
console.log("provision fixture-awaiting ", (await provision("fixture-awaiting", waiting.publicKey)).status);
console.log("  (left pending on purpose:", waiting.fingerprint.slice(0, 24) + "…)");

// A queued message for /creator/lease-queue: sent, never received.
const params = { to: "fixture-recipient", content: "queued for the lease-queue screen" };
const rawParams = JSON.stringify(params);
const nonce = randomUUID(), iat = Math.floor(Date.now() / 1000);
const value = Buffer.from(edSign(null, Buffer.from(requestSignaturePreimage({
  method: "mesh.send", kid: sender.fingerprint, nonce, iat,
  rawParams: new TextEncoder().encode(rawParams),
})), sender.privateKey)).toString("base64url");
const sig = JSON.stringify({ alg: "ed25519", kid: sender.fingerprint, nonce, iat, value });
const sent = await fetch(`${HUB}/api/v1/rpc`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: `{"jsonrpc":"2.0","id":1,"method":"mesh.send","params":${rawParams},"sig":${sig}}`,
});
console.log("send → fixture-recipient   ", sent.status, (await sent.text()).slice(0, 90));

console.log("\n--- what the screens will see ---");
console.log("pending keys :", (await (await fetch(`${HTTP}/api/v1/admin/keys/pending`, { headers: { cookie } })).json()).pending?.length);
console.log("mailbox depth:", JSON.stringify((await (await fetch(`${HTTP}/api/v1/admin/mailbox`, { headers: { cookie } })).json()).mailboxes));
console.log("tenants      :", JSON.stringify((await (await fetch(`${HTTP}/api/v1/admin/tenants`, { headers: { cookie } })).json()).tenants));

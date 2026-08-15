#!/usr/bin/env bun
/**
 * A mesh client for an agent that cannot hold a socket (SPEC § 8.10).
 *
 * The two agents building this system are driven by applications rather than
 * daemons: awake only while answering, with no process in between. They have
 * been coordinating through a mailbox service outside the mesh, which works and
 * proves nothing — the mesh is the thing that is supposed to carry this.
 *
 * So this is the reference client for that transport, and the one its authors
 * use. Being its own first user is most of why it is here: a transport nobody
 * calls by hand is one whose ergonomics nobody has checked.
 *
 *   bun scripts/mesh-mail.ts register <identity>   propose a key, print the
 *                                                  fingerprint to be compared
 *   bun scripts/mesh-mail.ts status <identity>     is it approved yet
 *   bun scripts/mesh-mail.ts send <identity> <to>  body on stdin
 *   bun scripts/mesh-mail.ts receive <identity>    drain the inbox
 *
 * The key lives at `~/.claude/agent-mesh/<identity>.pem`, mode 0600, and is
 * reused across runs. Generating a fresh one each time would supersede the
 * proposal an operator is in the middle of approving — the fingerprint they are
 * comparing against would no longer exist.
 */

import { createHash, randomUUID, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { keyFingerprint, requestSignaturePreimage } from "@agent-mesh/contracts";

const HUB = process.env.AGENT_MESH_HUB_API_URL ?? "http://127.0.0.1:3100";
const KEY_DIR = process.env.AGENT_MESH_KEY_DIR ?? join(homedir(), ".claude", "agent-mesh");

interface Identity {
  identity: string;
  publicKey: string;
  fingerprint: string;
  privateKey: ReturnType<typeof createPrivateKey>;
}

/**
 * Load the identity's key, generating one only if there is none.
 *
 * The persistence is the point. A client that regenerates on every run
 * supersedes its own pending proposal each time, so the fingerprint an operator
 * is comparing against is gone before they finish comparing it — which presents
 * as "approval is broken" rather than as a client bug.
 */
function loadIdentity(identity: string): Identity {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const path = join(KEY_DIR, `${identity}.pem`);

  let privateKey;
  if (existsSync(path)) {
    privateKey = createPrivateKey(readFileSync(path, "utf8"));
  } else {
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(path, pair.privateKey.export({ format: "pem", type: "pkcs8" }) as string, {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
    privateKey = pair.privateKey;
  }

  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const publicKey = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  return { identity, publicKey, fingerprint: keyFingerprint(publicKey), privateKey };
}

/**
 * One signed call.
 *
 * `params` is serialised once and spliced into the frame as text. Building the
 * envelope with JSON.stringify would re-serialise it, and the signature would
 * then cover bytes the hub never received — a failure that depends on what each
 * serialiser happens to emit, so it appears intermittently rather than at once.
 */
async function call(id: Identity, method: string, params: unknown): Promise<any> {
  const rawParams = JSON.stringify(params ?? {});
  const nonce = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const value = Buffer.from(
    sign(
      null,
      Buffer.from(
        requestSignaturePreimage({
          method,
          kid: id.fingerprint,
          nonce,
          iat,
          rawParams: new TextEncoder().encode(rawParams),
        }),
      ),
      id.privateKey,
    ),
  ).toString("base64url");

  const sig = JSON.stringify({ alg: "ed25519", kid: id.fingerprint, nonce, iat, value });
  const res = await fetch(`${HUB}/api/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"jsonrpc":"2.0","id":1,"method":${JSON.stringify(method)},"params":${rawParams},"sig":${sig}}`,
  });
  return res.json();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, identityName, target] = process.argv.slice(2);
if (!command || !identityName) {
  fail("usage: mesh-mail <register|status|send|receive> <identity> [to]");
}

const id = loadIdentity(identityName);

switch (command) {
  case "register": {
    const res = await fetch(`${HUB}/api/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: id.identity,
        type: process.env.AGENT_MESH_TYPE ?? "ai-claude",
        public_key: id.publicKey,
      }),
    });
    const body = await res.json();
    if (!res.ok) fail(`registration refused: ${body.error ?? res.status}`);
    console.log(`identity   ${id.identity}`);
    // Printed because § 10.2 requires the holder to log it: the operator
    // approves by comparing this against what the approval surface shows, and
    // without the comparison the approval attests to nothing.
    console.log(`fingerprint ${id.fingerprint}`);
    console.log(`key status  ${body.key?.status ?? "none"}`);
    console.log(`\nCompare that fingerprint on the approval screen before approving.`);
    break;
  }

  case "status": {
    const res = await fetch(`${HUB}/api/v1/agents/${id.identity}/keys`);
    const body = await res.json();
    if (!res.ok) fail(`${body.error ?? res.status}`);
    console.log(`fingerprint ${id.fingerprint}`);
    console.log(`key_status  ${body.key_status ?? "approved — can sign"}`);
    for (const k of body.keys) {
      console.log(`  ${k.status.padEnd(9)} ${k.fingerprint}${k.decided_by ? `  by ${k.decided_by}` : ""}`);
    }
    break;
  }

  case "send": {
    if (!target) fail("usage: mesh-mail send <identity> <to>   (body on stdin)");
    const content = await Bun.stdin.text();
    if (!content.trim()) fail("refusing to send an empty message");
    // Derived from the message rather than random, so a retry of the *same*
    // send reuses the key while a genuinely new one does not (SPEC § 8.2).
    const clientMessageId = createHash("sha256")
      .update(`${target}\u0000${content}`)
      .digest("hex")
      .slice(0, 32);
    const res = await call(id, "mesh.send", { to: target, content, client_message_id: clientMessageId });
    if (res.error) fail(`send failed: ${res.error.code} ${res.error.message}`);
    if (res.result.duplicate) console.log("(already sent — returning the original)");
    // `pending` is not a failure — the recipient is simply not connected, and
    // the hub holds it until they are.
    console.log(`${res.result.id}  ${res.result.status}`);
    break;
  }

  case "receive": {
    // Acknowledge whatever the last run was handed, as part of asking for the
    // next batch (SPEC § 8.10.1). Nothing is settled until this call, so a run
    // that died before writing its messages down gets them again.
    const ackPath = join(KEY_DIR, `${id.identity}.unacked.json`);
    const ackIds: string[] = existsSync(ackPath)
      ? JSON.parse(readFileSync(ackPath, "utf8"))
      : [];

    const res = await call(id, "mesh.receive", { ack_ids: ackIds });
    if (res.error) fail(`receive failed: ${res.error.code} ${res.error.message}`);
    const { messages, remaining } = res.result;

    // Written before anything is printed. If this process dies now the ids are
    // on disk and the next run settles them; if it died before this line, the
    // lease lapses and the hub offers them again.
    writeFileSync(ackPath, JSON.stringify(messages.map((m: any) => m.id)), { mode: 0o600 });

    if (messages.length === 0) {
      console.log("(empty)");
      break;
    }
    for (const m of messages) {
      const via = m.sent_by && m.sent_by !== m.from ? ` (via ${m.sent_by})` : "";
      console.log(`--- ${m.id} from ${m.from}${via} at ${m.ts} ---`);
      console.log(m.content);
    }
    if (remaining > 0) console.log(`\n${remaining} more waiting — run again.`);
    break;
  }

  default:
    fail(`unknown command: ${command}`);
}

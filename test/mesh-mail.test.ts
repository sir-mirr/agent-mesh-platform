/**
 * The reference client for § 8.10, measured against a hub that records.
 *
 * `scripts/mesh-mail.ts` is what an agent with no socket uses to reach the
 * mesh, and it is the transport this project's own authors send with. Nothing
 * tested it: it is a top-level script, so the only way to ask it anything is to
 * run it, and nobody had.
 *
 * Two of its properties are ones a reader cannot check by looking. The key
 * persists — a client that regenerates supersedes its own pending proposal, so
 * the fingerprint an operator is comparing against disappears while they
 * compare it, and that presents as "approval is broken" rather than as a client
 * bug. And the signature covers the bytes that were sent: `params` is
 * serialised once and spliced in as text, because building the envelope with
 * `JSON.stringify` would re-serialise it and sign bytes the hub never received.
 */

import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { keyFingerprint, requestSignaturePreimage } from "@agent-mesh/contracts";

import { runChild } from "./child-output.ts";

const CLIENT = resolve(import.meta.dir, "..", "scripts", "mesh-mail.ts");

interface Seen {
  path: string;
  body: any;
  raw: string;
}

/** A hub that answers everything and keeps what it was asked. */
function hub() {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const raw = await req.text();
      seen.push({ path: new URL(req.url).pathname, body: raw ? JSON.parse(raw) : null, raw });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true, messages: [] } });
    },
  });
  return { seen, server, url: `http://127.0.0.1:${server.port}` };
}

async function run(args: string[], url: string, keyDir: string, stdin = "") {
  // Read from files, not pipes: `new Response(child.stdout).text()` threw
  // `EBADF: bad file descriptor` out of a reader in CI and failed a test whose
  // child had run correctly. See `test/child-output.ts`.
  const ran = await runChild(["bun", CLIENT, ...args], {
    env: { ...process.env, AGENT_MESH_HUB_API_URL: url, AGENT_MESH_KEY_DIR: keyDir },
    stdin,
  });
  return { code: ran.code, said: ran.said };
}

describe("the key an agent registers with", () => {
  test("is kept, so a proposal an operator is comparing survives the next run", async () => {
    const keys = mkdtempSync(join(tmpdir(), "mesh-mail-keys-"));
    const { seen, server, url } = hub();
    try {
      const first = await run(["register", "probe-one"], url, keys);
      const second = await run(["register", "probe-one"], url, keys);
      expect({ first: first.code, second: second.code }).toEqual({ first: 0, second: 0 });

      const proposals = seen.filter((s) => s.path === "/api/v1/agents");
      expect(proposals).toHaveLength(2);
      // The same key both times. A fresh one would supersede the first
      // proposal, and the operator's comparison would be against a
      // fingerprint that no longer exists.
      expect(proposals[0]!.body.public_key).toBe(proposals[1]!.body.public_key);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("is written where only its owner can read it", async () => {
    const keys = mkdtempSync(join(tmpdir(), "mesh-mail-mode-"));
    const { server, url } = hub();
    try {
      const registered = await run(["register", "probe-two"], url, keys);
      expect(registered.code, `the client did not register: ${registered.said.trim() || "(nothing)"}`).toBe(0);
      // A private key readable by the machine's other accounts is an identity
      // anyone on the box can sign as.
      expect(statSync(join(keys, "probe-two.pem")).mode & 0o777).toBe(0o600);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("prints the fingerprint the operator is asked to compare", async () => {
    const keys = mkdtempSync(join(tmpdir(), "mesh-mail-print-"));
    const { seen, server, url } = hub();
    try {
      const { code, said } = await run(["register", "probe-three"], url, keys);
      // **The client has to have registered before its output means anything.**
      // Without this the next line reads `undefined.body` and the run dies
      // with a TypeError naming neither the client nor what it said — which is
      // what a full-suite run produced once, and it took a re-run to learn the
      // register had simply not happened.
      const proposal = seen.find((s) => s.path === "/api/v1/agents");
      expect(
        { code, proposed: Boolean(proposal) },
        `the client did not register, so there is no fingerprint to compare — it said: ${said.trim() || "(nothing)"}`,
      ).toEqual({ code: 0, proposed: true });
      const sent = proposal!.body.public_key as string;
      // The fingerprint of the key that was actually proposed — not of some
      // other key, and not a value the client made up.
      expect(said).toContain(keyFingerprint(sent));
    } finally {
      server.stop();
    }
  }, 30_000);
});

describe("what a signed call covers", () => {
  test("the signature verifies over the bytes the hub received", async () => {
    const keys = mkdtempSync(join(tmpdir(), "mesh-mail-sig-"));
    const { seen, server, url } = hub();
    try {
      await run(["register", "probe-four"], url, keys);
      const sent = await run(["send", "probe-four", "somebody-else"], url, keys, "hello there");
      expect(sent.code).toBe(0);

      const rpc = seen.find((s) => s.path === "/api/v1/rpc")!;
      const publicKey = seen.find((s) => s.path === "/api/v1/agents")!.body.public_key as string;
      const { sig, method } = rpc.body;

      // **Rebuilt from the frame as it arrived**, not from the parsed object:
      // the params bytes are what was signed, and re-serialising them here
      // would test this test's serialiser rather than the client's.
      const rawParams = /"params":(.*),"sig":/.exec(rpc.raw)![1]!;
      const preimage = requestSignaturePreimage({
        method,
        kid: sig.kid,
        nonce: sig.nonce,
        iat: sig.iat,
        rawParams: new TextEncoder().encode(rawParams),
      });
      const key = createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(publicKey, "base64url"),
        ]),
        format: "der",
        type: "spki",
      });
      expect({
        kid: sig.kid === keyFingerprint(publicKey),
        verified: verify(null, Buffer.from(preimage), key, Buffer.from(sig.value, "base64url")),
      }).toEqual({ kid: true, verified: true });
    } finally {
      server.stop();
    }
  }, 30_000);
});

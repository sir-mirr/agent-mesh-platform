/**
 * Step 3 — request signatures (SPEC § 8.1).
 *
 * The step the rest of the security work rests on, and the one where partial is
 * worse than absent: a check that can be bypassed reads as protection and is
 * not.
 *
 * The assertion that matters most is the last one. A revoked key must stop
 * verifying on the next request over an **already-open socket** — that is the
 * case revocation exists for, and the reason § 8.1 forbids caching the key for
 * a connection's lifetime.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID, sign as edSign } from "node:crypto";

import { requestSignaturePreimage } from "@agent-mesh/contracts";

import {
  connectRpc, loginAsAdmin, newKeyPair, provision, startMesh,
  type KeyPair, type Mesh,
} from "./harness";

let mesh: Mesh;
let adminCookie: string;

beforeAll(async () => {
  mesh = await startMesh();
  adminCookie = await loginAsAdmin(mesh.http);
});

afterAll(() => mesh?.stop());

const approve = (fingerprint: string) =>
  fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ fingerprint }),
  });

const revoke = (fingerprint: string) =>
  fetch(`${mesh.http.url}/api/v1/admin/keys/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ fingerprint, reason: "compromise" }),
  });

/** A signing identity with an approved key, ready to connect. */
async function signedAgent(identity: string): Promise<KeyPair> {
  const kp = newKeyPair();
  await provision(mesh.hub, identity, "ai-codex", null, kp.publicKey);
  expect((await approve(kp.fingerprint)).status).toBe(200);
  return kp;
}

const socket = (kp: KeyPair) => connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey });

describe("the signed path works end to end", () => {
  test("a signed identity connects and sends", async () => {
    const a = await signedAgent("sig-a");
    await signedAgent("sig-b");

    const rpc = await socket(a);
    expect((await rpc.call("mesh.connect", { identity: "sig-a" })).result.ok).toBe(true);
    const sent = await rpc.call("mesh.send", { to: "sig-b", content: "signed" });
    rpc.close();
    expect(sent.error).toBeUndefined();
    expect(sent.result.id).toBeTruthy();
  });

  test("multi-byte content verifies — the preimage counts bytes, not characters", async () => {
    const a = await signedAgent("sig-utf8");
    await provision(mesh.hub, "utf8-peer", "service");
    const rpc = await socket(a);
    await rpc.call("mesh.connect", { identity: "sig-utf8" });
    const res = await rpc.call("mesh.send", { to: "utf8-peer", content: "한글 🎌 mixed" });
    rpc.close();
    expect(res.error).toBeUndefined();
  });
});

describe("there is no unsigned path for a requires_key type", () => {
  test("an unsigned request from such an identity is refused", async () => {
    const kp = await signedAgent("must-sign");
    const rpc = await connectRpc(mesh.hub); // no signer
    const res = await rpc.call("mesh.connect", { identity: "must-sign" });
    rpc.close();
    expect(res.error).toMatchObject({ code: -32012 });
    expect(res.error.message).toContain("requires a signature");
    expect(kp.fingerprint).toBeTruthy();
  });

  test("a type without requires_key still connects unsigned", async () => {
    // Not a loophole: § 10.3 makes this a property of the type, and a
    // deployment that wants its services authenticated raises the flag.
    await provision(mesh.hub, "unsigned-service", "service");
    const rpc = await connectRpc(mesh.hub);
    const res = await rpc.call("mesh.connect", { identity: "unsigned-service" });
    rpc.close();
    expect(res.result.ok).toBe(true);
  });

  test("registering without a key and connecting unsigned is not a way around it", async () => {
    // The 0.1 draft verified only where a key already existed, which let a
    // caller register without one and connect unsigned. § 10.1 now refuses the
    // registration, so the door closes at the earlier end too.
    const res = await provision(mesh.hub, "keyless-runtime", "ai-claude", null, "");
    expect(res.status).toBe(400);
  });
});

describe("what a signature must cover", () => {
  let kp: KeyPair;
  beforeAll(async () => {
    kp = await signedAgent("tamper");
    await provision(mesh.hub, "tamper-peer", "service");
  });

  /** Sign one request, then send different bytes under that signature. */
  function forged(method: string, signedParams: unknown, sentParams: unknown): string {
    const rawSigned = JSON.stringify(signedParams);
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const value = Buffer.from(
      edSign(null, Buffer.from(requestSignaturePreimage({
        method, kid: kp.fingerprint, nonce, iat,
        rawParams: new TextEncoder().encode(rawSigned),
      })), kp.privateKey),
    ).toString("base64url");
    const sig = JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value });
    return `{"jsonrpc":"2.0","id":99,"method":${JSON.stringify(method)},"params":${JSON.stringify(sentParams)},"sig":${sig}}`;
  }

  async function sendRaw(text: string): Promise<any> {
    const rpc = await socket(kp);
    await rpc.call("mesh.connect", { identity: "tamper" });
    const got = new Promise<any>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const hit = rpc.notifications().find((n) => n.id === 99);
        if (hit || Date.now() - started > 2000) {
          clearInterval(poll);
          resolve(hit);
        }
      }, 10);
    });
    rpc.raw(text);
    const res = await got;
    rpc.close();
    return res;
  }

  test("altering one byte of params invalidates it", async () => {
    const res = await sendRaw(forged(
      "mesh.send",
      { to: "tamper-peer", content: "original" },
      { to: "tamper-peer", content: "originaL" },
    ));
    expect(res.error).toMatchObject({ code: -32012 });
  });

  test("redirecting a signed envelope to another recipient invalidates it", async () => {
    const res = await sendRaw(forged(
      "mesh.send",
      { to: "tamper-peer", content: "x" },
      { to: "sig-b", content: "x" },
    ));
    expect(res.error).toMatchObject({ code: -32012 });
  });

  test("reusing a signature under a different method invalidates it", async () => {
    // The preimage covers `method`, so a signature minted for one call cannot
    // be replayed against another that accepts the same parameter shape.
    const rawParams = JSON.stringify({ to: "tamper-peer", content: "x" });
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const value = Buffer.from(
      edSign(null, Buffer.from(requestSignaturePreimage({
        method: "mesh.send", kid: kp.fingerprint, nonce, iat,
        rawParams: new TextEncoder().encode(rawParams),
      })), kp.privateKey),
    ).toString("base64url");
    const sig = JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value });
    const res = await sendRaw(
      `{"jsonrpc":"2.0","id":99,"method":"mesh.fetch_messages","params":${rawParams},"sig":${sig}}`,
    );
    expect(res.error).toMatchObject({ code: -32012 });
  });

  test("a signature from another identity's key is refused", async () => {
    const other = await signedAgent("impostor");
    const rpc = await connectRpc(mesh.hub, { kid: other.fingerprint, privateKey: other.privateKey });
    const res = await rpc.call("mesh.connect", { identity: "tamper" });
    rpc.close();
    // Caught as the wrong kid before the maths: `tamper`'s approved key is not
    // the one named, and selecting by kid instead would let any approved key
    // sign for any identity.
    expect(res.error).toMatchObject({ code: -32012 });
    expect(res.error.message).toContain("not this identity's approved key");
  });
});

describe("freshness and replay", () => {
  let kp: KeyPair;
  beforeAll(async () => { kp = await signedAgent("fresh"); });

  test("an iat outside the window is refused", async () => {
    const rpc = await socket(kp);
    const res = await rpc.call("mesh.connect", { identity: "fresh" }, {
      iat: Math.floor(Date.now() / 1000) - 300,
    });
    rpc.close();
    // The override changes iat after signing, so this also fails the signature —
    // the point is that the window rejects it first and by name.
    expect(res.error).toMatchObject({ code: -32012 });
    expect(res.error.message).toContain("freshness window");
  });

  test("a replayed nonce inside the window is refused", async () => {
    const rpc = await socket(kp);
    await rpc.call("mesh.connect", { identity: "fresh" });

    const rawParams = JSON.stringify({});
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const value = Buffer.from(
      edSign(null, Buffer.from(requestSignaturePreimage({
        method: "mesh.list_agents", kid: kp.fingerprint, nonce, iat,
        rawParams: new TextEncoder().encode(rawParams),
      })), kp.privateKey),
    ).toString("base64url");
    const frame = (id: number) =>
      `{"jsonrpc":"2.0","id":${id},"method":"mesh.list_agents","params":${rawParams},` +
      `"sig":${JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value })}}`;

    const collect = (id: number) => new Promise<any>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const hit = rpc.notifications().find((n) => n.id === id);
        if (hit || Date.now() - started > 2000) { clearInterval(poll); resolve(hit); }
      }, 10);
    });

    const first = collect(101);
    rpc.raw(frame(101));
    expect((await first).error).toBeUndefined();

    // Byte-identical, so a valid signature — replay is caught by the nonce
    // rather than by the maths.
    const second = collect(102);
    rpc.raw(frame(102));
    expect((await second).error).toMatchObject({ code: -32012 });
    rpc.close();
  });
});

describe("key state is read per request", () => {
  test("revocation bites on the next request over an already-open socket", async () => {
    const kp = await signedAgent("revocable-signer");
    await provision(mesh.hub, "revocable-peer", "service");

    const rpc = await socket(kp);
    expect((await rpc.call("mesh.connect", { identity: "revocable-signer" })).result.ok).toBe(true);
    expect((await rpc.call("mesh.send", { to: "revocable-peer", content: "before" })).error)
      .toBeUndefined();

    expect((await revoke(kp.fingerprint)).status).toBe(200);

    // Without waiting for a reconnect. This is the whole point of the step:
    // caching the key for the connection's lifetime would make revocation take
    // effect only when the socket happened to close, which is precisely the
    // case revocation exists for.
    const after = await rpc.call("mesh.send", { to: "revocable-peer", content: "after" });
    expect(after.error).toMatchObject({ code: -32014 });
    expect(after.error.data).toMatchObject({ code: "KEY_NOT_APPROVED", key_status: "revoked" });

    // § 8.1: the hub MUST close the connection as soon as it observes the
    // state. Returning the error alone left the socket in the online map, so a
    // revoked identity still read as online and still received pushed
    // messages — revocation that leaves the connection receiving is not
    // revocation.
    await Bun.sleep(200);
    const observer = await connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey })
      .catch(() => null);
    observer?.close();

    const peer = await connectRpc(mesh.hub);
    await peer.call("mesh.connect", { identity: "revocable-peer" });
    const listed = (await peer.call("mesh.list_agents", {})).result.agents;
    peer.close();
    rpc.close();
    expect(listed.find((a: any) => a.id === "revocable-signer")?.online).toBe(false);
  });

  test("a pending key cannot sign, and says so", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "still-waiting", "ai-codex", null, kp.publicKey);
    const rpc = await socket(kp);
    const res = await rpc.call("mesh.connect", { identity: "still-waiting" });
    rpc.close();
    // `pending` means wait for an operator; `revoked` means stop and ask a
    // human. A client that could not tell them apart would retry through a
    // shutoff.
    expect(res.error).toMatchObject({ code: -32014 });
    expect(res.error.data.key_status).toBe("pending");
  });
});

describe("a nonce is spent on receipt, not on success (§ 8.1)", () => {
  /**
   * `NonceWindow.claim` was called `check`, which reads as a question. The
   * property worth naming is not "replays are rejected" — that passes either
   * way — but *when* the nonce stops being spendable. Recording only on
   * successful verification would leave a captured envelope replayable without
   * limit: every attempt fails, and every failure hands the nonce back.
   */
  test("a nonce burned by a failed signature cannot be reused by a good one", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "nonce-spent", "ai-claude", null, kp.publicKey);
    await approve(kp.fingerprint);

    const rpc = await connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey });
    // Verification only runs once the socket has an identity — before
    // `mesh.connect` there is nothing to verify against, so neither frame would
    // reach the replay window at all.
    expect((await rpc.call("mesh.connect", { identity: "nonce-spent" })).error).toBeUndefined();
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const params = JSON.stringify({});
    const preimage = requestSignaturePreimage({
      method: "mesh.list_agents",
      kid: kp.fingerprint,
      nonce,
      iat,
      rawParams: new TextEncoder().encode(params),
    });
    const good = Buffer.from(edSign(null, Buffer.from(preimage), kp.privateKey)).toString("base64url");

    const frame = (value: string) =>
      `{"jsonrpc":"2.0","id":1,"method":"mesh.list_agents","params":${params},` +
      `"sig":${JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value })}}`;

    // First attempt: this nonce, deliberately wrong signature.
    const first = await new Promise<any>((resolve) => {
      const socket = (rpc as any);
      socket.raw(frame("AAAA"));
      setTimeout(() => resolve(socket.notifications()), 300);
    });
    expect(first).toBeDefined();

    // Second attempt: same nonce, correct signature. Must still be refused —
    // the nonce was spent by the attempt that failed.
    const res = await new Promise<any>((resolve) => {
      const socket = (rpc as any);
      const before = socket.notifications().length;
      socket.raw(frame(good));
      const timer = setInterval(() => {
        const now = socket.notifications();
        if (now.length > before) {
          clearInterval(timer);
          resolve(now[now.length - 1]);
        }
      }, 20);
      setTimeout(() => { clearInterval(timer); resolve(null); }, 2000);
    });
    expect(res?.error?.message ?? "").toContain("nonce already seen");
    rpc.close();
  }, 20_000);

  test("a stale request never enters the window", async () => {
    // Freshness is checked first on purpose: otherwise anyone could fill the
    // replay window with nonces that were never going to be accepted.
    const kp = newKeyPair();
    await provision(mesh.hub, "nonce-stale", "ai-claude", null, kp.publicKey);
    await approve(kp.fingerprint);

    const nonce = randomUUID();
    const stale = Math.floor(Date.now() / 1000) - 600;
    const fresh = Math.floor(Date.now() / 1000);
    const signer = { kid: kp.fingerprint, privateKey: kp.privateKey };

    const sign = (iat: number) => {
      const params = JSON.stringify({});
      const value = Buffer.from(edSign(null, Buffer.from(requestSignaturePreimage({
        method: "mesh.list_agents", kid: kp.fingerprint, nonce, iat,
        rawParams: new TextEncoder().encode(params),
      })), kp.privateKey)).toString("base64url");
      return `{"jsonrpc":"2.0","id":1,"method":"mesh.list_agents","params":${params},` +
        `"sig":${JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value })}}`;
    };

    const rpc = await connectRpc(mesh.hub, signer);
    expect((await rpc.call("mesh.connect", { identity: "nonce-stale" })).error).toBeUndefined();
    const collect = () => (rpc as any).notifications();

    (rpc as any).raw(sign(stale));
    await Bun.sleep(250);

    // The same nonce with a fresh iat must now succeed: the stale attempt was
    // turned away before the nonce was recorded.
    const before = collect().length;
    (rpc as any).raw(sign(fresh));
    await Bun.sleep(400);
    const answers = collect().slice(before);
    const replayed = answers.some((a: any) => String(a?.error?.message ?? "").includes("nonce already seen"));
    expect(replayed).toBe(false);
    rpc.close();
  }, 20_000);
});

describe("§ 8.10 carries § 8.1's error codes, including the key state", () => {
  /**
   * The socketless transport answered a non-approved key with a generic
   * `-32014`-less invalid request. § 8.10 says outright that "the methods, the
   * signing construction, the error codes and the queue are the ones already
   * specified", so the code was a contract violation and not a gap.
   *
   * It matters most to exactly this population: an agent reaching the mesh this
   * way has no `mesh.connect` to have learned its key state from, and being
   * refused is the first thing that happens to every new lane.
   */
  const post = async (kp: ReturnType<typeof newKeyPair>) => {
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const params = "{}";
    const value = Buffer.from(
      edSign(null, Buffer.from(requestSignaturePreimage({
        method: "mesh.list_agents", kid: kp.fingerprint, nonce, iat,
        rawParams: new TextEncoder().encode(params),
      })), kp.privateKey),
    ).toString("base64url");
    const res = await fetch(`${mesh.hub.url}/api/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"jsonrpc":"2.0","id":1,"method":"mesh.list_agents","params":${params},` +
        `"sig":${JSON.stringify({ alg: "ed25519", kid: kp.fingerprint, nonce, iat, value })}}`,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("a pending key is -32014 with key_status pending", async () => {
    const kp = newKeyPair();
    await provision(mesh.hub, "http-pending", "ai-claude", null, kp.publicKey);

    const { body } = await post(kp);
    expect(body.error.code).toBe(-32014);
    expect(body.error.data).toMatchObject({ code: "KEY_NOT_APPROVED", key_status: "pending" });
  });

  test("a revoked key says revoked, so a client stops rather than waits", async () => {
    // The distinction the generic error destroyed: `pending` means wait for a
    // person, `revoked` means stop.
    const kp = newKeyPair();
    await provision(mesh.hub, "http-revoked", "ai-claude", null, kp.publicKey);
    await approve(kp.fingerprint);
    const revoked = await fetch(`${mesh.http.url}/api/v1/admin/keys/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await loginAsAdmin(mesh.http) },
      body: JSON.stringify({ fingerprint: kp.fingerprint, reason: "rotation" }),
    });
    expect(revoked.status).toBe(200);

    const { body } = await post(kp);
    expect(body.error.code).toBe(-32014);
    expect(body.error.data.key_status).toBe("revoked");
  });

  test("an unknown fingerprint is missing, not an internal error", async () => {
    const { body } = await post(newKeyPair());
    expect(body.error.code).toBe(-32014);
    expect(body.error.data.key_status).toBe("missing");
  });

  test("the refusal never names the holder", async () => {
    // Reporting the identity would build a key-to-identity lookup probeable by
    // anyone who can reach the port — the reverse direction of
    // `GET /api/v1/agents/{identity}/keys`, which requires knowing the name.
    const kp = newKeyPair();
    await provision(mesh.hub, "http-unnamed", "ai-claude", null, kp.publicKey);

    const { body } = await post(kp);
    expect(JSON.stringify(body)).not.toContain("http-unnamed");
  });
});

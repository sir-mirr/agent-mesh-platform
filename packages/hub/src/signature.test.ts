/**
 * The hub's half of the cross-implementation check (plan, "Fixtures").
 *
 * The contract repository already runs these. Running them here as well is the
 * point: two implementations agreeing is the thing being tested, and it is only
 * tested where both are present. A tag bump that changed an encoding would
 * otherwise pass over there and be discovered here as signatures that stopped
 * verifying, with no indication why.
 */

import { describe, expect, test } from "bun:test";

import { requestSignaturePreimage } from "@agent-mesh/contracts";
import { REQUEST_SIGNATURE_FIXTURES } from "@agent-mesh/contracts/fixtures";

import { rawParams } from "./raw-params";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("the pinned contract still encodes what this hub expects", () => {
  for (const f of REQUEST_SIGNATURE_FIXTURES) {
    test(f.name, () => {
      const preimage = requestSignaturePreimage({
        method: f.method,
        kid: f.kid,
        nonce: f.nonce,
        iat: f.iat,
        rawParams: new TextEncoder().encode(f.rawParams),
      });
      expect(hex(preimage)).toBe(f.preimageHex);
      expect(preimage.length).toBe(f.preimageLength);
    });
  }
});

/**
 * `rawParams` is the hub's own, and it is the piece most able to disagree with
 * a client silently: it does not fail, it returns the wrong span, and the only
 * symptom is a signature that will not verify.
 */
describe("raw params extraction", () => {
  test("returns the bytes as they arrived, not a re-serialisation", () => {
    // Whitespace and key order are preserved. Both survive a parse/stringify
    // round trip differently, and either would change the preimage.
    const text = '{"jsonrpc":"2.0","id":1,"method":"mesh.send","params": { "b" : 2, "a":1 }}';
    expect(rawParams(text)).toBe('{ "b" : 2, "a":1 }');
  });

  test("ignores 'params' appearing inside a string value", () => {
    // The failure this guards against: matching the word anywhere captures the
    // wrong span, and every signature after it fails for no visible reason.
    const text = '{"method":"mesh.send","id":"\\"params\\": {\\"fake\\":1}","params":{"real":true}}';
    expect(rawParams(text)).toBe('{"real":true}');
  });

  test("ignores a nested params member", () => {
    const text = '{"method":"m","params":{"inner":{"params":{"nested":1}}}}';
    expect(rawParams(text)).toBe('{"inner":{"params":{"nested":1}}}');
  });

  test("handles arrays, escapes and multi-byte content", () => {
    const text = '{"method":"m","params":["한글",{"q":"a \\" b"},null,1.5e3]}';
    expect(rawParams(text)).toBe('["한글",{"q":"a \\" b"},null,1.5e3]');
  });

  test("returns null when there is no params member", () => {
    // A valid request with no parameters. The caller signs `{}`, matching the
    // encoder, rather than signing nothing.
    expect(rawParams('{"jsonrpc":"2.0","id":1,"method":"mesh.list_agents"}')).toBeNull();
  });

  test("a literal value ends at the next structural character", () => {
    expect(rawParams('{"method":"m","params":42,"sig":{}}')).toBe("42");
    expect(rawParams('{"method":"m","params":null}')).toBe("null");
  });

  test("a params member after sig is still found", () => {
    // Key order is the client's choice; nothing may depend on ours.
    const text = '{"sig":{"kid":"k"},"method":"m","params":{"x":1}}';
    expect(rawParams(text)).toBe('{"x":1}');
  });

  /**
   * **Malformed text has to end the scan, not run off it.** This runs before
   * `JSON.parse` on every signed frame — the preimage is built from the bytes
   * that arrived, so the bytes are scanned before anything has established they
   * are a document at all. A truncated frame is the ordinary case: a socket
   * that closed mid-write produces one.
   */
  describe("text that is not a document", () => {
    test("a params key with no value is not a params member", () => {
      expect(rawParams('{"method":"m","params"}')).toBeNull();
      expect(rawParams('{"method":"m","params" ')).toBeNull();
    });

    test("a string that never closes ends the scan", () => {
      expect(rawParams('{"method":"m","params":"unterminated')).toBe('"unterminated');
      expect(rawParams('{"method":"m","id":"unterminated')).toBeNull();
    });

    test("a value that never closes is taken as far as it goes", () => {
      expect(rawParams('{"method":"m","params":{"a":1')).toBe('{"a":1');
      expect(rawParams('{"method":"m","params":[1,2')).toBe("[1,2");
    });

    test("an escape at the very end does not read past it", () => {
      expect(rawParams('{"method":"m","params":"a\\')).toBe('"a\\');
    });

    test("empty text has no params member", () => {
      expect(rawParams("")).toBeNull();
      expect(rawParams("{}")).toBeNull();
    });
  });
});

/**
 * What the hub advertises has to be what the contract describes.
 *
 * It was not, and the failure was invisible from this side: the hub returned a
 * shape of its own with no `version` field, and a client that MUST NOT guess an
 * unrecognised version simply never started its audit worker. Nothing errored
 * here. The whole surface was off, and the hub's own tests passed.
 */
describe("advertised audit capabilities match the contract", () => {
  test("every field, with the contract's values", async () => {
    const { AUDIT_LIMITS } = await import("./rpc/audit-limits");
    const { AUDIT_CAPABILITY_DEFAULTS } = await import("@agent-mesh/contracts");
    expect(AUDIT_LIMITS).toEqual(AUDIT_CAPABILITY_DEFAULTS);
  });
});

/**
 * `verifyRequest` itself, which nothing above reaches.
 *
 * This module read 12.80% — the fixtures above pin the *encoding* both
 * implementations share, and nothing had ever asked the hub what it does with a
 * signature once it has one. That is the whole decision surface: whether a
 * signature is required, whether this one is fresh, whether its nonce has been
 * spent, and which of two different refusals a client is owed.
 *
 * Driven in this process against the run's shared state directory. Every
 * identity is unique, so nothing here depends on what the store already holds —
 * and nothing removes a directory the singleton handles in `db.ts` are still
 * pointing at.
 */
// Module scope, not inside `describe`: its callback is synchronous, and `./db`
// opens its handles the moment it is imported either way.
const { generateKeyPairSync, sign: edSign } = await import("node:crypto");
const { SIGNATURE_FRESHNESS_WINDOW_SECONDS, requestSignaturePreimage: preimageOf } =
  await import("@agent-mesh/contracts");
const { keys } = await import("@agent-mesh/store");
const { agentsDb } = await import("./db");
const { KEY_NOT_APPROVED, SIGNATURE_INVALID, verifyRequest, nonceWindow } = await import("./signature");

describe("verifying a request", () => {
  let n = 0;
  const nextId = (p: string) => `sig-${p}-${++n}-${process.pid}`;

  /** A type that demands a signature on every request, and one that does not. */
  const type = (name: string, requiresKey: 0 | 1) => {
    agentsDb
      .prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES (?, ?)`)
      .run(name, requiresKey);
    return name;
  };
  const SIGNING = type("in-process-signing", 1);
  const OPEN = type("in-process-open", 0);

  const agent = (t: string) => {
    const identity = nextId(t === SIGNING ? "must-sign" : "open");
    agentsDb.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, ?)`).run(identity, t);
    return identity;
  };

  /** A key pair in the encoding the store stores: raw 32 bytes, base64url. */
  function keypair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    return { raw: Buffer.from(der.subarray(der.length - 32)).toString("base64url"), privateKey };
  }

  const approve = (identity: string) => {
    const kp = keypair();
    const { fingerprint } = keys.proposeKey(agentsDb, identity, kp.raw, "in-process-test");
    keys.approveKey(agentsDb, fingerprint, "in-process-test");
    return { ...kp, fingerprint };
  };

  const now = () => Math.floor(Date.now() / 1000);

  /** A signature built the way a client must build one. */
  function signed(
    kp: { privateKey: any; fingerprint: string },
    method: string,
    raw: string,
    over: { nonce?: string; iat?: number } = {},
  ) {
    const nonce = over.nonce ?? nextId("nonce");
    const iat = over.iat ?? now();
    const preimage = preimageOf({
      method,
      kid: kp.fingerprint,
      nonce,
      iat,
      rawParams: new TextEncoder().encode(rawParams(raw) ?? "{}"),
    });
    const value = edSign(null, Buffer.from(preimage), kp.privateKey).toString("base64url");
    return { alg: "ed25519", kid: kp.fingerprint, nonce, iat, value };
  }

  const RAW = `{"method":"mesh.send","params":{"to":"b","content":"hi"}}`;

  test("an unsigned request from a type that needs no key is allowed", () => {
    expect(verifyRequest(agent(OPEN), "mesh.send", undefined, RAW)).toEqual({ ok: true, signed: false });
  });

  /**
   * Required by the *type*, not by whether a key happens to exist. An earlier
   * draft verified only where an approved key was already present, which read
   * as backward compatibility and was an open door: register without a key,
   * then connect unsigned.
   */
  test("an unsigned request from a type that requires one is refused", () => {
    const identity = agent(SIGNING);
    const v = verifyRequest(identity, "mesh.send", undefined, RAW);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.code).toBe(SIGNATURE_INVALID);
    expect(v.ok === false && v.message).toContain("requires a signature on every request");
  });

  test("an envelope missing or mistyping any member is malformed", () => {
    const identity = agent(SIGNING);
    const good = { alg: "ed25519", kid: "k", nonce: "n", iat: now(), value: "v" };
    const bad = [
      { ...good, alg: "rsa" },
      { ...good, kid: 5 },
      { ...good, nonce: null },
      { ...good, iat: "now" },
      { ...good, iat: 1.5 },
      { ...good, value: 9 },
    ];
    for (const sig of bad) {
      const v = verifyRequest(identity, "mesh.send", sig as any, RAW);
      expect(v.ok === false && v.message).toBe("malformed sig");
    }
  });

  test("an iat outside the freshness window is refused, on both sides", () => {
    const identity = agent(SIGNING);
    const kp = approve(identity);
    for (const skew of [-(SIGNATURE_FRESHNESS_WINDOW_SECONDS + 5), SIGNATURE_FRESHNESS_WINDOW_SECONDS + 5]) {
      const v = verifyRequest(identity, "mesh.send", signed(kp, "mesh.send", RAW, { iat: now() + skew }), RAW);
      expect(v.ok === false && v.message).toContain("iat outside");
    }
  });

  /**
   * **The nonce is spent before the signature is checked**, so a request whose
   * signature then fails has still consumed it and a retry must carry a fresh
   * one (§ 8.1). Recording only on success would let a captured envelope be
   * replayed unboundedly against a hub whose key state had changed, because
   * every attempt would fail verification and leave the nonce spendable.
   */
  test("a nonce already seen in the window is refused the second time", () => {
    const identity = agent(SIGNING);
    const kp = approve(identity);
    const sig = signed(kp, "mesh.send", RAW);
    expect(verifyRequest(identity, "mesh.send", sig, RAW)).toEqual({ ok: true, signed: true });
    const again = verifyRequest(identity, "mesh.send", sig, RAW);
    expect(again.ok === false && again.message).toContain("nonce already");
  });

  test("and a bad signature spends its nonce too, so the retry is refused for replay", () => {
    const identity = agent(SIGNING);
    const kp = approve(identity);
    const sig = { ...signed(kp, "mesh.send", RAW), value: Buffer.alloc(64, 7).toString("base64url") };
    const first = verifyRequest(identity, "mesh.send", sig, RAW);
    expect(first.ok === false && first.message).toBe("signature does not verify");
    const second = verifyRequest(identity, "mesh.send", sig, RAW);
    expect(second.ok === false && second.message).toContain("nonce already");
  });

  /**
   * A different refusal from a bad signature, because a client acts
   * differently: `pending` means wait for an operator, `denied` or `revoked`
   * mean stop and ask a person. One error for all three would make a client
   * retry through a shutoff.
   */
  test("an identity with no approved key is refused with its key status", () => {
    const identity = agent(SIGNING);
    const kp = keypair();
    const { fingerprint } = keys.proposeKey(agentsDb, identity, kp.raw, "in-process-test");
    const v = verifyRequest(identity, "mesh.send", signed({ ...kp, fingerprint }, "mesh.send", RAW), RAW);
    expect(v.ok === false && v.code).toBe(KEY_NOT_APPROVED);
    expect(v.ok === false && (v.data as any)?.code).toBe("KEY_NOT_APPROVED");
    expect(v.ok === false && (v.data as any)?.identity).toBe(identity);
    expect(v.ok === false && (v.data as any)?.key_status).toBe("pending");
  });

  test("a signature made with a key that is not the approved one is named as such", () => {
    const identity = agent(SIGNING);
    approve(identity);
    const other = keypair();
    const otherFp = keys.proposeKey(agentsDb, agent(SIGNING), other.raw, "in-process-test").fingerprint;
    const v = verifyRequest(identity, "mesh.send", signed({ ...other, fingerprint: otherFp }, "mesh.send", RAW), RAW);
    expect(v.ok === false && v.message).toContain("not this identity's approved key");
  });

  /**
   * The preimage covers the params as they arrived. A body altered after
   * signing verifies against different bytes, which is the property the whole
   * envelope exists for.
   */
  test("a body changed after signing does not verify", () => {
    const identity = agent(SIGNING);
    const kp = approve(identity);
    const sig = signed(kp, "mesh.send", RAW);
    const tampered = `{"method":"mesh.send","params":{"to":"mallory","content":"hi"}}`;
    const v = verifyRequest(identity, "mesh.send", sig, tampered);
    expect(v.ok === false && v.message).toBe("signature does not verify");
  });

  test("and so does a signature lifted onto another method", () => {
    const identity = agent(SIGNING);
    const kp = approve(identity);
    const v = verifyRequest(identity, "mesh.teardown", signed(kp, "mesh.send", RAW), RAW);
    expect(v.ok === false && v.message).toBe("signature does not verify");
  });

  test("the nonce window is reachable, which is why it is exported", () => {
    expect(typeof nonceWindow.sweep).toBe("function");
  });
});

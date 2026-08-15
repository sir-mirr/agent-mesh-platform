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

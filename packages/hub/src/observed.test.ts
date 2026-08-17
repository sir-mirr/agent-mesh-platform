/**
 * SPEC § 8.11. The tests that matter here are the forgery ones.
 *
 * Every other property in this file fails loudly — a wrong normalisation
 * refuses every agent and someone notices within a minute. Taking the leftmost
 * `X-Forwarded-For` entry fails *silently*: the feature stays on, reports
 * itself as enabled, and compares whatever the attacker wrote.
 */

import { describe, expect, test } from "bun:test";

import { normalizeAddress, observedSource, prefixOf, readObservedConfig } from "./observed";

const PROXY = "198.51.100.7";
const forwarded = readObservedConfig({ AGENT_MESH_TRUSTED_PROXIES: PROXY });
const socketOnly = readObservedConfig({});

describe("configuration", () => {
  test("no trusted proxies means the header is ignored, not used as a fallback", () => {
    // The failure this whole file exists to prevent: an unconfigured
    // deployment silently believing a header.
    expect(socketOnly.mode).toBe("socket");
    expect(observedSource(socketOnly, "203.0.113.1", "10.0.0.1")).toBe("203.0.113.1");
  });

  test("a list of only blanks is the same as none", () => {
    expect(readObservedConfig({ AGENT_MESH_TRUSTED_PROXIES: " , ,, " }).mode).toBe("socket");
  });

  test("trusted proxies are normalised on the way in", () => {
    // Otherwise `::ffff:198.51.100.7` in the env never matches the peer.
    const c = readObservedConfig({ AGENT_MESH_TRUSTED_PROXIES: `::ffff:${PROXY}` });
    expect(c.trustedProxies.has(PROXY)).toBe(true);
  });
});

describe("normalisation", () => {
  test("IPv4-mapped IPv6 collapses, in the spelling Bun actually returns", () => {
    // Measured: both `server.requestIP()` and `ws.remoteAddress` answer
    // `::ffff:127.0.0.1` for a v4 loopback peer. Stored one way and observed
    // the other, every comparison fails and every agent is refused.
    expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAddress("::FFFF:127.0.0.1")).toBe("127.0.0.1");
  });

  test("ports are stripped, because they change every connection", () => {
    expect(normalizeAddress("1.2.3.4:51234")).toBe("1.2.3.4");
    expect(normalizeAddress("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  test("a bare IPv6 address is not mistaken for a host:port pair", () => {
    expect(normalizeAddress("::1")).toBe("::1");
    expect(normalizeAddress("2001:db8::1")).toBe("2001:db8::1");
  });

  test("empty and whitespace answer null rather than an empty string", () => {
    // An empty string compares equal to itself, so a missing address would
    // silently "match" a baseline that was also missing.
    for (const v of [null, undefined, "", "   "]) expect(normalizeAddress(v)).toBeNull();
  });
});

describe("the forgery this is built against", () => {
  test("the leftmost entry is the attacker's and is never taken", () => {
    // A client sends `X-Forwarded-For: 203.0.113.9`; the proxy appends its
    // view. Leftmost is the conventional "original client" and is exactly the
    // forgeable one.
    const header = "203.0.113.9, 192.0.2.55";
    expect(observedSource(forwarded, PROXY, header)).toBe("192.0.2.55");
    expect(observedSource(forwarded, PROXY, header)).not.toBe("203.0.113.9");
  });

  test("a long forged prefix changes nothing", () => {
    const header = ["9.9.9.1", "9.9.9.2", "9.9.9.3", "9.9.9.4", "192.0.2.55"].join(", ");
    expect(observedSource(forwarded, PROXY, header)).toBe("192.0.2.55");
  });

  test("a peer that is not a trusted proxy has its header ignored entirely", () => {
    // Someone reaching the hub directly. Their header is worth nothing; the
    // socket address is still an observation, so it is what we use.
    expect(observedSource(forwarded, "203.0.113.200", "10.1.2.3")).toBe("203.0.113.200");
  });

  test("trusted hops are skipped from the right, and only trusted ones", () => {
    const two = readObservedConfig({ AGENT_MESH_TRUSTED_PROXIES: `${PROXY},198.51.100.8` });
    expect(observedSource(two, PROXY, "192.0.2.55, 198.51.100.8")).toBe("192.0.2.55");
  });

  test("a chain of nothing but trusted proxies answers null, not a guess", () => {
    const two = readObservedConfig({ AGENT_MESH_TRUSTED_PROXIES: `${PROXY},198.51.100.8` });
    expect(observedSource(two, PROXY, "198.51.100.8")).toBeNull();
    expect(observedSource(forwarded, PROXY, "")).toBeNull();
    expect(observedSource(forwarded, PROXY, null)).toBeNull();
  });

  test("mapped-IPv6 spellings in the chain still match a trusted proxy", () => {
    const two = readObservedConfig({ AGENT_MESH_TRUSTED_PROXIES: `${PROXY},198.51.100.8` });
    expect(observedSource(two, `::ffff:${PROXY}`, "192.0.2.55, ::ffff:198.51.100.8")).toBe("192.0.2.55");
  });
});

describe("socket mode", () => {
  test("answers the socket address, normalised", () => {
    expect(observedSource(socketOnly, "::ffff:10.0.0.4", null)).toBe("10.0.0.4");
  });

  test("answers null when there is no socket address rather than inventing one", () => {
    expect(observedSource(socketOnly, null, "1.2.3.4")).toBeNull();
  });
});

describe("prefix grouping", () => {
  test("IPv4 groups to /24 — the churn that has no security meaning", () => {
    // A cloud instance restarting inside its subnet, or a DHCP renewal, is not
    // a key moving to another network. `exact` fires on both.
    expect(prefixOf("203.0.113.47")).toBe("203.0.113.0/24");
    expect(prefixOf("203.0.113.92")).toBe("203.0.113.0/24");
    expect(prefixOf("203.0.114.1")).not.toBe(prefixOf("203.0.113.1"));
  });

  test("IPv6 groups to /48, the size an operator is actually assigned", () => {
    expect(prefixOf("2001:db8:abcd:1234::1")).toBe("2001:db8:abcd::/48");
    expect(prefixOf("2001:db8:abcd:9999::ff")).toBe("2001:db8:abcd::/48");
    expect(prefixOf("2001:db8:abce:1::1")).not.toBe(prefixOf("2001:db8:abcd:1::1"));
  });

  test("mapped IPv4 groups as IPv4, not as IPv6", () => {
    // Both transports report `::ffff:…` for a v4 peer; grouping it as v6 would
    // put every v4 address in the mesh into one bucket.
    expect(prefixOf("::ffff:203.0.113.47")).toBe("203.0.113.0/24");
  });

  test("short IPv6 keeps its leading groups rather than collapsing", () => {
    expect(prefixOf("::1")).toBe("0:0:0::/48");
    expect(prefixOf("fe80::1")).toBe("fe80:0:0::/48");
  });

  test("something unparseable is left alone, not made coarser", () => {
    // Two different unknowns must not compare equal. "We could not tell" is
    // not "the same place".
    expect(prefixOf("not-an-address")).toBe("not-an-address");
    expect(prefixOf(null)).toBeNull();
  });
});

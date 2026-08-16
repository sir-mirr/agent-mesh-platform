# Proposal — what an attestation should actually contain

Status: **proposed**. Companion to
[`dormancy-reattestation.md`](dormancy-reattestation.md), which left "which
claims" open because the claim set decides the whole value of the mechanism.

## The question that sorts everything

Not *"how unique is this identifier"*. **"Can someone holding the private key
but not the machine produce it?"**

Uniqueness is irrelevant here. A MAC address is globally unique and completely
forgeable — it is a string the holder types. The attacker in this threat model
already has the key, so every claim they can *guess or read* is a claim they can
sign.

That splits candidates into three tiers, and they are not close in strength.

## Tier 1 — self-reported. Forgeable the moment the value is known.

```
hostname            MAC address         local IP
CPU model           /etc/machine-id     container id
OS + kernel version boot id             disk serial
```

The hub receives a string. It cannot check any of it. A thief who copied only
`~/.agent-mesh/key.pem` does not know these; a thief who copied the directory,
read the process environment, or saw one attestation on the wire does.

**And there is a specific way this leaks.** The attestation is *sent to the
hub*. It is in the request body, in the hub's logs, and in the audit trail. Any
insider who can read those — including, per the roles proposal, the platform
operator — knows exactly what to replay. The mechanism defends against an
outsider with a stolen file and not against anyone inside.

CPU "fingerprints" deserve a specific warning: CPUID model/stepping identifies
a *product line*, not a chip. Every machine of that SKU answers identically, so
as a discriminator it is close to worthless, and treating it as a hardware root
because it has the word CPU in it is the error this tier exists to name.

Value: **raises cost against a naive file thief. Zero against an insider.**

## Tier 2 — observed by the hub. The agent does not get a say.

```
source IP / prefix        autonomous system
TLS client fingerprint    mTLS client certificate
connection timing shape
```

This is different **in kind**, not degree. The hub does not ask; it looks. A
key-holder who knows every Tier 1 value still cannot make packets arrive from
an address they do not control.

`request.headers` and the socket already carry this. Nothing needs to be
invented, which makes it the best strength-per-effort available today.

Costs, stated so they are not discovered later:

- **NAT and egress proxies** put many agents behind one address, so the claim
  is coarse.
- **Mobile and residential agents move** — this fires on a train, a VPN, a
  laptop lid closing. Prefix or ASN rather than exact IP softens it and weakens
  it by the same amount.
- **A reverse proxy in front of the hub** replaces the observation with its own
  address. `X-Forwarded-For` is a header — Tier 1 wearing a Tier 2 costume.
  If the hub sits behind anything, this tier is only as good as the trust in
  that hop, and that must be configured explicitly rather than assumed.

Value: **the only tier available today that survives an attacker who read the
attestation.**

## Tier 3 — hardware-rooted. The signature itself is the evidence.

```
TPM 2.0 quote (PCR set, AK certificate)
Apple Secure Enclave     Android StrongBox / Keystore attestation
YubiKey / PIV            Cloud KMS with non-exportable keys
```

The property is not that the claim is unforgeable. It is that **the private key
cannot leave the machine**, so the theft this whole feature exists to detect
does not happen.

That is worth stating plainly: **Tier 3 does not improve dormancy
re-attestation — it makes it unnecessary** for any identity that uses it. If a
key is non-exportable, a signature is proof of the machine, on every request,
not only after three hours of silence.

Costs are real: no bare containers or ordinary VMs, per-platform code paths,
provisioning ceremony, and recovery when hardware dies is a re-enrolment rather
than a file copy.

Value: **actually closes it, for the population that can run it.**

## Decision: build Tier 2 only

Self-reported claims are not being collected. The attestation is **what the hub
observes**, and the consequences of that are larger than they first look.

### The client contract barely changes

Tier 1 required the agent to gather values, digest them, and attach them to
`params` — which is what forced `-32016 REATTESTATION_REQUIRED`, the retry
round trip, and the "claim keys expected" negotiation in
[`dormancy-reattestation.md`](dormancy-reattestation.md).

**All of that disappears.** The agent supplies nothing; the hub looks at the
connection it already has. `-32016` is deleted from the design. The only new
thing a client can receive is the refusal:

```
-32017 ATTESTATION_CHANGED
```

Both transports expose it with no new dependency — measured, not assumed:

```
HTTP  server.requestIP(req)   -> { address: "::ffff:127.0.0.1", family, port }
WS    ws.remoteAddress        -> "::ffff:127.0.0.1"
```

**Normalise before comparing.** That is an IPv4-mapped IPv6 address; stored one
way and observed the other, every comparison fails and every agent is refused.

### Comparison becomes free, so dormancy is only about when to *act*

Tier 1 could only be checked when the agent chose to send claims, which is why
dormancy was the trigger. Observation costs nothing and is available on every
request.

That separates two things the original proposal had fused:

| | |
|---|---|
| **Record** the observed source on every request | always |
| **Block** on a change | after the dormancy window |

Recording always is strictly better: an address change on a busy identity is
now visible in the audit trail even though it is not blocked, so an operator
investigating later has the history rather than a gap. Dormancy stops being a
mechanism constraint and becomes the policy it should have been — *when is a
change suspicious enough to stop.*

### The baseline must come from the agent, not from whoever registered it

`POST /api/v1/agents` may be called by an operator from a browser on a
different machine. Recording *that* address as the agent's baseline would be
wrong on the first comparison.

Capture it at a moment the agent itself is the peer:

- **pairing-code redemption** — the CLI runs on the agent's host, which is why
  [`operator-roles.md`](operator-roles.md) notes this is the strongest moment
  available; or
- **first successful authenticated request** after the key is approved, with
  the identity in a `baselining` state until then.

The second needs no new mechanism and is the fallback where no pairing code was
used.

### A reverse proxy deletes this tier

`X-Forwarded-For` is a header — Tier 1 wearing a Tier 2 costume. If anything
sits in front of the hub, the observed address is the proxy's and the real one
is a claim the client could have written.

This must be **explicit configuration, never inference**: a trusted-proxy list,
and with none configured the hub uses the socket address and ignores the header
entirely. A deployment behind an untrusted hop should turn the feature off
rather than run it on a value anyone can set, and the capability document
should say which of the two it is doing.

### Granularity is a per-identity choice

| | catches | false-positives on |
|---|---|---|
| exact address | most | DHCP renewal, any NAT reassignment |
| prefix (/24, /48) | moved network | large NAT pools, CGNAT |
| ASN | moved provider | almost nothing, and misses moves within one cloud |

A fixed-VM lane and a laptop lane want different answers, so this belongs
beside the identity rather than in a global setting. **ASN is the safe default**
— it fires on "this key is now being used from a different provider", which is
the shape of the theft this is for, and stays quiet through the churn that
makes operators disable things.

### What Tier 2 does not catch, stated plainly

A thief on the **same network** as the victim — same office, same NAT, same
cloud account, same VPN. For those, the observation is identical and nothing
here fires. That is the residual, and Tier 3 is the only thing that closes it.

## What this is honestly worth

**It detects a key that went quiet and came back from a different network.**
Nothing more, and it does that without the agent's cooperation, which is what
makes it worth more than the larger Tier 1 design it replaces.

If the requirement is to *prevent* key theft rather than notice it, Tier 3 is
the answer and this is a workaround for not having it — a good one, and still
a workaround.

## Open

- **Is the hub behind a proxy in any target deployment?** Decides whether this
  runs at all, and it is the first question to answer.
- **Default granularity**, and whether a deployment may override it per
  identity or only globally.
- **Does the observed source belong to the identity or to the key?** A rotated
  key on the same host should inherit the baseline; a key moved to a new host
  is the thing being detected. Keyed on identity is probably right and is not
  obviously so.
- **Proxied sends.** `from: alice_dev, sent_by: http-server` — the observed
  address is the proxy's, always. Gate on the socket holder, or exempt proxied
  sends entirely.
- **Is any target population Tier 3 capable?** If so this becomes the fallback
  path rather than the design centre.

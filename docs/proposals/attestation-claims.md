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

## What to build

**Record both what the agent claims and what the hub saw, and never merge
them.** This repository already keeps that distinction twice — `recorded_by.kind`
separates an adapter's report from the hub's observation, and `from` / `sent_by`
separates a sender from the socket that carried it. The same reason applies:
evidence of different weight must not become one field.

```
attestation = {
  claimed:  { … Tier 1, salted per-field digests … },   # the agent said so
  observed: { … Tier 2, recorded by the hub … }         # the hub saw it
}
```

A mismatch in `observed` is a strong signal. A mismatch in `claimed` is a weak
one. An operator screen that renders them identically throws away the only
thing that makes the record worth keeping — the same mistake as showing
`rotation` and `compromise` in the same grey badge.

### Send digests, not values, and salt them per field

Registration stores a random salt per identity. Every claim is recorded as
`sha256(salt ‖ field_name ‖ value)`.

Three things follow:

- **The wire never carries hostnames or MACs after registration**, so hub logs
  and the audit trail stop being a lookup table for what to forge. This
  materially changes the insider case above.
- **Per-field digests say which claim moved** — "the address changed, the host
  did not" — without the hub ever holding the value.
- **Full values travel only on mismatch**, when an operator has to see what
  changed and has already been told something is wrong. The exposure is scoped
  to the failure path instead of every request.

The salt is per identity so digests cannot be compared across identities, which
would otherwise reveal that two agents share a host.

### Choose claims that change only when the host does

Anything that moves on its own turns this into a refusal generator, and a
control that cries wolf gets switched off:

| Stable enough | Moves on its own |
|---|---|
| `machine-id`, disk serial, MAC | kernel/OS patch level, uptime, pid |
| container image digest | container instance id, ephemeral port |
| CPU vendor+family | CPU frequency, load, temperature |

Boot id is the interesting middle: it changes on every reboot, which is a
legitimate event, so including it makes reboots require re-approval. Exclude it
unless the deployment genuinely wants that.

### Grade the response by tier

A single `ATTESTATION_CHANGED` for every difference is what makes the
false-positive cost in the dormancy proposal so expensive.

```
observed changed + claimed changed   →  refuse. moved machine, or stolen.
observed changed, claimed same       →  refuse. same claims from a new
                                        address is what a thief looks like.
claimed changed, observed same       →  allow, record, flag. patched, renamed,
                                        or re-imaged in place.
neither                              →  allow.
```

The third row is where most legitimate churn lands, and letting it through
un-blocked is what makes the second row credible enough to act on.

## What this is honestly worth

**It detects a key that went quiet and came back from somewhere else.** Tier 2
carries almost all of that. Tier 1 adds a layer against an unsophisticated
thief and nothing against anyone who has read one attestation — salted digests
narrow that but do not remove it, because the hub must still be told the values
at registration.

If the requirement is to *prevent* key theft rather than notice it, Tier 3 is
the answer and this entire mechanism is a workaround for not having it. Worth
deciding which of the two is actually wanted before the claim set is fixed.

## Open

- **Is the hub behind a proxy in any target deployment?** Decides whether
  Tier 2 exists at all.
- **Prefix, ASN, or exact address**, and whether that is per identity — a
  fixed-VM lane and a laptop lane want different answers.
- **Salt rotation.** The salt is a secret in `agents.db`; if it leaks, so does
  the ability to confirm guessed values by digest.
- **Is any target population Tier 3 capable?** If so, dormancy re-attestation
  should be its fallback path rather than the design centre.

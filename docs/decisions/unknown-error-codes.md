# A code the contract has not heard of — settled design

Status: **decided and implemented.** `errorClassOf` in
`agent-mesh-contracts` (v0.11.0), and the rule in this repository's
[`CLAUDE.md`](../../CLAUDE.md) that a new code goes out before the tag.

Written down because the reversal it records is invisible in the diff. The
earlier choice was deliberate and was argued for; what changed was not the
argument but the conditions under it, and a diff shows neither.

---

## The hazard

Contracts are pinned by tag. So there is always a window between a hub emitting
a code and the other side pinning the tag that names it, and in that window the
receiving side is holding a number with no class attached.

`client-claude` found this rather than either suite. It arrived as a structural
observation about their own retry loop, not as a failure — which is the only way
this was ever going to be found, since inside the window everything reports
success.

## What it does now

```
in-band, unassigned   (-32019)  ->  permanent
out of band           (-32999)  ->  transient
```

`isMeshErrorCode` decides which, from the range in the contract.

**In-band unknown is permanent.** A refusal this mesh means but this pin cannot
name is still a refusal. Retrying it forever converts a categorical "no" into an
indefinite delay, and an indefinite delay reports as healthy: the queue drains,
the loop runs, nothing errors. The failure has no symptom, which is what makes
it expensive.

**Out of band is transient.** Those codes belong to somebody else's vocabulary —
a proxy, a load balancer, a transport. Tearing a lane down over a message this
contract never claimed to understand is acting on an opinion it does not hold.

## What was there before, and why it was defensible

`errorClass(code, "transient")` — one default for everything unknown, on an
asymmetry that was real at the time: a wrong retry is bounded by a backoff
ceiling, a wrong dead-letter needs a person.

Two things moved out from under it.

**Replay.** Once an outbox could be replayed, the quarantine side became
recoverable and the asymmetry stopped being lopsided. The argument had been
written when replay did not exist and was never revisited when it arrived.

**The band distinction is not the call site's to make.** The old shape let the
caller pass a default, which reads like flexibility and is not: *which* codes
are mesh codes is something only the contract knows. The call site was being
handed a decision it had no basis for. Moving it into `errorClassOf` is not a
convenience — it puts the judgement where the information is.

## The rule that follows

A new error code is announced **before** the tag that names it, not after. The
window cannot be closed, but it can be made short and expected rather than
long and silent.

This is symmetric: `client-claude` holds the same rule for any `data.code` or
refusal they introduce. Recorded in both repositories' `CLAUDE.md`.

## Why this file exists at all

The client's note on their own version of this decision is the reason:

> 이전 선택이 의도적이었고 방어까지 했기 때문에, 왜 바뀌었는지가 diff에서는
> 안 보입니다.

A choice nobody argued for leaves a diff that explains itself. One that was
argued for, and then reversed because the ground moved, leaves a diff that looks
like somebody changed their mind — and the next reader re-derives the original
argument, which is still sound in isolation, and changes it back.

# How SPEC 0.2 was built

**Done.** All eight steps shipped; what remained of 0.2 was § 4.1 and § 6.1,
which are lane repository work. This is kept as a record of the order and why
it was that order — the per-step detail it used to carry is now in `SPEC.md`
and in the code, and two copies of a specification is one going stale.

## Dependency shape

```
   1  agents.db + agent_types + agent_keys
      │
      ├──▶ 2  key registration and approval
      │       │
      │       ├──▶ 3  request signatures         ─┐
      │       │                                   │
      │       └──▶ 4  upload authorisation  ──────┤
      │                                           │
      ├──▶ 5  soft delete                         │
      │                                           │
      └──▶ 6  entitlement (proxy_for, from)  ◀────┘
                                                  │
   7  audit.db + mesh.audit.*  ◀──────────────────┘
      │
      └──▶ 8  audit query API
```

Steps 5 and 7 read from the left column but do not depend on 3 or 4. Everything
in the right column depends on there being a verified identity, which is why
signatures come before audit rather than beside it.

---

## What shipped

| | Step | Where it lives now |
|---|------|--------------------|
| 1 | `agents.db`, `agent_types`, `agent_keys` | SPEC § 3.1, § 10.3 |
| 2 | Key registration and approval | § 10.2, § 10.2.1 |
| 3 | Request signatures | § 8.1 |
| 4 | Upload authorisation | § 9.1 |
| 5 | Soft delete | § 9.3 |
| 6 | Entitlement — `proxy_for`, `from` | § 8.2 |
| 7 | `audit.db` and `mesh.audit.*` | § 8.9 |
| 8 | Audit query API | § 9.1 |

Built after the plan closed, on the same foundation: the socketless transport
(§ 8.10), the signed inbox surface (§ 9.2.1), the agent type registry's admin
routes (§ 10.3), and authenticated teardown (§ 9.3).

## What the ordering was for

Signatures before audit, not beside it. An audit trail whose events cannot be
tied to a verified identity records that something happened and not who did it,
and § 8.9.4 keeps the sender's own signature as the attestation — which cannot
exist before there are signatures.

Approval before signatures, for the same reason in miniature: a key that
nothing has approved verifies nothing, so step 3 would have had no state to
check against.

The next increment inherits the shape. Anything that needs to know *who* is
asking sits to the right of step 3, and anything that only needs a row sits to
the left.

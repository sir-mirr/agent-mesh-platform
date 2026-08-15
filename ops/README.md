# Agent-Mesh Ops

Deployment artifacts for the **baseline** — the three services this repository
ships. Lane components live in a separate repository and bring their own units,
env and installer.

## Layout

- `systemd/` — the three baseline units
- `env/shared/` — env examples for hub, http and self-reminder
- `bin/bootstrap-hub-service-identities.sh` — baseline identity provisioning
- `migrations/` — forward-only SQL, operator-applied

## Baseline services

```
packages/shared/hub/src/main.ts             agent-mesh-hub-lab.service
packages/shared/http/src/main.ts            agent-mesh-http-lab.service
packages/shared/self-reminder/src/main.ts   agent-mesh-self-reminder-lab.service
```

`agent-mesh-hub-lab.service` bootstraps baseline service identities through the
canonical `POST /api/v1/agents` endpoint (SPEC § 10.1) once the hub is
listening. Registration stays the single source of truth and no process writes
identity rows by direct SQL. The unversioned `POST /api/agents` remains as a
legacy alias.

The bootstrap script discovers **baseline identities only** — the http server
and the self-reminder daemon. It no longer walks the env tree for lane
identities: hub-direct forwarding is gone (SPEC § 6.1), so a channel-driver
holds no hub identity, and lane components are not deployed from here. A lane
provisions its own identity through the same endpoint, which cross-VM
deployments already did (SPEC § 14.3).

## Lanes

Not here. A lane needs three things from this repository:

1. an identity provisioned via `POST /api/v1/agents` on the hub listener,
2. a public key approved by an operator (SPEC § 10.2), and
3. the hub URL.

See `SPEC.md` §§ 4–6 for the contract a lane implements, and
`docs/decisions/identity-and-authentication.md` for the key lifecycle.

## Storage

SPEC § 3.1 splits hub storage across `agents.db`, `hub.db` and `audit.db` at
0.2. `audit.db` and `uploads/` should sit on a volume separate from the other
two — audit retention is indefinite (SPEC § 15.6), so the disk fills eventually
and message routing must survive it.

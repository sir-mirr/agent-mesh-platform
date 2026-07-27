# Synapse PM autonomy runtime contract

This source contract is for a future Finja-approved C-lane installation only.
This change does not create an OS identity, copy an environment file, install
or start a unit, or connect to a live hub.

## Non-secret environment

Only these two runtime values are read by the outbound notifier:

| Variable | Required fixed contract |
| --- | --- |
| `SYNAPSE_PM_AUTONOMY_HUB_URL` | credential-free `ws://` or `wss://` hub endpoint |
| `SYNAPSE_PM_AUTONOMY_IDENTITY` | exactly `synapse-pm-autonomy` |

The source example is `ops/env/synapse-pm-autonomy.env.example`. It contains no
secret. The notifier connects outbound, sends `mesh.connect` with an empty
`proxy_for`, then sends only `synapse-pm-autonomy → synapse-pm`. It accepts no
inbound mesh command or state transition; any unexpected inbound frame closes
the client connection fail-safe.

## Fixed local resources

- Control socket: `/run/synapse-pm-autonomy/control.sock`
- Dedicated state database: `/var/lib/synapse-pm-autonomy/autonomy.db`
- `self-reminder.db`, self-reminder imports, and self-reminder state are
  absolutely prohibited for this package.

`ops/systemd/synapse-pm-autonomy.service` is uninstalled source only. A future
Finja C-lane action must create the dedicated `synapse-pm-autonomy` OS
user/group and the unit/state/runtime directories. The unit's environment file
contains only the two non-secret values above, uses direct no-shell `ExecStart`,
sets `UMask=0077`, and has `Restart=no`.

## Root-managed deployment preflight (Finja C-lane only)

This is a source-only contract. It does not authorize this repository change to
write `/opt`, install Bun, copy an environment file, install/start/reload a
unit, or provision an identity. Only Finja's separately approved C-lane may
perform those OS actions, and it must preserve `ProtectHome=true`.

Before any such action, Finja performs this ordered, read-only preflight:

1. Verify `/usr/bin/bun` exists as a root-owned, non-symlink regular file and
   has executable mode for `synapse-pm-autonomy`. No `~/.bun`, `/home`, PATH
   lookup, or shell wrapper is allowed.
2. Verify `/opt`, `/opt/agent-mesh-platform`, and each parent of the fixed
   source entrypoint are root-owned, non-symlink directories with traversal
   mode for the dedicated service user. Verify the entrypoint is root-owned,
   non-symlink, regular, and readable by that user.
3. Verify the deployed root-owned tree is the exact reviewed source revision;
   the fixed entrypoint is
   `/opt/agent-mesh-platform/packages/shared/synapse-pm-autonomy/src/main.ts`.
4. Verify the uninstalled source unit retains its direct no-shell
   `/usr/bin/bun` `ExecStart`, fixed `/opt/agent-mesh-platform`
   `WorkingDirectory`, dedicated user/group, non-secret EnvironmentFile,
   RuntimeDirectory/StateDirectory, `UMask=0077`, `ProtectHome=true`, and
   `Restart=no`.
5. Do not copy actual environment values, credentials, or host command output
   into source. Unit installation/start remains excluded here; later Finja
   gate-binary installation, identity provisioning, and canary are separate
   approvals.

`deployment-contract.ts` is the read-only fail-closed verifier for these fixed
paths. Its fixtures cover changed Bun/working-directory unit text and missing,
symlinked, non-root-owned, or inaccessible deployment prerequisites.

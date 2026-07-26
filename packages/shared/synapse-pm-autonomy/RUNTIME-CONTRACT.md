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

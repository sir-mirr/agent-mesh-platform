# Synapse PM autonomy daemon

`synapse-pm-autonomy` is a PM-only process.  It owns its own SQLite file,
local Unix-socket control endpoint, task lifecycle, gate result, and watchdog
state.  It does not read or write `self-reminder.db`, and it never accepts a
mesh inbound command.

## Authority boundary

- The PM dispatcher is the only local caller.  It uses the closed operations
  `create`, `progress`, `gate`, and `complete` over
  `/run/synapse-pm-autonomy/control.sock`.
- The socket lives in a runtime directory owned by the PM service identity and
  is mode `0600`; its resolved parent must be exactly
  `/run/synapse-pm-autonomy`.  Deployment must run the daemon and PM dispatcher
  under the same dedicated OS identity.  No network listener or shared database
  control path exists.
- A caller cannot submit a PASS, artifact reference, shell command, profile,
  or force flag.  `complete` returns `COMPLETION_REJECTED` unless the daemon
  itself ran the fixed KMS gate runner and stored a matching verified artifact.
- The daemon has a separate mesh identity, `synapse-pm-autonomy`.  Its only
  mesh action is outbound `mesh.send` with `from=synapse-pm-autonomy` and
  `to=synapse-pm`; inbound notifications are ignored and no `proxy_for` is
  registered.

## Required deployment inputs (C-lane; not installed by this change)

The deployment owner must provision the service identity in mesh before first
start and supply only these non-secret configuration values:

```
SYNAPSE_PM_AUTONOMY_DB=/var/lib/synapse-pm-autonomy/autonomy.db
SYNAPSE_PM_AUTONOMY_SOCKET=/run/synapse-pm-autonomy/control.sock
SYNAPSE_PM_AUTONOMY_IDENTITY=synapse-pm-autonomy
SYNAPSE_PM_AUTONOMY_HUB_URL=ws://127.0.0.1:3100/ws
SYNAPSE_PM_AUTONOMY_KMS_ROOT=/home/zkrypto/ai/finja/works/kms
SYNAPSE_PM_AUTONOMY_KMS_PYTHON=/home/zkrypto/ai/finja/works/kms/.venv/bin/python
```

Mesh identity provisioning and systemd installation are deliberately deferred
to the deployment approval.  This code does not create an identity, install a
unit, start a daemon, modify self-reminder, or migrate a live database.
The daemon accepts only the exact deployment-owned path
`/var/lib/synapse-pm-autonomy/autonomy.db`, with a real, non-symlink parent/DB
entry, preventing an accidental attachment to `self-reminder.db`.

## Runtime behaviour

The watchdog evaluates active tasks every minute: heartbeat at 15 minutes of
no progress, nudge at 30, and escalation at 45.  Heartbeats do not reset the
progress clock.  Notifications are best-effort outbound messages to PM; they
never change a task's verified status.

## Threat-model checklist

| Threat | Bound / test |
| --- | --- |
| Caller marks a task complete manually | Closed socket protocol has no pass/force operation; `COMPLETION_REJECTED` fixture proves completion fails before daemon gate. |
| Caller injects a shell command or profile | The gate runner uses a fixed argv and only accepts manifests/artifacts below its resolved allowlist roots. |
| Artifact from another task is reused | The daemon validates task id, manifest SHA-256, schema, verified status, and every profile PASS before recording a gate pass. |
| Mesh message controls the daemon | No inbound mesh handler exists; unsolicited mesh events are ignored.  The notifier's target is fixed to `synapse-pm`. |
| Untrusted local process controls the daemon | The control endpoint has no TCP listener and is placed in a PM-owned `0600` runtime socket; deployment must preserve that OS-identity boundary. |
| Progress is faked by watchdog traffic | Heartbeat has a separate timestamp and does not reset `last_progress_at`; watchdog tests cover this invariant. |
| Credential/service installation leaks into A-lane code | Identity provisioning, unit installation, and service start are absent from the package and remain C-lane deployment actions. |

## Rollback

Before the C-lane installation, no runtime state exists.  After installation,
stop and disable only `synapse-pm-autonomy`; retain `autonomy.db` for audit and
remove its socket/runtime directory after the service stops.  This rollback
does not touch the existing self-reminder scheduler or its backup.

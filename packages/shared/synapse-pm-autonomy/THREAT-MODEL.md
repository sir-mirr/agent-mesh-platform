# Synapse PM autonomy A-lane threat model

The package is PM-only and local. It does not import, open, migrate, or schedule `self-reminder.db`.

| Input / asset | Boundary | Enforcement | Fixture |
| --- | --- | --- | --- |
| Unix socket | exact `/run/synapse-pm-autonomy/*.sock` | normalized flat parent + suffix | traversal, prefix-lookalike, nested paths reject |
| Local caller | daemon uid | OS peer credential API; unavailable credential API fails closed | different/null uid rejects |
| Control JSON | `create/progress/gate/complete` only | exact keys and typed leaf values; 4096-byte line cap | nested `pass/force/profile/shell` and oversize line reject |
| KMS gate | fixed argv + manifest allowlist | no shell; manifest lstat/realpath containment | manifest symlink escape rejects before execution |
| Verified artifact | artifact allowlist | exact schema plus task+manifest SHA binding | artifact symlink, other task, wrong SHA reject |
| Database | `synapse-pm-autonomy/autonomy.db` only | exact shape plus lstat checks on DB/parents | outside/self-reminder/symlink reject without tables |
| Completion | daemon evidence only | `COMPLETION_REJECTED` until verified artifact recorded | artifact-less task remains active |
| Mesh | outbound notice only | fixed `synapse-pm-autonomy` → `synapse-pm` notifier interface | watchdog fixture asserts fixed pair |

`complete` never accepts a caller result, profile, artifact, shell, or force field. Gate execution receives only daemon configuration and a task's stored manifest reference. Deployment, identity provisioning, credentials, systemd, and inbound mesh command handling remain out of scope.

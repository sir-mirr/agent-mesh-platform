# Synapse PM autonomy A-lane threat model

The package is PM-only and local. It does not import, open, migrate, or schedule `self-reminder.db`.

| Input / asset | Boundary | Enforcement | Fixture |
| --- | --- | --- | --- |
| Unix socket | exact `/run/synapse-pm-autonomy/*.sock` | normalized flat parent + suffix; before each bind, parent must be an existing physical non-symlink directory owned by the service UID with exact mode 0700 | traversal, prefix-lookalike, nested paths, loose/wrong-owner/non-directory/symlink parents reject |
| Local caller | service-owned UDS namespace | systemd creates the dedicated 0700 RuntimeDirectory and the daemon verifies it before serving; pinned Bun has no supported accepted-socket peer-credential API | actual temporary UDS request succeeds only from a valid 0700 parent; peer UID is neither injected nor claimed |
| Control JSON | `create/progress/gate/complete` only | exact keys and typed leaf values; raw 16,384-byte cap before UTF-8/newline handling | nested `pass/force/profile/shell`, 16,385 bytes, and multi-byte bypass reject |
| KMS gate | fixed argv + manifest allowlist | source-controlled `/usr/local/libexec/synapse-pm-kms-gate verify --profile kms-gate`; no shell or callback; manifest lstat/realpath containment | manifest symlink escape rejects before execution |
| Verified artifact | artifact allowlist | exact schema plus task+manifest SHA binding | artifact symlink, other task, wrong SHA reject |
| Database | `synapse-pm-autonomy/autonomy.db` only | exact shape plus lstat checks on DB/parents | outside/self-reminder/symlink reject without tables |
| Completion | daemon evidence only | `COMPLETION_REJECTED` until verified artifact recorded | artifact-less task remains active |
| Mesh | outbound notice only | fixed `synapse-pm-autonomy` → `synapse-pm` notifier interface | watchdog fixture asserts fixed pair |
| Source verified-done | zero-argument source gate | fixed source manifest, physical artifact root, exclusive mode-0600 artifact creation | fake `git` in `PATH` cannot forge an artifact |

`complete` never accepts a caller result, profile, artifact, shell, or force field. Gate execution receives only daemon configuration and a task's stored manifest reference. The production daemon entrypoint constructs the dedicated store, `FixedPmNotifier`, fixed KMS runner, and UDS server; its control boundary is the verified service-owned UDS directory, not a claimed or unavailable peer UID. Deployment, identity provisioning, credentials, systemd, and inbound mesh command handling remain out of scope.

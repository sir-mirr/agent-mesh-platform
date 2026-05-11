# ops/migrations

Forward-only SQL migrations for `hub.db` (and any future shared SQLite
stores). Filenames follow `NNNN_<short_slug>.sql` with a zero-padded
sequence.

## Policy

- Migrations are **operator-applied**, not auto-applied by the hub binary
  on boot. The hub does carry in-process idempotent guards (e.g.
  `PRAGMA table_info` checks before `ALTER TABLE`) for the cases where
  running an unmigrated DB on a new binary is unavoidable, but those
  guards are a safety net, not a substitute for running these files.
- Migrations are **forward-only**. Authors SHOULD document a rollback
  path in the file header when one exists; if rollback is impractical
  (e.g. dropping a column on SQLite < 3.35), say so explicitly.
- Migrations MUST be **idempotent at the file level** when feasible —
  guard `ALTER TABLE ADD COLUMN` with a `PRAGMA table_info` probe in a
  wrapping script, or wrap the statement in a transaction the operator
  can safely retry on a partial failure.
- Real lane / lab DBs are touched **only by the operator (PM gateway,
  i.e. 본체 아름이 in production, plus the steward via SSH)**. The DBA
  sub-agent track produces the SQL; application is a separate gate.

## Applying

For the lab LXC (`agent-mesh-lab`):

```
lxc exec agent-mesh-lab -- sudo -u ubuntu bash -c \
  "sqlite3 /var/lib/agent-mesh-hub/hub.db < /srv/agent-mesh-platform/ops/migrations/0001_agents_add_created_at.sql"
```

(Adjust the DB path to match `AGENT_MESH_HUB_STATE_DIR` in the lane env
file. For the default systemd unit the state dir is
`/var/lib/agent-mesh-hub`.)

Take a backup first:

```
cp /var/lib/agent-mesh-hub/hub.db /var/lib/agent-mesh-hub/hub.db.bak.$(date +%Y%m%d-%H%M%S)
```

## Index

| File | Summary |
|------|---------|
| `0001_agents_add_created_at.sql` | Adds `agents.created_at DATETIME`, backfills from `last_seen`. Supports SPEC §10.1 strict ISO-8601 `created_at`. |

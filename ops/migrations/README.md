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
  "sqlite3 /srv/agent-mesh-lab/state/shared/hub.db < /srv/agent-mesh-platform/ops/migrations/0001_agents_add_created_at.sql"
```

(Adjust the DB path to match `AGENT_MESH_STATE_DIR` in the hub
service env file — the binary at `packages/shared/hub/src/main.ts`
reads that variable, defaulting to `/srv/agent-mesh-lab/state/shared`.
For deployments that use the legacy `/var/lib/agent-mesh-hub` location
the operator MUST set `AGENT_MESH_STATE_DIR` to match.)

Take a backup first (use the same directory the hub binary opens —
`${AGENT_MESH_STATE_DIR}/hub.db`, default
`/srv/agent-mesh-lab/state/shared/hub.db`).

**Important — WAL mode.** The hub binary opens `hub.db` with
`PRAGMA journal_mode = WAL` enabled (see
`packages/shared/hub/src/main.ts:51`). A naive `cp hub.db ...` while
the hub is running is **not safe** — it can capture an inconsistent
snapshot because committed pages may still live in the sidecar
`hub.db-wal` file (and connection state in `hub.db-shm`) and have not
yet been checkpointed back into the main file. Use one of the two
patterns below.

**Recommended (hub running) — `sqlite3 .backup`.** This is the
SQLite-native online backup API and is safe while the hub is open
on the DB:

```
sqlite3 /srv/agent-mesh-lab/state/shared/hub.db \
  ".backup '/srv/agent-mesh-lab/state/shared/hub.db.bak.$(date +%Y%m%d-%H%M%S)'"
```

The resulting `.bak` file is a single consistent DB image — it does
not need a sidecar `-wal` / `-shm`.

**Alternative (hub stopped) — three-file `cp`.** If the operator is
willing to stop the hub for the backup window, copy all three WAL
files together so the snapshot is self-consistent (note that the
`-wal` and `-shm` sidecars may not exist if the hub has cleanly shut
down and checkpointed — the `2>/dev/null || true` guards that case):

```
sudo systemctl stop agent-mesh-hub
for ext in "" "-wal" "-shm"; do
  cp /srv/agent-mesh-lab/state/shared/hub.db${ext} \
     /srv/agent-mesh-lab/state/shared/hub.db.bak.$(date +%Y%m%d-%H%M%S)${ext} \
     2>/dev/null || true
done
sudo systemctl start agent-mesh-hub
```

Do **not** use a plain `cp hub.db hub.db.bak` while the hub is
running — that is the unsafe pattern documented here only so it can
be recognised and avoided.

## Index

| File | Summary |
|------|---------|
| `0001_agents_add_created_at.sql` | Adds `agents.created_at DATETIME`, backfills from `last_seen`. Supports SPEC §10.1 strict ISO-8601 `created_at`. |

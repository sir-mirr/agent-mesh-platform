# Closed source verified-done gate

Run only from the package script, with no arguments:

```sh
bun run source-verified-done
```

The CLI rejects every extra argument. Its source manifest is the exact
two-key `source-manifest.json` schema (`schema`, `source_files`). Before and
after hashing its allowlisted files it runs these fixed checks through the
documented absolute executable `/usr/bin/git`:

```text
/usr/bin/git rev-parse --verify HEAD
/usr/bin/git status --porcelain=v1 --untracked-files=all
```

Every invocation removes all `GIT_*` variables and replaces `PATH` with
`/usr/bin:/bin`; it never shells out. A clean, unchanged 40-hex revision is
bound into the output together with the source-manifest and checked-file
SHA-256 values. The persistent artifact is created under the ignored local
directory `tmp/synapse-pm-autonomy/source-verified-done/` using an exclusive,
randomized temporary file and a hard-link finalization, mode `0600`.

The artifact is evidence for review only. It neither completes a task nor
starts a daemon or service.

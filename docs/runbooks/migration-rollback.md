# Migration Rollback

## Purpose

Undo the last drizzle/sqlite migration. Read this first: **sqlite has no
down-migrations.** There is no `drizzle down`, no inverse SQL, and
`server/storage.mjs` applies migrations with `db.exec(sql)` inside a
transaction — a _failed_ migration rolls back cleanly, but a _successful_ one
that turns out to be wrong can only be undone by restoring the database from a
backup taken before it ran.

That is the whole procedure. Everything below is making that one fact safe.

## Preconditions

- A pre-migration snapshot exists: `backups/pre-migration-<name>-<stamp>/`
  with `MANIFEST.sha256` and `PRE_MIGRATION_MARKER.txt`. If it does not exist,
  you skipped the mandatory step — take a backup NOW before touching anything
  (data written since cannot be recovered any other way).
- The app is stopped (the rollback replaces the live database file).

## The mandatory pre-migration step (do this BEFORE every migration)

```bash
# Stop writes, snapshot, then apply the migration by starting the app
scripts/ops/pre-migration-backup.sh --migration 0037_ops
# expected: "snapshot OK: backups/pre-migration-0037_ops-<stamp>"
#           plus the exact restore command for the rollback below
```

The script refuses to continue if `backup.sh` fails. If you apply migrations any
other way, you are choosing to have no rollback.

## Exact rollback commands

```bash
# 1. Stop the app — the database file is about to be replaced
pkill -f "next-server"   # or: docker stop hikmah / systemctl stop hikmah

# 2. Restore the pre-migration snapshot over the live data dir
scripts/ops/restore.sh \
  --manifest backups/pre-migration-0037_ops-<stamp>/MANIFEST.sha256 \
  --target-dir "$HIKMAH_DATA_DIR" --force
# expected: checksums OK, integrity_check=ok
# NOTE: this is the one place --force against the live dir is correct.

# 3. Confirm the migration is gone
sqlite3 "$HIKMAH_DATA_DIR/workspace.sqlite" \
  "SELECT name FROM hikmah_migrations WHERE name LIKE '%0037%';"
# expected: no rows

# 4. Restart the app — storage.mjs will NOT re-apply the migration unless the
#    drizzle/*.sql file is still present. Move the bad migration file aside first:
mv drizzle/0037_ops.sql /tmp/quarantine-0037_ops.sql

npm start
curl -fsS http://localhost:3000/api/health   # expected: {"status":"ok", ...}
```

## What about data written after the migration?

It is gone. The restore replaces the whole database file; rows written between
the snapshot and the rollback do not survive. This is the honest cost of
sqlite-without-down-migrations, and it is why the snapshot must be taken
_immediately_ before the migration — not "last night's backup".

## Rollback (of the rollback)

If the restore itself fails verification, `restore.sh` exits non-zero and the
live data dir keeps the post-migration database (the script copies only after
checksums pass). You are then in "migration applied, no good backup" territory:
stop, do not improvise, escalate.

## When to escalate to the owner

- No pre-migration snapshot exists and the migration is already applied.
- `restore.sh` reports a checksum or `integrity_check` failure.
- The app re-applies the bad migration on start (the `.sql` file was not
  quarantined) — stop the app and escalate rather than fighting the loop.
- Any data-loss-vs-downtime tradeoff (e.g. "keep 2h of new rows vs restore"):
  that is the owner's call, not the operator's.

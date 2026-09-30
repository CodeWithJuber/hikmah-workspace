# Backup & Restore

## Purpose

Take a restorable snapshot of everything the deployment cannot regenerate, and
restore one onto a clean host. This is the procedure the migration-rollback and
incident-drill runbooks assume already works.

## What gets backed up

| Item                                             | Location                                     | How                           |
| ------------------------------------------------ | -------------------------------------------- | ----------------------------- |
| Database (incl. the encrypted secret-vault rows) | `$HIKMAH_DATA_DIR/workspace.sqlite`          | `sqlite3 .backup` (live-safe) |
| Uploaded files / generated media                 | `$HIKMAH_DATA_DIR/objects/`                  | `tar.gz` archive              |
| Backup provenance + SHA256 manifest              | `<backup>/MANIFEST.sha256`, `PROVENANCE.txt` | written by `backup.sh`        |

## What does NOT get backed up (say it out loud)

- **`HIKMAH_VAULT_KEY`** — the vault master key lives only in the environment.
  `backup.sh` records whether it was _present_, never its value. Without the same
  key, the restored vault rows do not decrypt. Back the key up separately — see
  `key-recovery.md`.

## Preconditions

- `sqlite3` CLI installed on the host (backup.sh refuses to guess with a live db).
- Disk space ≥ 2× the data dir (backup + safety margin).
- Write access to the backup dir (`HIKMAH_BACKUP_DIR`, default `./backups`).

## Exact commands

```bash
# 1. Take the backup (safe while the app is running — .backup is online-safe)
HIKMAH_DATA_DIR=/path/to/.data HIKMAH_BACKUP_DIR=/path/to/backups \
  scripts/ops/backup.sh

# 2. Off-host copy — the backup is worthless on the same disk as the data.
#    (Destination is the owner's choice; example uses the owner's own host.)
rsync -avz /path/to/backups/ owner@offhost:/srv/hikmah-backups/
```

### Expected output

- `backup.sh` prints `integrity_check=ok`, then a two-line SHA256 manifest and the
  exact restore command. Exit code 0.
- The backup dir contains `workspace.sqlite`, `objects.tar.gz`, `MANIFEST.sha256`,
  `PROVENANCE.txt`.

## Restore onto a clean host (off-host restore procedure)

```bash
# 1. On the clean host: verify the manifest BEFORE trusting anything
sha256sum -c <backup-dir>/MANIFEST.sha256
# expected: "workspace.sqlite: OK", "objects.tar.gz: OK"

# 2. Restore into a fresh data dir (never over the live one first)
scripts/ops/restore.sh --manifest <backup-dir>/MANIFEST.sha256 --target-dir /srv/hikmah/.data-restored
# expected: "integrity_check=ok", tables=<n>, then the post-restore checklist

# 3. Set the SAME HIKMAH_VAULT_KEY as at backup time, start the app pointed at the restore
HIKMAH_DATA_DIR=/srv/hikmah/.data-restored HIKMAH_VAULT_KEY='<same-key>' npm start

# 4. Smoke test
curl -fsS http://localhost:3000/api/health
# expected: {"status":"ok", ...}
```

## Rollback (of the restore itself)

The restore never touches the live data dir unless you point `--target-dir` at
it. If the restored instance misbehaves, stop it and keep serving from the
original data dir — nothing was overwritten, so there is nothing to undo. Delete
the `-restored` dir only after the restored instance passes the smoke test.

## RPO / RTO (stated honestly)

- **RPO: up to 24h** — backups are taken by the owner's cron (see deploy.md); any
  data written after the last successful backup is lost on restore. There is no
  continuous replication.
- **RTO: ~30 minutes** — copy the backup onto the clean host, run restore.sh,
  set the vault key, start, smoke-test. This assumes the backup already exists
  off-host and the vault key is at hand; finding a lost key is unbounded — see
  key-recovery.md.

## When to escalate to the owner

- `integrity_check` fails on the backup itself → do not restore; page the owner.
- The off-host copy has not run in > 26h (`backup_stale` alert fires) → the cron
  or the owner's host is down; owner action.
- Vault key is missing or does not decrypt the restored vault → only the owner
  holds the key backup; stop and escalate.

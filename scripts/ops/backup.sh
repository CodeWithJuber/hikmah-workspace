#!/usr/bin/env bash
# Timestamped backup of the hikmah-workspace deployment state.
#
# Backs up:
#   - <data-dir>/workspace.sqlite  (the database; includes the encrypted secret vault rows)
#   - <data-dir>/objects/          (uploaded files, generated media — tar archive)
# Does NOT back up (and says so loudly):
#   - HIKMAH_VAULT_KEY (the vault master key lives only in the environment;
#     without it the vault rows are unreadable — see docs/runbooks/key-recovery.md)
#
# Method: sqlite3 ".backup" when the CLI exists (safe against a live database);
# falls back to cp only when the app is stopped (--app-stopped), because copying
# a live sqlite file can produce a corrupt backup.
#
# Usage:
#   scripts/ops/backup.sh [--data-dir DIR] [--out-dir DIR] [--label LABEL] [--app-stopped]
# Env: HIKMAH_DATA_DIR, HIKMAH_BACKUP_DIR
#
# Exits 0 on success, non-zero on any failure. NEVER deletes source data.
set -euo pipefail

DATA_DIR="${HIKMAH_DATA_DIR:-.data}"
OUT_DIR="${HIKMAH_BACKUP_DIR:-backups}"
LABEL="${LABEL:-backup}"
APP_STOPPED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --app-stopped) APP_STOPPED=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "backup.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

DB="$DATA_DIR/workspace.sqlite"
OBJECTS="$DATA_DIR/objects"
if [ ! -f "$DB" ]; then
  echo "backup.sh: database not found: $DB" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT_DIR/${LABEL}-${STAMP}"
mkdir -p "$DEST"
chmod 700 "$DEST"

echo "backup.sh: backing up $DB + $OBJECTS -> $DEST"

# 1. Database: online-safe .backup when the CLI is available.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$DEST/workspace.sqlite'"
  echo "backup.sh: database via sqlite3 .backup (live-safe)"
elif [ "$APP_STOPPED" = 1 ]; then
  cp -p "$DB" "$DEST/workspace.sqlite"
  echo "backup.sh: database via cp (app stopped, --app-stopped given)"
else
  echo "backup.sh: sqlite3 CLI not found and app may be running." >&2
  echo "backup.sh: stop the app and re-run with --app-stopped, or install sqlite3." >&2
  exit 1
fi

# 2. Uploaded files / generated media.
if [ -d "$OBJECTS" ]; then
  tar -czf "$DEST/objects.tar.gz" -C "$DATA_DIR" objects
  echo "backup.sh: objects archived"
else
  echo "backup.sh: no objects dir ($OBJECTS) — skipping, this is fine for a fresh deploy"
fi

# 3. Provenance: does the operator have the vault key available?
if [ -n "${HIKMAH_VAULT_KEY:-}" ]; then
  echo "vault_key_present=yes (value NOT recorded)" > "$DEST/PROVENANCE.txt"
else
  echo "vault_key_present=no (WARNING: vault rows are unreadable without HIKMAH_VAULT_KEY)" > "$DEST/PROVENANCE.txt"
fi
{
  echo "label=$LABEL"
  echo "stamp_utc=$STAMP"
  echo "data_dir=$DATA_DIR"
  echo "host=$(hostname)"
  echo "db_sha256=$(sha256sum "$DEST/workspace.sqlite" | cut -d' ' -f1)"
} >> "$DEST/PROVENANCE.txt"

# 4. Verify: the backup database must actually open and pass integrity_check.
VERIFY="$(sqlite3 "$DEST/workspace.sqlite" "PRAGMA integrity_check;" 2>&1 || echo VERIFY_FAILED)"
if [ "$VERIFY" != "ok" ]; then
  echo "backup.sh: backup verification FAILED: $VERIFY" >&2
  exit 1
fi
echo "backup.sh: backup database opens, integrity_check=ok"

# 5. SHA256 manifest (also covers objects.tar.gz when present).
FILES="workspace.sqlite"
if [ -f "$DEST/objects.tar.gz" ]; then FILES="$FILES objects.tar.gz"; fi
(cd "$DEST" && sha256sum $FILES > MANIFEST.sha256)
chmod 600 "$DEST"/MANIFEST.sha256 "$DEST"/PROVENANCE.txt "$DEST"/workspace.sqlite

echo "backup.sh: done. Manifest:"
cat "$DEST/MANIFEST.sha256"
echo "backup.sh: restore with: scripts/ops/restore.sh --manifest $DEST/MANIFEST.sha256 --target-dir <dir>"

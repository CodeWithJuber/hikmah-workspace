#!/usr/bin/env bash
# Mandatory pre-migration snapshot (PR-23 operational readiness).
#
# sqlite has no down-migrations: the ONLY way to roll a migration back is to
# restore the database from a backup taken immediately before the migration ran
# and replay from there. This script is that backup, and the migration-rollback
# runbook (docs/runbooks/migration-rollback.md) requires it before ANY
# migration is applied.
#
# Usage:
#   scripts/ops/pre-migration-backup.sh --migration <name>
#     (e.g. --migration 0037_ops). Forwards --data-dir/--out-dir/--app-stopped
#     to backup.sh.
#
# On success it prints the exact restore command for the rollback runbook and
# writes a MARKER file naming the migration this snapshot precedes.
set -euo pipefail

MIGRATION=""
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --migration) MIGRATION="$2"; shift 2 ;;
    --data-dir|--out-dir) EXTRA_ARGS+=("$1" "$2"); shift 2 ;;
    --app-stopped) EXTRA_ARGS+=("$1"); shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "pre-migration-backup.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$MIGRATION" ]; then
  echo "pre-migration-backup.sh: --migration <name> is required" >&2
  exit 2
fi

OUT_DIR="${HIKMAH_BACKUP_DIR:-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "pre-migration-backup.sh: snapshotting before migration $MIGRATION"
"$SCRIPT_DIR/backup.sh" --label "pre-migration-${MIGRATION}" --out-dir "$OUT_DIR" "${EXTRA_ARGS[@]}"

# backup.sh names the dir <label>-<stamp>; find the newest matching one.
NEWEST="$(ls -dt "$OUT_DIR"/pre-migration-"${MIGRATION}"-* 2>/dev/null | head -1)"
if [ -z "$NEWEST" ] || [ ! -f "$NEWEST/MANIFEST.sha256" ]; then
  echo "pre-migration-backup.sh: backup.sh did not produce a manifest — aborting migration" >&2
  exit 1
fi

echo "migration=$MIGRATION" > "$NEWEST/PRE_MIGRATION_MARKER.txt"
echo "taken_utc=$STAMP" >> "$NEWEST/PRE_MIGRATION_MARKER.txt"
chmod 600 "$NEWEST/PRE_MIGRATION_MARKER.txt"

echo "pre-migration-backup.sh: snapshot OK: $NEWEST"
echo "pre-migration-backup.sh: if the migration must be rolled back, run:"
echo "  scripts/ops/restore.sh --manifest $NEWEST/MANIFEST.sha256 --target-dir \"\$HIKMAH_DATA_DIR\" --force"

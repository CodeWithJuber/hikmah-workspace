#!/usr/bin/env bash
# Restore a hikmah-workspace backup onto a target directory.
#
# Usage:
#   scripts/ops/restore.sh --manifest <dir>/MANIFEST.sha256 --target-dir DIR [--force]
#
# Steps: verify manifest checksums -> copy files into target dir -> verify the
# restored database opens and passes integrity_check -> print post-restore checks.
#
# Safety: refuses to write into a target dir that already contains
# workspace.sqlite unless --force is given. NEVER deletes source data and never
# touches the live data dir unless you point --target-dir at it yourself.
set -euo pipefail

MANIFEST=""
TARGET_DIR=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "restore.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$MANIFEST" ] || [ -z "$TARGET_DIR" ]; then
  echo "restore.sh: --manifest and --target-dir are required" >&2
  exit 2
fi
if [ ! -f "$MANIFEST" ]; then
  echo "restore.sh: manifest not found: $MANIFEST" >&2
  exit 1
fi

SRC_DIR="$(dirname "$MANIFEST")"
if [ -f "$TARGET_DIR/workspace.sqlite" ] && [ "$FORCE" != 1 ]; then
  echo "restore.sh: $TARGET_DIR/workspace.sqlite already exists." >&2
  echo "restore.sh: refusing to overwrite. Re-run with --force if you mean it." >&2
  exit 1
fi

echo "restore.sh: verifying manifest checksums in $SRC_DIR"
(cd "$SRC_DIR" && sha256sum -c "$(basename "$MANIFEST")")
echo "restore.sh: checksums ok"

mkdir -p "$TARGET_DIR"
chmod 700 "$TARGET_DIR"
cp -p "$SRC_DIR/workspace.sqlite" "$TARGET_DIR/workspace.sqlite"
if [ -f "$SRC_DIR/objects.tar.gz" ]; then
  tar -xzf "$SRC_DIR/objects.tar.gz" -C "$TARGET_DIR"
  echo "restore.sh: objects restored"
fi
chmod 600 "$TARGET_DIR/workspace.sqlite"

echo "restore.sh: verifying restored database"
VERIFY="$(sqlite3 "$TARGET_DIR/workspace.sqlite" "PRAGMA integrity_check;" 2>&1 || echo VERIFY_FAILED)"
if [ "$VERIFY" != "ok" ]; then
  echo "restore.sh: restored database verification FAILED: $VERIFY" >&2
  exit 1
fi
TABLES="$(sqlite3 "$TARGET_DIR/workspace.sqlite" "SELECT count(*) FROM sqlite_master WHERE type='table';")"
echo "restore.sh: integrity_check=ok, tables=$TABLES"

if [ -f "$SRC_DIR/PROVENANCE.txt" ]; then
  echo "restore.sh: backup provenance:"
  cat "$SRC_DIR/PROVENANCE.txt"
fi

cat <<EOF
restore.sh: done. Post-restore checks (do these before pointing the app at it):
  1. HIKMAH_VAULT_KEY must be the SAME key as at backup time, or the secret
     vault rows will not decrypt (see docs/runbooks/key-recovery.md).
  2. Start the app with HIKMAH_DATA_DIR=$TARGET_DIR and run the smoke test:
     curl -fsS http://localhost:3000/api/health
  3. Confirm migrations: sqlite3 $TARGET_DIR/workspace.sqlite "SELECT name FROM hikmah_migrations ORDER BY name DESC LIMIT 3;"
EOF

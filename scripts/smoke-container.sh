#!/usr/bin/env bash
set -euo pipefail
umask 077
image=${1:?Pass the image tag}
temporary=$(mktemp -d)
container="hikmah-smoke-$RANDOM"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; sudo rm -rf "$temporary"; }
trap cleanup EXIT
mkdir "$temporary/data"
export SMOKE_URL=http://127.0.0.1:3210
export SMOKE_EMAIL=owner@example.test
export SMOKE_PASSWORD
SMOKE_PASSWORD=$(openssl rand -hex 24)
export SMOKE_COOKIE_FILE="$temporary/session"
printf '%s' "$SMOKE_PASSWORD" > "$temporary/data/bootstrap-owner-password"
sudo chown -R 1000:1000 "$temporary/data"
session_secret=$(openssl rand -hex 32)
# The provider key is never used — nothing here reaches a provider. It is set
# because a run against a hosted provider with no key is now refused up front,
# which turned these assertions into a test of the refusal rather than of the
# run lifecycle they exist for.
docker run -d --name "$container" -p 127.0.0.1:3210:3000 \
  --mount "type=bind,source=$temporary/data,target=/data" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000 \
  --tmpfs /app/.next/cache:rw,noexec,nosuid,size=64m,uid=1000,gid=1000 \
  --cap-drop=ALL --security-opt=no-new-privileges --memory=1g --pids-limit=256 \
  -e BETTER_AUTH_URL="$SMOKE_URL" -e BETTER_AUTH_SECRET="$session_secret" \
  -e HIKMAH_OWNER_EMAIL="$SMOKE_EMAIL" \
  -e HIKMAH_PROVIDER_KEY=smoke-provider-key "$image" >/dev/null
node scripts/smoke-http.mjs write
docker restart -t 15 "$container" >/dev/null
node scripts/smoke-http.mjs read

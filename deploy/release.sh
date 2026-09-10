#!/usr/bin/env bash
set -euo pipefail
umask 077
revision=${1:?Pass the full commit SHA}
[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release revision.' >&2; exit 1; }
cd /opt/hikmah
exec 8>deploy.lock
flock -w 300 8
package="incoming/$revision"
[[ -f "$package/image.tar.gz" && -f "$package/image.sha256" ]] || { echo 'Release artifact missing.' >&2; exit 1; }
(cd "$package" && sha256sum --check image.sha256)
gzip -dc "$package/image.tar.gz" | docker load
image="hikmah-workspace:$revision"
[[ $(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image") == "$revision" ]] || { echo 'Image revision mismatch.' >&2; exit 1; }
compose=(docker compose --env-file .env --env-file release.env -f compose.yml)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous=false
backup="backups/pre-$stamp.tar.gz"
if [[ -f release.env && -f compose.yml ]]; then
  previous=true
  "${compose[@]}" stop -t 30 caddy app
  if ! tar -czf "$backup" .env release.env compose.yml Caddyfile data; then
    "${compose[@]}" up -d --wait --wait-timeout 120
    echo 'Backup failed; previous release restarted.' >&2
    exit 1
  fi
fi
rollback() {
  trap - ERR
  echo 'Deployment failed. Restoring the previous release when available.' >&2
  if [[ -f release.env && -f compose.yml ]]; then "${compose[@]}" stop -t 15 caddy app || true; fi
  if $previous && [[ -f "$backup" ]]; then
    mv data "data-failed-$stamp"
    tar -xzf "$backup"
    "${compose[@]}" up -d --wait --wait-timeout 120 || true
  fi
  exit 1
}
trap rollback ERR
python3 "$package/configure.py" "$package/config.json"
cp "$package/compose.yml" compose.yml
cp "$package/Caddyfile" Caddyfile
printf 'HIKMAH_IMAGE=%s\n' "$image" > release.env
"${compose[@]}" up -d app --wait --wait-timeout 120
actual=$("${compose[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(x=>console.log(x.revision))")
[[ "$actual" == "$revision" ]]
"${compose[@]}" up -d caddy --wait --wait-timeout 120
trap - ERR
printf '%s\n' "$revision" > DEPLOYED_REVISION
rm "$package/image.tar.gz"
echo "Hikmah revision $revision is healthy. Verify the public HTTPS URL next."

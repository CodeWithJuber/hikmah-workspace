#!/usr/bin/env bash
set -euo pipefail
umask 077
revision=${1:?Pass the full commit SHA}
[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release revision.' >&2; exit 1; }
cd /opt/hikmah
exec 8>deploy.lock
flock -w 300 8
package="incoming/$revision"
[[ -f "$package/image.tar.gz" && -f "$package/workbench.tar.gz" && -f "$package/image.sha256" ]] || { echo 'Release artifact missing.' >&2; exit 1; }
(cd "$package" && sha256sum --check image.sha256)
# Old releases pile up: every deploy loads two images and leaves a snapshot, and
# a failed one also leaves its package and a copy of the data directory. Nothing
# removed any of it, and a host that runs out of disk stops the app at boot with
# the same symptom as a broken release. Kept: the images of the release that is
# running (a rollback needs them) and of this one, the five newest snapshots and
# the three newest failed-data copies. Only Hikmah's own image tags are touched;
# shared images and volumes are not.
tidy() {
  local keep=("$revision") tag kept value
  if [[ -f DEPLOYED_REVISION ]]; then keep+=("$(cat DEPLOYED_REVISION)"); fi
  if [[ -f release.env ]]; then
    while IFS='=' read -r _ value; do keep+=("${value##*:}"); done < release.env
  fi
  for tag in $(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter reference=hikmah-workspace --filter reference=hikmah-workbench); do
    kept=false
    for value in "${keep[@]}"; do [[ $tag == *":$value" ]] && kept=true; done
    if ! $kept; then docker image rm "$tag" >/dev/null || true; fi
  done
  find incoming -mindepth 1 -maxdepth 1 -type d ! -name "$revision" -exec rm -rf {} + 2>/dev/null || true
  local spec count path paths
  for spec in '5 backups/pre-*.tar.gz' '3 data-failed-*' '3 workbench-data-failed-*'; do
    set -- $spec
    count=$1
    shift
    paths=()
    for path in "$@"; do
      if [[ -e $path ]]; then paths+=("$path"); fi
    done
    if [[ ${#paths[@]} -gt $count ]]; then ls -dt "${paths[@]}" | tail -n +"$((count + 1))" | xargs -r rm -rf; fi
  done
}
tidy || true
df -h /opt/hikmah /var/lib/docker 2>/dev/null | uniq || true
gzip -dc "$package/image.tar.gz" | docker load
gzip -dc "$package/workbench.tar.gz" | docker load
image="hikmah-workspace:$revision"
workbench="hikmah-workbench:$revision"
label='{{ index .Config.Labels "org.opencontainers.image.revision" }}'
for candidate in "$image" "$workbench"; do
  [[ $(docker image inspect --format "$label" "$candidate") == "$revision" ]] || { echo "Image revision mismatch: $candidate" >&2; exit 1; }
done
compose=(docker compose --env-file .env --env-file release.env -f compose.yml)
# Stop only what the compose file on disk defines.
#
# That file is still the PREVIOUS release's until it is copied below, so a
# release that adds a service must not name it here: `docker compose stop`
# rejects the whole command with "no such service" before doing anything, and
# the first upgrade to such a release fails before it has begun. Copying the new
# compose file earlier is not the fix — the backup tars compose.yml, so the
# snapshot would capture the new one and a rollback would restore the wrong file.
stop_present() {
  local timeout=$1; shift
  local defined present=()
  defined=$("${compose[@]}" config --services 2>/dev/null || true)
  for name in "$@"; do
    if grep -qx -- "$name" <<< "$defined"; then present+=("$name"); fi
  done
  if [[ ${#present[@]} -gt 0 ]]; then "${compose[@]}" stop -t "$timeout" "${present[@]}"; fi
}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous=false
backup="backups/pre-$stamp.tar.gz"
# Caddy is never stopped for the snapshot. It used to be, first thing, and
# started again last, so every release was several minutes of "connection
# refused" for everyone. It stays up: the app is stopped under it for the
# snapshot and recreated under it, and the Caddyfile has it hold a request
# while the app is away rather than fail it (lb_try_duration). Caddy does get
# stopped and recreated near the end of this script — after the new app is
# verified healthy — because Docker releases a removed container's ports
# asynchronously and an in-place recreate can hit "port is already allocated".
if [[ -f release.env && -f compose.yml ]]; then
  previous=true
  stop_present 30 app workbench
  mkdir -p workbench-data
  if ! tar -czf "$backup" .env release.env compose.yml Caddyfile data workbench-data; then
    "${compose[@]}" up -d --wait --wait-timeout 120
    echo 'Backup failed; previous release restarted.' >&2
    exit 1
  fi
fi
# What the operator would otherwise have to SSH in for: the app's own last
# lines, how its process ended, and whether the host has run out of disk or
# memory. Printed before the containers are recreated, which discards them.
diagnose() {
  echo "--- $1 ---" >&2
  "${compose[@]}" ps -a >&2 || true
  docker inspect --format 'app: exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' hikmah-app-1 >&2 || true
  "${compose[@]}" logs --no-color --tail 60 app >&2 || true
  df -h /opt/hikmah /var/lib/docker 2>/dev/null | uniq >&2 || true
  free -m >&2 || true
}
rollback() {
  trap - ERR
  echo 'Deployment failed. Restoring the previous release when available.' >&2
  diagnose 'the release that failed'
  if [[ -f release.env && -f compose.yml ]]; then stop_present 15 app workbench || true; fi
  if $previous && [[ -f "$backup" ]]; then
    mv data "data-failed-$stamp"
    if [[ -d workbench-data ]]; then mv workbench-data "workbench-data-failed-$stamp"; fi
    tar -xzf "$backup"
    # The restored Caddyfile is a new file, which a running Caddy's bind
    # mount cannot see; a recreate takes seconds.
    if ! "${compose[@]}" up -d --wait --wait-timeout 120 || ! "${compose[@]}" up -d --force-recreate --wait --wait-timeout 120 caddy; then
      diagnose 'the previous release, which failed to restart'
      echo 'Both releases fail to start, so the cause is on the host rather than in the image. See the app log above.' >&2
    fi
  fi
  exit 1
}
trap rollback ERR
python3 "$package/configure.py" "$package/config.json"
cp "$package/compose.yml" compose.yml
cp "$package/Caddyfile" Caddyfile
printf 'HIKMAH_IMAGE=%s\nHIKMAH_WORKBENCH_IMAGE=%s\n' "$image" "$workbench" > release.env
# The workspace volume belongs to the workbench's unprivileged user, and a
# fresh directory would otherwise be created root-owned by the daemon.
# root:root, not 1000:1000. The supervisor creates each account's directory
# under this at that account's own uid; it is no longer one directory one user
# writes to. See workbench/src/slots.ts.
mkdir -p workbench-data && chown 0:0 workbench-data && chmod 0755 workbench-data
"${compose[@]}" up -d app workbench --wait --wait-timeout 120
actual=$("${compose[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(x=>console.log(x.revision))")
[[ "$actual" == "$revision" ]]
# Caddy's host ports are operator-configurable (HIKMAH_HTTP_BIND /
# HIKMAH_HTTPS_BIND) so this stack can sit behind an outer proxy that owns
# 80/443. When its service definition changed, `up -d` recreates it in one
# step — but the new container can fail with "port is already allocated"
# because Docker releases the old container's ports asynchronously after
# removal. Stop Caddy explicitly and wait for the ports it ACTUALLY binds to
# clear before bringing it back up.
bind_port() {
  local key=$1 value
  value=$(grep -hE "^$key=" .env release.env 2>/dev/null | tail -1 | cut -d= -f2-)
  [[ $value =~ ^[0-9]+$ ]] || value=''
  printf '%s' "$value"
}
http_port=$(bind_port HIKMAH_HTTP_BIND); http_port=${http_port:-80}
https_port=$(bind_port HIKMAH_HTTPS_BIND); https_port=${https_port:-443}
"${compose[@]}" stop -t 30 caddy 2>/dev/null || true
"${compose[@]}" rm -f caddy 2>/dev/null || true
ports_clear() {
  ! ss -H -ltn "( sport = :$http_port or sport = :$https_port )" | grep -q .
}
for _ in $(seq 1 30); do
  ports_clear && break
  sleep 1
done
if ! ports_clear; then
  # Put the edge back before letting the ERR trap roll the release back: an
  # explicit `exit` here would skip the trap and leave the site without its
  # Caddy exactly as the app behind it comes healthy.
  "${compose[@]}" up -d caddy --wait --wait-timeout 120 || true
  echo "Ports $http_port/$https_port are still occupied after stopping our Caddy. Not taking over an unrelated service." >&2
  false
fi
"${compose[@]}" up -d caddy --wait --wait-timeout 120
"${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile
trap - ERR
printf '%s\n' "$revision" > DEPLOYED_REVISION
rm "$package/image.tar.gz" "$package/workbench.tar.gz"
echo "Hikmah revision $revision is healthy. Verify the public HTTPS URL next."

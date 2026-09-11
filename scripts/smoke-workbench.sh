#!/usr/bin/env bash
# The workbench hands out shells, so the image is checked for the two things
# that would be catastrophic to get wrong: that it refuses HTTP without the
# shared token, and that it runs as a normal user rather than root.
set -euo pipefail
umask 077
image=${1:?Pass the workbench image tag}
container="hikmah-workbench-smoke-$RANDOM"
token=$(openssl rand -hex 32)
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" -p 127.0.0.1:3211:3001 \
  --cap-drop=ALL --security-opt=no-new-privileges --memory=512m --pids-limit=256 \
  -e HIKMAH_WORKBENCH_TOKEN="$token" -e HIKMAH_APP_ORIGIN=http://localhost:3000 \
  "$image" >/dev/null

for attempt in {1..30}; do
  status=$(docker inspect --format '{{ .State.Health.Status }}' "$container" 2>/dev/null || echo starting)
  [[ $status == healthy ]] && break
  [[ $status == unhealthy ]] && { docker logs "$container"; echo 'The workbench never became healthy.' >&2; exit 1; }
  sleep 2
done
[[ ${status:-} == healthy ]] || { docker logs "$container"; echo 'The workbench did not start in time.' >&2; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3211/health)
[[ $code == 401 ]] || { echo "An unauthenticated request got $code, expected 401." >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer wrong-$token" http://127.0.0.1:3211/health)
[[ $code == 401 ]] || { echo "A wrong token got $code, expected 401." >&2; exit 1; }
curl -sf -H "authorization: Bearer $token" http://127.0.0.1:3211/health | grep -q '"status":"ok"'

# A root shell would defeat cap_drop and no-new-privileges alike.
user=$(docker exec "$container" id -un)
[[ $user == node ]] || { echo "The workbench runs as $user, expected node." >&2; exit 1; }
# The shell the terminal opens must be able to write where it starts.
docker exec "$container" sh -c 'touch /workspace/.smoke && rm /workspace/.smoke'
echo 'The workbench image starts, demands its token and runs unprivileged.'

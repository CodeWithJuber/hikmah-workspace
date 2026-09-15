#!/usr/bin/env bash
# The workbench hands out shells, so the image is checked for the things that
# would be catastrophic to get wrong.
#
# This is also where the *kernel-level* half of per-user isolation is proved.
# The unit tests inject the filesystem calls, because CI does not run as root
# and chown would fail for reasons that have nothing to do with the code — so
# they can only show the bookkeeping. Whether slot A can actually read slot B is
# a question about uids and directory modes, and only a real container can
# answer it. That is what runs here.
set -euo pipefail
umask 077
image=${1:?Pass the workbench image tag}
container="hikmah-workbench-smoke-$RANDOM"
token=$(openssl rand -hex 32)
volume="hikmah-workbench-smoke-$RANDOM-data"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "$1" >&2; exit 1; }

# Seed a pre-slots workspace: files at the top of the volume owned by the uid
# the old image used. The migration has to move these into the owner's slot, or
# an existing deployment upgrades into a read-only workspace.
#
# The CONTENTS are uid 1000; the volume root stays root-owned, which is exactly
# what deploy/release.sh leaves behind (`chown 0:0 workbench-data`). That
# distinction is not cosmetic: the supervisor holds CHOWN but not DAC_OVERRIDE,
# so if the root of the volume belonged to uid 1000 it could not create the
# slot parent inside it, no slot would resolve, and nothing would migrate.
#
# Four shapes, because each one fails differently and a loose file — the easiest
# case — is the only one that ever worked by accident:
#   notes.md   a loose file; moves with no ceremony
#   project/   a directory owned by someone else. Renaming a directory rewrites
#              its `..`, so the kernel wants write permission on the directory
#              ITSELF, which the supervisor does not have. CI saw exactly this:
#              notes.md arrived in the slot and project/ did not.
#   readonly/  the same, with no owner-write bit either, so taking ownership is
#              not enough on its own.
#   link       a symlink out of the workspace. chown follows symlinks; if this
#              migration used it instead of lchown, /etc/passwd would be handed
#              to a slot user by the one part of the service that runs as root.
docker volume create "$volume" >/dev/null
docker run --rm -v "$volume":/workspace --user 0:0 "$image" \
  sh -c 'mkdir -p /workspace/project /workspace/readonly &&
         echo mine > /workspace/notes.md &&
         echo "export {}" > /workspace/project/app.ts &&
         echo locked > /workspace/readonly/file.txt &&
         ln -s /etc/passwd /workspace/link &&
         chown -R 1000:1000 /workspace/notes.md /workspace/project /workspace/readonly &&
         chown -h 1000:1000 /workspace/link &&
         chmod 0555 /workspace/readonly &&
         chown 0:0 /workspace && chmod 0755 /workspace' >/dev/null


# Exactly the grant deploy/compose.yml gives: root, so it can drop to a slot
# uid, and nothing else — notably no DAC_OVERRIDE.
docker run -d --name "$container" -p 127.0.0.1:3211:3001 \
  --user 0:0 --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID --cap-add=CHOWN \
  --security-opt=no-new-privileges --memory=640m --pids-limit=512 \
  -v "$volume":/workspace \
  -e HIKMAH_WORKBENCH_TOKEN="$token" -e HIKMAH_APP_ORIGIN=http://localhost:3000 \
  "$image" >/dev/null

for attempt in {1..30}; do
  status=$(docker inspect --format '{{ .State.Health.Status }}' "$container" 2>/dev/null || echo starting)
  [[ $status == healthy ]] && break
  [[ $status == unhealthy ]] && { docker logs "$container"; fail 'The workbench never became healthy.'; }
  sleep 2
done
[[ ${status:-} == healthy ]] || { docker logs "$container"; fail 'The workbench did not start in time.'; }

# --- the token still gates everything ------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3211/health)
[[ $code == 401 ]] || fail "An unauthenticated request got $code, expected 401."
code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer wrong-$token" http://127.0.0.1:3211/health)
[[ $code == 401 ]] || fail "A wrong token got $code, expected 401."
curl -sf -H "authorization: Bearer $token" http://127.0.0.1:3211/health | grep -q '"status":"ok"'

# --- the one-time migration ----------------------------------------------
# It runs when the first slot is assigned, not at boot, so a run has to happen
# first. That is also the real code path: the app posts exactly this.
user_key=$(printf 'o%.0s' $(seq 1 32))
run_reply=$(curl -s -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"tool\":\"bash\",\"sessionId\":\"smoke\",\"userKey\":\"$user_key\",\"command\":\"pwd\"}" \
  http://127.0.0.1:3211/runs)
# The owner's files are in the owner's slot and owned by it. On failure, say
# what the run itself answered and what the service logged — the first version
# of this check printed neither, and "not migrated" on its own says nothing
# about which of the four steps did not happen.
docker exec "$container" test -f "/workspace/u/hk01/notes.md" || {
  echo "--- the run replied ---"; echo "$run_reply"
  echo "--- the volume holds ---"; docker exec "$container" ls -la /workspace /workspace/u 2>&1 || true
  echo "--- the service logged ---"; docker logs "$container"
  fail 'The existing workspace was not migrated into the owner slot.'
}
docker exec "$container" test -f "/workspace/u/hk01/project/app.ts" \
  || fail 'The migration did not carry nested directories.'
docker exec "$container" test -f /workspace/u/hk01/readonly/file.txt \
  || fail 'The migration left behind a directory its owner had made read-only.'
docker exec "$container" test -L /workspace/u/hk01/link \
  || fail 'The migration did not carry a symlink, or replaced it with its target.'
passwd_uid=$(docker exec "$container" stat -c '%u' /etc/passwd)
[[ $passwd_uid == 0 ]] \
  || fail "The migration followed a symlink: /etc/passwd is now owned by $passwd_uid."
docker exec "$container" test -e /workspace/notes.md \
  && fail 'The migration left a copy at the top of the volume.'
owner_uid=$(docker exec "$container" stat -c '%u' /workspace/u/hk01/notes.md)
[[ $owner_uid == 3001 ]] || fail "Migrated files are owned by $owner_uid, expected the slot uid 3001."
# One level down, specifically. Re-owning the slot directory is the last thing
# the supervisor can do to it — after that it cannot even list it — so a walk
# that starts at the top re-owns nothing inside and says nothing about it.
nested_uid=$(docker exec "$container" stat -c '%u' /workspace/u/hk01/project/app.ts)
[[ $nested_uid == 3001 ]] \
  || fail "A migrated file inside a folder is owned by $nested_uid: the re-own stopped at the top."
locked_uid=$(docker exec "$container" stat -c '%u' /workspace/u/hk01/readonly)
[[ $locked_uid == 3001 ]] || fail "The read-only directory is still owned by $locked_uid."

# --- the slot users exist and the service's source is beyond them ---------
docker exec "$container" id hk01 >/dev/null || fail 'The image has no slot users.'
docker exec "$container" id hk32 >/dev/null || fail 'The slot pool is smaller than the code expects.'
if docker exec --user 3001 "$container" sh -c 'echo pwned >> /workbench/src/server.ts' 2>/dev/null; then
  fail 'A slot user can rewrite the service source and own it on the next restart.'
fi

# --- the boundary itself: slot A cannot reach slot B ----------------------
# Two real uids, two real 0700 directories, one real kernel.
docker exec --user 0:0 "$container" sh -c \
  'mkdir -p /workspace/u/hk02 && echo secret > /workspace/u/hk02/theirs.txt &&
   chown -R 3002:3002 /workspace/u/hk02 && chmod 0700 /workspace/u/hk02 &&
   chmod 0600 /workspace/u/hk02/theirs.txt'
if docker exec --user 3001 "$container" cat /workspace/u/hk02/theirs.txt 2>/dev/null; then
  fail 'Slot hk01 can read slot hk02. The directories are not a boundary.'
fi
if docker exec --user 3001 "$container" sh -c 'touch /workspace/u/hk02/planted' 2>/dev/null; then
  fail 'Slot hk01 can write into slot hk02.'
fi
# And the supervisor, though uid 0, cannot either — that is what makes running
# it as root acceptable at all.
if docker exec --user 0:0 "$container" cat /workspace/u/hk02/theirs.txt 2>/dev/null; then
  fail 'The supervisor can read a slot user files; DAC_OVERRIDE was not dropped.'
fi

# --- the wrapper applies bounds a command cannot raise --------------------
limits=$(docker exec --user 3001 "$container" /usr/local/bin/hikmah-run /workspace/u/hk01 \
  'ulimit -t; ulimit -u; ulimit -f; ulimit -n; ulimit -c' | tr -d ' ' | paste -sd/)
[[ $limits == '150/96/2097152/256/0' ]] || fail "hikmah-run applied $limits, expected 150/96/2097152/256/0."
raised=$(docker exec --user 3001 "$container" /usr/local/bin/hikmah-run /workspace/u/hk01 \
  'ulimit -t 600 2>&1; ulimit -t' | tr -d ' ' | tr '\n' ' ')
[[ $raised == *"150"* ]] || fail "A command raised its own CPU limit: $raised"
# The wrapper cds after dropping, so it cannot be aimed at another slot.
if docker exec --user 3001 "$container" /usr/local/bin/hikmah-run /workspace/u/hk02 'pwd' 2>/dev/null; then
  fail 'A command can be started inside another account slot.'
fi
# sandbox_run needs node to start under those bounds; this is why there is no
# `ulimit -v` (see workbench/bin/hikmah-run).
docker exec --user 3001 "$container" /usr/local/bin/hikmah-run /workspace/u/hk01 \
  'node -e "process.exit(0)"' || fail 'node cannot start under the wrapper, so sandbox_run is broken.'

# --- the migration is idempotent ------------------------------------------
docker restart "$container" >/dev/null
for attempt in {1..30}; do
  status=$(docker inspect --format '{{ .State.Health.Status }}' "$container" 2>/dev/null || echo starting)
  [[ $status == healthy ]] && break
  sleep 2
done
[[ ${status:-} == healthy ]] || { docker logs "$container"; fail 'The workbench did not come back after a restart.'; }
# A second run, after a restart, must find the same slot and move nothing.
curl -s -o /dev/null -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"tool\":\"bash\",\"sessionId\":\"smoke2\",\"userKey\":\"$user_key\",\"command\":\"pwd\"}" \
  http://127.0.0.1:3211/runs
docker exec "$container" test -f /workspace/u/hk01/notes.md \
  || fail 'A second run moved the migrated files again.'
docker exec "$container" test -e /workspace/u/hk01/u \
  && fail 'A second run moved the slot directory into itself.'
docker exec "$container" test -e /workspace/u/hk01/hk01 \
  && fail 'A second run moved the slot into itself.'

echo 'The workbench image starts, demands its token, keeps one account out of another, and migrates once.'

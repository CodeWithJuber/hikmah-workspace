#!/usr/bin/env bash
set -euo pipefail
umask 077
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_KNOWN_HOSTS HIKMAH_DOMAIN HIKMAH_OWNER_EMAIL HIKMAH_SESSION_SECRET; do
  [[ -n ${!name:-} ]] || { echo "Missing Actions setting: $name" >&2; exit 1; }
done
[[ $DEPLOY_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $DEPLOY_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid SSH host or user.' >&2; exit 1; }
port=${DEPLOY_PORT:-22}
[[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port>0 && 10#$port<65536)) || { echo 'Invalid SSH port.' >&2; exit 1; }
[[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ ]] || exit 1
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$temporary/known_hosts"
options=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$temporary/known_hosts" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
prefix=()
if [[ -n ${DEPLOY_SSH_KEY:-} ]]; then
  printf '%s\n' "$DEPLOY_SSH_KEY" > "$temporary/key"
  options+=(-o BatchMode=yes -i "$temporary/key")
elif [[ -n ${DEPLOY_SSH_PASSWORD:-} ]]; then
  command -v sshpass >/dev/null || { echo 'Install sshpass on the Actions runner for password deployment.' >&2; exit 1; }
  export SSHPASS="$DEPLOY_SSH_PASSWORD"
  prefix=(sshpass -e)
else
  echo 'Set DEPLOY_SSH_KEY or DEPLOY_SSH_PASSWORD as an Actions secret.' >&2; exit 1
fi
destination="$DEPLOY_USER@$DEPLOY_HOST"
remote() { "${prefix[@]}" ssh "${options[@]}" -p "$port" "$destination" "$@"; }
copy() { "${prefix[@]}" scp "${options[@]}" -P "$port" "$@"; }
python3 - "$temporary/config.json" <<'PY'
import json, os, sys
from pathlib import Path
sys.path.insert(0,'deploy')
from configure import validate
value={name:os.environ.get(env,'') for name,env in [('domain','HIKMAH_DOMAIN'),('owner_email','HIKMAH_OWNER_EMAIL'),('session_secret','HIKMAH_SESSION_SECRET'),('owner_password','HIKMAH_OWNER_PASSWORD')]}
validate(value)
Path(sys.argv[1]).write_text(json.dumps(value))
PY
remote 'install -d -m 700 /opt/hikmah /opt/hikmah/incoming'
copy deploy/bootstrap.sh "$destination:/opt/hikmah/incoming/bootstrap.sh"
remote 'bash /opt/hikmah/incoming/bootstrap.sh'
remote "install -d -m 700 /opt/hikmah/incoming/$GITHUB_SHA"

copy deploy/compose.yml deploy/Caddyfile deploy/configure.py deploy/release.sh \
  artifact/image.tar.gz artifact/image.sha256 "$temporary/config.json" "$destination:/opt/hikmah/incoming/$GITHUB_SHA/"
remote "bash /opt/hikmah/incoming/$GITHUB_SHA/release.sh $GITHUB_SHA"
for attempt in {1..30}; do
  if curl --fail --silent --show-error --max-time 10 --proto '=https' "https://$HIKMAH_DOMAIN/api/health" > "$temporary/health.json"; then
    if python3 - "$temporary/health.json" <<'PY'
import json,os,sys
value=json.load(open(sys.argv[1]))
assert value.get('status')=='ok' and value.get('revision')==os.environ['GITHUB_SHA']
print('Public HTTPS health check passed for the exact deployed commit.')
PY
    then exit 0; fi
  fi
  sleep 2
done
echo 'The container was deployed, but public HTTPS verification failed. Check DNS and ports 80/443.' >&2
exit 1

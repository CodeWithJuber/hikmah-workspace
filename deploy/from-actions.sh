#!/usr/bin/env bash
# Ship the verified image pair to the server over SSH and check it through the
# public HTTPS URL. Runs on a GitHub-hosted runner (deploy.yml): it reaches the
# server like any other client, with a deploy key only and a pinned host key.
set -euo pipefail
umask 077
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_KNOWN_HOSTS DEPLOY_SSH_KEY HIKMAH_DOMAIN HIKMAH_OWNER_EMAIL HIKMAH_SESSION_SECRET; do
  [[ -n ${!name:-} ]] || { echo "Missing Actions setting: $name" >&2; exit 1; }
done
[[ $DEPLOY_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $DEPLOY_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid SSH host or user.' >&2; exit 1; }
# The runner is not the server: a loopback address would point back at the runner.
if [[ ${DEPLOY_HOST,,} =~ ^(localhost|.*\.localhost|127\.[0-9.]+|0\.0\.0\.0)$ ]]; then
  echo 'DEPLOY_HOST must be the public address of the server, not a loopback address.' >&2; exit 1
fi
port=${DEPLOY_PORT:-22}
if ! [[ $port =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
  echo 'Invalid SSH port.' >&2; exit 1
fi
[[ ${DEPLOY_SHA:-} =~ ^[a-f0-9]{40}$ ]] || { echo 'DEPLOY_SHA must be the full verified commit SHA.' >&2; exit 1; }
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$temporary/known_hosts"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$temporary/key"
options=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$temporary/known_hosts" -o BatchMode=yes
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o IdentitiesOnly=yes -i "$temporary/key"
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
destination="$DEPLOY_USER@$DEPLOY_HOST"
remote() { ssh "${options[@]}" -p "$port" "$destination" "$@"; }
copy() { scp "${options[@]}" -P "$port" "$@"; }
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
remote "install -d -m 700 /opt/hikmah/incoming/$DEPLOY_SHA"

copy deploy/compose.yml deploy/Caddyfile deploy/configure.py deploy/release.sh \
  artifact/image.tar.gz artifact/workbench.tar.gz artifact/provenance.json artifact/image.sha256 "$temporary/config.json" "$destination:/opt/hikmah/incoming/$DEPLOY_SHA/"
remote "bash /opt/hikmah/incoming/$DEPLOY_SHA/release.sh $DEPLOY_SHA"
for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 10 --proto '=https' "https://$HIKMAH_DOMAIN/api/health" > "$temporary/health.json"; then
    if python3 - "$temporary/health.json" <<'PY'
import json,os,sys
value=json.load(open(sys.argv[1]))
assert value.get('status')=='ok' and value.get('revision')==os.environ['DEPLOY_SHA']
print('Public HTTPS health check passed for the exact deployed commit.')
PY
    then exit 0; fi
  fi
  sleep 2
done
echo 'The container was deployed, but public HTTPS verification failed. Check DNS and ports 80/443.' >&2
exit 1

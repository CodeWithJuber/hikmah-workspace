#!/usr/bin/env bash
# Install a self-hosted GitHub Actions runner on this server (run ONCE as root).
#
# Why: GitHub-hosted runner minutes are billed; self-hosted runners are free
# and unlimited. The hikmah release workflow (push to main -> verify -> build
# -> deploy) then runs entirely on this machine with no billing involved.
#
# Usage:
#   GITHUB_PAT=<a PAT with repo scope> bash deploy/install-runner.sh
#
# The PAT is only used to fetch a one-time registration token; it is not
# stored anywhere. After this, merges to main auto-deploy with zero config.
set -euo pipefail

REPO="CodeWithJuber/hikmah-workspace"
LABEL="hikmah-prod"   # must match runs-on: [self-hosted, hikmah-prod] in release.yml
RUNNER_DIR="/opt/actions-runner"

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -n ${GITHUB_PAT:-} ]] || { echo "Set GITHUB_PAT (a PAT with 'repo' scope) and re-run." >&2; exit 1; }
command -v curl >/dev/null || { echo "Install curl first." >&2; exit 1; }
command -v docker >/dev/null || { echo "Install docker first (the deploy builds images here)." >&2; exit 1; }

# Latest runner release; queried live so this script never goes stale.
version=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'].lstrip('v'))")
echo "Installing actions/runner v$version ..."

install -d -m 755 "$RUNNER_DIR"
cd "$RUNNER_DIR"
if [[ ! -f bin/Runner.Listener ]]; then
  curl -fsSL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz"
  tar xzf runner.tar.gz
  rm -f runner.tar.gz
  ./bin/installdependencies.sh
fi

# Exchange the PAT for a one-time registration token (never stored).
token=$(curl -fsSL -X POST \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/actions/runners/registration-token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

# --replace lets a re-run heal a half-configured runner instead of failing.
./config.sh --unattended --replace \
  --url "https://github.com/${REPO}" \
  --token "$token" \
  --labels "$LABEL" \
  --name "$(hostname)-hikmah" \
  --work _work

./svc.sh install root
./svc.sh start

echo "Runner online. Check: https://github.com/${REPO}/settings/actions/runners"
echo "Next: merge to main -> the runner picks up release.yml automatically."

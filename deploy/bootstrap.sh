#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Bootstrap requires root on the deployment host.' >&2; exit 1; }
command -v flock >/dev/null
install -d -m 700 /opt/hikmah /opt/hikmah/incoming /opt/hikmah/backups
exec 9>/opt/hikmah/bootstrap.lock
flock -w 30 9
source /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;
  *) echo 'Supported hosts: Ubuntu 22.04/24.04 or Debian 12/13. No packages changed.' >&2; exit 1 ;;
esac
[[ $(uname -m) == x86_64 ]] || { echo 'This workflow builds for x86_64. Change its image platform before using another architecture.' >&2; exit 1; }
project=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' hikmah-caddy-1 2>/dev/null || true)
# A host counts as already running Hikmah when our Caddy exists OR the release
# marker is on disk. The marker matters: containers can be absent mid-recovery
# (a failed release recreates them), and that must not turn an established
# deployment into a "fresh host" that this guard then refuses to touch.
if [[ "$project" != hikmah && ! -f /opt/hikmah/DEPLOYED_REVISION ]]; then
  # First install only: the stack binds 80/443 by default, so refuse to take
  # those ports from an existing web server or unrelated containers.
  if [[ -n $(ss -H -ltn '( sport = :80 or sport = :443 )') ]]; then
    echo 'Ports 80 or 443 are occupied. Resolve the existing service before deploying Hikmah.' >&2; exit 1
  fi
fi
if ! command -v docker >/dev/null; then
  for package in docker.io podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      echo 'A conflicting container runtime is installed. No packages removed; inspect this host first.' >&2; exit 1
    fi
  done
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl python3
  install -d -m 755 /etc/apt/keyrings
  curl --fail --silent --show-error --proto '=https' "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/hikmah-docker.asc
  chmod 644 /etc/apt/keyrings/hikmah-docker.asc
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/hikmah-docker.asc\n' "$ID" "$VERSION_CODENAME" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/hikmah-docker.sources
  apt-get update -qq
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
command -v python3 >/dev/null || apt-get install -y --no-install-recommends python3
docker compose version >/dev/null
docker info >/dev/null
install -d -m 700 -o 1000 -g 1000 /opt/hikmah/data
echo 'Deployment prerequisites are ready. Existing SSH and firewall settings were preserved.'

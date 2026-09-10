# GitHub Actions → your server

This project includes a single-server deployment workflow for https://github.com/CodeWithJuber/hikmah-workspace. A successful verification job does not by itself mean the server has been deployed: the deployment job also requires the settings below, a reachable SSH host, and a working HTTPS hostname.

## 1. Create the new repository

The private `CodeWithJuber/hikmah-workspace` repository has been created and is accessible to the GitHub connection. Keep this project separate from `hikmah-stack`. For a separate installation, create your own private repository, initialize it with a README, and grant your GitHub connection access. Configure Actions secrets and variables through a GitHub interface or API with the required repository permissions.

If using an authenticated local GitHub CLI instead, from this source directory:

```bash
git init -b main
git add .
git commit -m "Ship Hikmah Workspace v9.1 self-hosted release"
gh repo create hikmah-workspace --private --source . --remote origin --push
```

Do not run the creation command inside an unrelated repository. The workflow must be allowed by the account's Actions policy; workflow-file uploads may require the corresponding GitHub permission.

## 2. Server requirements

- Dedicated x86_64 Ubuntu 22.04/24.04 or Debian 12/13 host, root SSH access, at least 2 GiB RAM and sufficient disk for app images and backups; 10 GiB free is a practical initial target.
- A DNS hostname with its A record pointing to the server. If an AAAA record exists, IPv6 must also reach this server.
- Inbound SSH for the runner, and public TCP ports 80 and 443 for HTTPS. No database or app port is published directly.
- Outbound access to GitHub, package registries, certificate services and the chosen AI/web providers.

The bootstrap script checks the OS and architecture, refuses to take over occupied web ports, and installs Docker from its official apt repository only if Docker is absent. It does not remove conflicting runtimes, change SSH authentication or disable the firewall. If Docker already exists but its Compose plugin is missing, resolve that before deployment.

Keep an existing application on ports 80/443 until its migration has been planned. The script stops with an explanation instead of replacing it.

## 3. Configure Actions

Add these repository settings, or use a GitHub environment named `test-server`. Put credentials in **Secrets**, never in workflow files or issue bodies.

| Name | Type | Value |
| --- | --- | --- |
| `DEPLOY_ENABLED` | Repository variable | `true` when the server settings are ready; otherwise only verification runs |
| `HIKMAH_DOMAIN` | Variable | Your DNS hostname, without `https://` or a path |
| `DEPLOY_USER` | Variable | `root` for this bootstrap flow |
| `DEPLOY_PORT` | Variable | `22`, or your configured SSH port |
| `DEPLOY_HOST` | Secret | Your deployment server IP or hostname |
| `DEPLOY_KNOWN_HOSTS` | Secret | Verified SSH host-key entry for this host and port |
| `DEPLOY_SSH_KEY` | Secret | A deployment private key whose public key is authorized on the server; preferred |
| `DEPLOY_SSH_PASSWORD` | Secret | Password alternative if key authentication is not yet configured; leave unset when using a key |
| `HIKMAH_OWNER_EMAIL` | Secret | Email used to create the owner account |
| `HIKMAH_OWNER_PASSWORD` | Secret | New app password, 12–128 characters, for the first deployment |
| `HIKMAH_SESSION_SECRET` | Secret | Output of `openssl rand -hex 32`; keep stable across normal deployments |

Verify the host fingerprint through your server console or a previously trusted SSH connection before accepting its known-host entry. A fresh `ssh-keyscan` result by itself does not authenticate the server. The workflow enforces strict host-key verification.

The app's owner password is independent of the server's SSH password. The bootstrap password is removed from the server after account creation; remove `HIKMAH_OWNER_PASSWORD` from Actions after a successful first deployment. Normal restarts and updates do not need it. Changing the configured owner email is deliberately blocked on an existing deployment; the stored owner identity must be transferred explicitly.

## 4. Run and verify

Push to `main`, or run **Verify and deploy Hikmah** from Actions. Deployments run only from `main`; pull requests get verification without deployment credentials.

1. Install locked dependencies and run app, storage, auth, runtime and configuration tests.
2. Audit production dependencies; high/critical advisories fail the gate.
3. Build an image tagged with the full commit SHA.
4. Start that image with restricted permissions, authenticate, save a large conversation, restart, and verify saved data and the session.
5. Upload the verified image artifact, checksum and deployment files over SSH.
6. Back up an existing installation while the app is stopped, start the new image, check its health/revision, then start Caddy.
7. Verify the same revision at the public HTTPS `/api/health` endpoint.

The first TLS certificate may take a little time to issue. The workflow retries the public check within a bounded window. A failed public HTTPS check is reported as a failed verification, even if the app container is healthy; investigate DNS, inbound ports and Caddy logs.

## Operation and recovery

Server layout:

- `/opt/hikmah/data`: authentication database, workspace database, object files and saved checkpoints.
- `/opt/hikmah/.env`: private runtime configuration, mode 600.
- `/opt/hikmah/release.env`: active immutable image tag.
- `/opt/hikmah/backups`: local consistent snapshots made before updates.
- `/opt/hikmah/DEPLOYED_REVISION`: last revision whose container passed deployment checks.

Inspect the app without printing `.env` or private data:

```bash
cd /opt/hikmah
docker compose --env-file .env --env-file release.env -f compose.yml ps
docker compose --env-file .env --env-file release.env -f compose.yml logs --tail 100 app caddy
```

The update takes a short maintenance window. Caddy and the app stop before the snapshot, preventing new public writes during rollback. If the new app fails its startup/health/revision check, the release script restores the previous image configuration and pre-update database/object snapshot. Failed candidate data is retained in a private `data-failed-*` directory for inspection. First deployments have no earlier release to restore.

Treat schema changes as reviewed migrations. Never edit an applied migration: its checksum is checked at startup. To recover an older release manually, stop the app and Caddy, preserve the current data directory, and restore a matching backup **together with** its image configuration. Do not point an old image at a newer incompatible database.

Pre-deploy snapshots are local, not an off-site disaster-recovery solution. Configure an encrypted off-site backup destination, retention, an actual restore drill and uptime/error monitoring before relying on the service commercially. Backups contain private chats and authentication records; protect them accordingly. Do not remove shared Docker images/volumes or run an unrestricted system prune.

## Runtime workers and remaining services

`public/runtime/server.py`, its tests, setup guide and ZIP contain the Python/Node/SSH worker starter. Use a dedicated host for untrusted execution, with only the intended app origin, a strong bearer token and explicit SSH aliases. That service is not automatically installed by this app workflow. Browser search/reference retrieval is built into the authenticated app routes; external MCP services still need their own access configuration.

No provider key is baked into the container. Configure it in the app after login. Keep free-only enabled if you only want free OpenRouter models. Free providers can still rate-limit requests or run out of capacity.

References: [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Docker on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Docker on Debian](https://docs.docker.com/engine/install/debian/), [Compose health dependencies](https://docs.docker.com/compose/how-tos/startup-order/), [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Better Auth SQLite](https://better-auth.com/docs/adapters/sqlite).

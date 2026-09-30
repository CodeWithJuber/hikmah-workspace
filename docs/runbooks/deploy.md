# Deploy (database & queue)

## Purpose

Deploy the app so that the database, the job queue, backups, and alerts all
land in a known-good state — and prove it with a smoke test before calling the
deploy done.

## What runs where

| Piece         | What it is                                                                | Where it lives                                                                     |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| App (Next.js) | single container/process                                                  | the deploy host                                                                    |
| Database      | `workspace.sqlite` (+ WAL)                                                | `$HIKMAH_DATA_DIR` on a persistent volume — **not** in the container image         |
| Job queue     | in-process run worker (`lib/runs/service.ts`, sqlite-backed `runs` table) | same process as the app; no separate queue service                                 |
| Backups       | `scripts/ops/backup.sh` via cron                                          | host cron, writing to `HIKMAH_BACKUP_DIR` + off-host rsync                         |
| Alerts        | `GET /api/ops/health` evaluates `lib/ops/alerts.ts` rules                 | in-app; fired alerts append to `HIKMAH_ALERT_LOG` (default `backups/alerts.jsonl`) |

There is deliberately no Postgres/Redis: the deployment is one container and the
queue is sqlite-backed. If load ever outgrows that, this runbook is the place
that decision gets recorded — not an incident.

## Preconditions

- Persistent volume mounted at `$HIKMAH_DATA_DIR` (mode 0700).
- Env set: `HIKMAH_VAULT_KEY` (≥ 32 chars), `HIKMAH_DATA_DIR`, `HIKMAH_BACKUP_DIR`,
  `HIKMAH_ALERT_LOG`. Optional: `HIKMAH_INSTANCE_ID` (only if multi-instance is
  ever attempted — the rate limiter throws across instances by design).
- Container memory limit ≥ 512 MiB (matches `RESOURCE_CAPS.maxRunMemoryBytes`).
- `sqlite3` CLI on the host (backup verification needs it).

## Deploy steps

```bash
# 1. Pre-deploy snapshot (mandatory — the migration-rollback runbook requires it)
scripts/ops/pre-migration-backup.sh --migration <this-release>

# 2. Deploy the new build (method depends on the host: Coolify/docker/compose)
#    The data dir MUST survive the container replacement.

# 3. Health checks, in order:
curl -fsS http://localhost:3000/api/health
# expected: {"status":"ok", ...} and "worker":{"started":true,...}

curl -fsS -H "Cookie: <owner-session>" http://localhost:3000/api/ops/health | head -c 600
# expected: "status":"ok", alerts:[], snapshot with diskUsedPct and backupAgeHours
```

## Smoke test after deploy (all must pass)

```bash
# 1. App serves
curl -fsS http://localhost:3000/api/health | grep -q '"status":"ok"' && echo SMOKE1_OK

# 2. Queue works: enqueue a no-op run and watch it leave 'queued'
#    (via the app UI or API) — then:
sqlite3 "$HIKMAH_DATA_DIR/workspace.sqlite" \
  "SELECT status, count(*) FROM runs GROUP BY status;"
# expected: no row stuck in 'queued' older than a few minutes

# 3. Migrations applied cleanly
sqlite3 "$HIKMAH_DATA_DIR/workspace.sqlite" \
  "SELECT name FROM hikmah_migrations ORDER BY name DESC LIMIT 1;"
# expected: the newest drizzle/*.sql file

# 4. Alert rules evaluate (no crash on missing data)
curl -fsS -H "Cookie: <owner-session>" http://localhost:3000/api/ops/health \
  | grep -q '"ruleCount":7' && echo SMOKE4_OK

# 5. Backup still works post-deploy
scripts/ops/backup.sh --out-dir "$HIKMAH_BACKUP_DIR"
# expected: integrity_check=ok, manifest printed
```

## Rollback

- **Bad deploy, data fine:** redeploy the previous image; the data dir is
  untouched. Then run the smoke test again.
- **Bad migration:** follow `migration-rollback.md` — restore the
  pre-migration snapshot taken in step 1, quarantine the `.sql` file, restart.
- **Data dir was replaced by the deploy (worst case):** this is what step 1's
  snapshot and the off-host backup are for — `restore.sh` onto the volume, then
  smoke-test. If the volume itself is gone, escalate: only the off-host copy
  can save the deploy.

## Cron (owner's crontab)

```cron
# Daily backup, 02:00 UTC; off-host copy right after
0 2 * * * HIKMAH_DATA_DIR=/srv/hikmah/.data HIKMAH_BACKUP_DIR=/srv/hikmah/backups /srv/hikmah/scripts/ops/backup.sh >> /var/log/hikmah-backup.log 2>&1
15 2 * * * rsync -avz /srv/hikmah/backups/ owner@offhost:/srv/hikmah-backups/ >> /var/log/hikmah-backup.log 2>&1
```

## Why no drizzle migration for the ops tables (PR-23 decision)

Alert history does not get a table: fired alerts append to `alerts.jsonl` via
the log sink, which is grep-able, rotatable, and needs no schema. Adding a table
would create migration risk for data nobody queries relationally. If alert
history ever needs querying, that is a new ticket with a real requirement.

## When to escalate to the owner

- The deploy host, volume mounts, cron, and off-host rsync target are all
  owner-provisioned — the operator deploys code, the owner owns the machine.
- Alert delivery (email/webhook) wiring: not implemented, owner decision.
- Backup storage location & retention policy: owner decision (see incident drill).
- Any step that needs `HIKMAH_VAULT_KEY`'s value: owner performs it.

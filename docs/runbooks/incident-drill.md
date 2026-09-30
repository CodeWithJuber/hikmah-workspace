# Incident Drill (tabletop)

## Purpose

Practice the response before a real incident. Run this drill quarterly; it takes
~45 minutes and needs no staging environment — it is a talk-through with the
alert rules on screen.

## Preconditions

- `/api/ops/health` reachable (signed in) and the alert log (`backups/alerts.jsonl`) tail-able.
- The runbooks printed or open: backup-restore, migration-rollback, key-recovery.
- One person plays operator, one plays owner (or the same person, switching hats
  explicitly — say which hat you are wearing before each decision).

## Scenario

**"Monday 09:12 — the `backup_stale` alert fired at 03:00, nobody noticed, and
now the disk is at 87%."**

Inject: set the snapshot the drill reads from by (a) stopping the backup cron,
(b) filling the data volume with a scratch file until `df` reads ≥ 85%.

## Expected detection (via alerts)

| Minute | What should happen                                                                |
| ------ | --------------------------------------------------------------------------------- |
| 0      | `GET /api/ops/health` shows `status: "warn"`, alerts `backup_stale` + `disk_warn` |
| 5      | `tail backups/alerts.jsonl` shows both alerts with timestamps                     |
| 10     | Operator can state RPO honestly: "we can lose up to 24h; last good backup was X"  |

If the alerts do NOT fire, stop the drill: the monitoring is broken and that is
the finding.

## Response steps (talk through, in order)

1. **Triage (5 min):** Is anything down? `curl /api/health` → if `ok`, this is
   not a pages-everyone incident; it is a fix-today incident. Say so out loud.
2. **Stop the bleeding (10 min):** Why did the cron stop? Check the cron logs,
   not the backup script — `backup.sh` verifies itself and exits non-zero on
   failure, so a silent gap means the scheduler never ran it.
3. **Recover (10 min):** Run `backup.sh` by hand; confirm `integrity_check=ok`
   and the manifest. Confirm the off-host `rsync` ran.
4. **Disk (10 min):** Identify what grew (old backups in `backups/` are the
   usual suspect — the drill's scratch file stands in). Decide the retention
   policy out loud: how many local backups do we keep? (Suggested: 7 daily;
   older ones live off-host only.)
5. **Declare done:** `GET /api/ops/health` returns `status: "ok"`, no alerts.

## What is deliberately NOT covered today

- Error-rate spike: nothing populates `errorRate5m` yet (see the honest note in
  `lib/ops/alerts.ts`). The drill must not pretend that rule protects anything.
- Alert delivery beyond the log file: there is no email/webhook. Detection in
  this drill means _a human looked_ — say that out loud too.

## Postmortem template

```markdown
## Incident: <title>

- Date: <UTC>
- Severity: <warn|critical> Duration: <from first alert to status ok>
- Detection: <which alert rule, at what time, who saw it>
- Root cause: <5 whys, one paragraph>
- What worked: <e.g. backup.sh self-verification caught the bad snapshot>
- What didn't: <e.g. nobody tails alerts.jsonl at 03:00>
- Action items:
  - [ ] <owner> wire alert delivery (email/webhook) — the log file is not paging
  - [ ] <owner> fix the backup cron / retention policy
  - [ ] <operator> schedule next drill: <date>
- Honest RPO/RTO this time: <what we would have lost / how long recovery took>
```

## When to escalate to the owner

- The drill surfaces that backups have been failing silently for days → owner
  decides the data-loss acceptance, not the operator.
- Any step needs the vault key, provider keys, or money (bigger disk) → owner.
- The postmortem's action items include alert-delivery wiring — only the owner
  can approve a new external channel.

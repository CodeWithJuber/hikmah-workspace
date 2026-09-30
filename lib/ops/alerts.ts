/**
 * Operational alert rules (PR-23 operational readiness).
 *
 * The RULES are pure evaluators over an OpsSnapshot — they decide *what* fires.
 * The DELIVERY is a stub: AlertSink is an interface, and the only implementation
 * shipped is LogAlertSink, which appends JSONL to a file. No email, no webhook,
 * no external send of any kind. Wiring delivery to a real channel is the owner's
 * job; docs/runbooks/incident-drill.md lists exactly what is missing.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Severity = 'warn' | 'critical';

export interface OpsSnapshot {
  /** Disk used, percent of the data volume (0-100). undefined = could not measure. */
  diskUsedPct?: number;
  /** Hours since the last successful backup. undefined = no backup found. */
  backupAgeHours?: number;
  /** Runs currently queued in the worker store. */
  queueDepth: number;
  /** Whether the run worker has started. */
  workerStarted: boolean;
  /**
   * Error rate over the last 5 minutes (errors / requests, 0-1).
   * Honest status: nothing in the stack populates this yet, so it defaults to 0
   * and the rule cannot fire. The evaluator is here so the wiring has a place
   * to land; incident-drill.md tracks the instrumentation gap.
   */
  errorRate5m: number;
  /** Queue depth at which the queue_depth rule fires. */
  maxQueueDepth: number;
  /** Backup age in hours at which the backup_stale rule fires. */
  maxBackupAgeHours: number;
  /** Disk percent at which the disk_warn rule fires. */
  diskWarnPct: number;
  /** Disk percent at which the disk_critical rule fires. */
  diskCriticalPct: number;
  /** Error rate at which the error_spike rule fires. */
  errorRateThreshold: number;
}

export interface FiredAlert {
  rule: string;
  severity: Severity;
  message: string;
}

export interface AlertRule {
  id: string;
  severity: Severity;
  evaluate: (snapshot: OpsSnapshot) => FiredAlert | null;
}

const diskCritical: AlertRule = {
  id: 'disk_critical',
  severity: 'critical',
  evaluate: (s) =>
    s.diskUsedPct !== undefined && s.diskUsedPct >= s.diskCriticalPct
      ? {
          rule: 'disk_critical',
          severity: 'critical',
          message: `Data volume ${s.diskUsedPct.toFixed(1)}% full (>= ${s.diskCriticalPct}%). Writes will start failing; clear backups or grow the volume.`,
        }
      : null,
};

const diskWarn: AlertRule = {
  id: 'disk_warn',
  severity: 'warn',
  evaluate: (s) =>
    s.diskUsedPct !== undefined &&
    s.diskUsedPct >= s.diskWarnPct &&
    s.diskUsedPct < s.diskCriticalPct
      ? {
          rule: 'disk_warn',
          severity: 'warn',
          message: `Data volume ${s.diskUsedPct.toFixed(1)}% full (>= ${s.diskWarnPct}%). Plan cleanup before it becomes critical.`,
        }
      : null,
};

const backupStale: AlertRule = {
  id: 'backup_stale',
  severity: 'warn',
  evaluate: (s) =>
    s.backupAgeHours !== undefined && s.backupAgeHours > s.maxBackupAgeHours
      ? {
          rule: 'backup_stale',
          severity: 'warn',
          message: `Last successful backup is ${s.backupAgeHours.toFixed(1)}h old (> ${s.maxBackupAgeHours}h). Run scripts/ops/backup.sh.`,
        }
      : null,
};

const backupMissing: AlertRule = {
  id: 'backup_missing',
  severity: 'critical',
  evaluate: (s) =>
    s.backupAgeHours === undefined
      ? {
          rule: 'backup_missing',
          severity: 'critical',
          message:
            'No successful backup found at all. Nothing can be restored; run scripts/ops/backup.sh now.',
        }
      : null,
};

const queueDeep: AlertRule = {
  id: 'queue_deep',
  severity: 'warn',
  evaluate: (s) =>
    s.queueDepth >= s.maxQueueDepth
      ? {
          rule: 'queue_deep',
          severity: 'warn',
          message: `${s.queueDepth} runs queued (>= ${s.maxQueueDepth}). The worker may be stalled; check /api/health worker.active.`,
        }
      : null,
};

const workerDown: AlertRule = {
  id: 'worker_down',
  severity: 'critical',
  evaluate: (s) =>
    !s.workerStarted
      ? {
          rule: 'worker_down',
          severity: 'critical',
          message:
            'Run worker has not started. Queued runs will never execute; restart the container.',
        }
      : null,
};

const errorSpike: AlertRule = {
  id: 'error_spike',
  severity: 'warn',
  evaluate: (s) =>
    s.errorRate5m > s.errorRateThreshold
      ? {
          rule: 'error_spike',
          severity: 'warn',
          message: `Error rate ${(s.errorRate5m * 100).toFixed(1)}% over the last 5m (> ${(s.errorRateThreshold * 100).toFixed(1)}%). Check app logs for the failing route.`,
        }
      : null,
};

export const ALERT_RULES: AlertRule[] = [
  diskCritical,
  diskWarn,
  backupStale,
  backupMissing,
  queueDeep,
  workerDown,
  errorSpike,
];

/** Run every rule over the snapshot. Order is stable: the order of ALERT_RULES. */
export function evaluateAlerts(snapshot: OpsSnapshot): FiredAlert[] {
  const fired: FiredAlert[] = [];
  for (const rule of ALERT_RULES) {
    const alert = rule.evaluate(snapshot);
    if (alert) fired.push(alert);
  }
  return fired;
}

/**
 * Where a fired alert goes. A stub on purpose: the shipped sink only logs.
 * A real EmailAlertSink / WebhookAlertSink would implement this interface, but
 * the user rule is NO external sends from this codebase, so none ships.
 */
export interface AlertSink {
  send: (alert: FiredAlert, snapshot: OpsSnapshot) => void;
}

/**
 * Appends one JSON object per fired alert to a log file. This is the whole
 * delivery story today: the owner tails the file or wires their own forwarder.
 */
export function makeLogAlertSink(logPath: string): AlertSink {
  return {
    send: (alert, snapshot) => {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        JSON.stringify({
          at: new Date().toISOString(),
          rule: alert.rule,
          severity: alert.severity,
          message: alert.message,
          queueDepth: snapshot.queueDepth,
          backupAgeHours: snapshot.backupAgeHours,
          diskUsedPct: snapshot.diskUsedPct,
        }) + '\n',
      );
    },
  };
}

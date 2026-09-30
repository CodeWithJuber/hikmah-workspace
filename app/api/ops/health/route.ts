/**
 * Ops health: the machine-readable side of the alert rules (PR-23).
 *
 * GET returns the current OpsSnapshot, the fired alerts, and the limit/cap
 * tables. Fired alerts are appended to the log sink; nothing is emailed or
 * posted anywhere — delivery wiring is the owner's job (see key-recovery and
 * incident-drill runbooks).
 *
 * Signed-in owner only: the snapshot names disk usage and backup age, which is
 * the deployment's business.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getChatGPTUser } from '../../../chatgpt-auth';
import {
  RATE_LIMITS,
  TokenBucket,
  bucketForRoute,
  RESOURCE_CAPS,
  unenforcedCaps,
} from '@/lib/ops/limits';
import {
  type AlertRule,
  type AlertSink,
  type FiredAlert,
  type OpsSnapshot,
  type Severity,
  ALERT_RULES,
  evaluateAlerts,
  makeLogAlertSink,
} from '@/lib/ops/alerts';

export const dynamic = 'force-dynamic';

const DATA_DIR = process.env.HIKMAH_DATA_DIR ?? resolve('.data');
const BACKUP_DIR = process.env.HIKMAH_BACKUP_DIR ?? resolve('backups');
const ALERT_LOG = process.env.HIKMAH_ALERT_LOG ?? resolve('backups', 'alerts.jsonl');

function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

function diskUsedPct(dir: string): number | undefined {
  try {
    const out = execFileSync('df', ['-kP', dir], { encoding: 'utf8', timeout: 5000 });
    const line = out.trim().split('\n').at(-1) ?? '';
    const pct = line.split(/\s+/)[4];
    const n = Number(pct?.replace('%', ''));
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Hours since the newest backup manifest, or undefined when none exists. */
function backupAgeHours(dir: string, now = Date.now()): number | undefined {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && e.name.startsWith('backup-'),
    );
    let newest: number | undefined;
    for (const entry of entries) {
      const manifest = join(dir, entry.name, 'MANIFEST.sha256');
      try {
        const mtime = statSync(manifest).mtimeMs;
        newest = newest === undefined ? mtime : Math.max(newest, mtime);
      } catch {
        // Backup dir without a manifest is not a successful backup.
      }
    }
    return newest === undefined ? undefined : (now - newest) / 3_600_000;
  } catch {
    return undefined;
  }
}

async function queueState(): Promise<{ depth: number; workerStarted: boolean }> {
  try {
    const { runService } = await import('@/lib/runs/service');
    const service = runService();
    return { depth: service.store.countQueued(), workerStarted: service.started };
  } catch {
    return { depth: 0, workerStarted: false };
  }
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user?.userId)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401 });

  // The ops route rate-limits itself: monitoring must not become a load source.
  const config = RATE_LIMITS['/api/ops/health'];
  const bucket: TokenBucket = bucketForRoute('/api/ops/health');
  const bucketKey = config.key === 'ip' ? `ops-health:${clientIp(request)}` : 'ops-health:global';
  const { allowed, retryAfterMs } = bucket.take(bucketKey);
  if (!allowed)
    return Response.json(
      { error: 'Rate limited', retryAfterMs },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
    );

  const { depth, workerStarted } = await queueState();
  const snapshot: OpsSnapshot = {
    diskUsedPct: diskUsedPct(DATA_DIR),
    backupAgeHours: backupAgeHours(BACKUP_DIR),
    queueDepth: depth,
    workerStarted,
    // Nothing in the stack populates this yet; the rule is wired but cannot fire.
    errorRate5m: 0,
    maxQueueDepth: RESOURCE_CAPS.maxQueueDepth.numeric,
    maxBackupAgeHours: RESOURCE_CAPS.maxBackupAgeHours.numeric,
    diskWarnPct: 80,
    diskCriticalPct: 95,
    errorRateThreshold: 0.2,
  };

  const rules: AlertRule[] = ALERT_RULES;
  const alerts: FiredAlert[] = evaluateAlerts(snapshot);
  const sink: AlertSink = makeLogAlertSink(ALERT_LOG);
  for (const alert of alerts) sink.send(alert, snapshot);

  const severities: Severity[] = alerts.map((a) => a.severity);
  return Response.json(
    {
      status: severities.includes('critical') ? 'critical' : severities.length ? 'warn' : 'ok',
      snapshot,
      alerts,
      ruleCount: rules.length,
      caps: RESOURCE_CAPS,
      unenforcedCaps: unenforcedCaps(),
      rateLimits: RATE_LIMITS,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

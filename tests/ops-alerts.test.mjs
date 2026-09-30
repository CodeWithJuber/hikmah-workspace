// Alert rules: each rule fires and stays quiet on crafted snapshots; the log
// sink writes parseable JSONL and sends nothing anywhere.
// Run: node --test tests/ops-alerts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-ops-alerts-'));
await build({
  entryPoints: ['lib/ops/alerts.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { ALERT_RULES, evaluateAlerts, makeLogAlertSink } = await import(
  pathToFileURL(join(dir, 'alerts.mjs'))
);

const base = () => ({
  diskUsedPct: 40,
  backupAgeHours: 5,
  queueDepth: 3,
  workerStarted: true,
  errorRate5m: 0,
  maxQueueDepth: 50,
  maxBackupAgeHours: 26,
  diskWarnPct: 80,
  diskCriticalPct: 95,
  errorRateThreshold: 0.2,
});

const fired = (snapshot) => evaluateAlerts(snapshot).map((a) => a.rule);

test('seven rules ship', () => {
  assert.equal(ALERT_RULES.length, 7);
  const ids = ALERT_RULES.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    'backup_missing',
    'backup_stale',
    'disk_critical',
    'disk_warn',
    'error_spike',
    'queue_deep',
    'worker_down',
  ]);
});

test('a healthy snapshot fires nothing', () => {
  assert.deepEqual(fired(base()), []);
});

test('disk_warn fires at 80% and stays quiet at 79%', () => {
  assert.ok(fired({ ...base(), diskUsedPct: 79 }).length === 0);
  assert.deepEqual(fired({ ...base(), diskUsedPct: 80 }), ['disk_warn']);
});

test('disk_critical fires at 95% and suppresses the warn', () => {
  const rules = fired({ ...base(), diskUsedPct: 96 });
  assert.ok(rules.includes('disk_critical'));
  assert.ok(!rules.includes('disk_warn'), 'warn must not double-fire past critical');
});

test('unmeasurable disk fires no disk rule', () => {
  const s = base();
  delete s.diskUsedPct;
  assert.ok(!fired(s).some((r) => r.startsWith('disk_')));
});

test('backup_stale fires past 26h, quiet at 26h', () => {
  assert.deepEqual(fired({ ...base(), backupAgeHours: 26 }), []);
  assert.deepEqual(fired({ ...base(), backupAgeHours: 26.1 }), ['backup_stale']);
});

test('backup_missing is critical when no backup was ever found', () => {
  const s = base();
  delete s.backupAgeHours;
  const alerts = evaluateAlerts(s);
  assert.deepEqual(
    alerts.map((a) => a.rule),
    ['backup_missing'],
  );
  assert.equal(alerts[0].severity, 'critical');
});

test('queue_deep fires at the cap, quiet below', () => {
  assert.deepEqual(fired({ ...base(), queueDepth: 49 }), []);
  assert.deepEqual(fired({ ...base(), queueDepth: 50 }), ['queue_deep']);
});

test('worker_down is critical when the worker never started', () => {
  const alerts = evaluateAlerts({ ...base(), workerStarted: false });
  assert.deepEqual(
    alerts.map((a) => a.rule),
    ['worker_down'],
  );
  assert.equal(alerts[0].severity, 'critical');
});

test('error_spike fires above the threshold and is quiet at zero', () => {
  assert.deepEqual(fired(base()), []);
  assert.deepEqual(fired({ ...base(), errorRate5m: 0.25 }), ['error_spike']);
});

test('multiple rules fire together in stable rule order', () => {
  const rules = fired({ ...base(), diskUsedPct: 97, backupAgeHours: 30, workerStarted: false });
  assert.deepEqual(rules, ['disk_critical', 'backup_stale', 'worker_down']);
});

test('fired alerts carry a human-readable message', () => {
  const alerts = evaluateAlerts({ ...base(), diskUsedPct: 82 });
  assert.ok(alerts[0].message.includes('82'), 'message names the measured value');
  assert.ok(alerts[0].message.length > 20);
});

test('the log sink writes one parseable JSON object per alert', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hikmah-alertlog-'));
  const logPath = join(tmp, 'alerts.jsonl');
  const sink = makeLogAlertSink(logPath);
  const snapshot = base();
  sink.send({ rule: 'disk_warn', severity: 'warn', message: 'disk nearly full' }, snapshot);
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.rule, 'disk_warn');
  assert.equal(row.severity, 'warn');
  assert.ok(row.at, 'timestamped');
});

test('the sink never performs an external send', async () => {
  // The only node:fs import in the bundle is the sink's; assert the bundle has
  // no network surface at all: no fetch, no http, no nodemailer-shaped require.
  const src = await readFile(join(dir, 'alerts.mjs'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(src), 'no fetch calls');
  assert.ok(!/require\(['"]node:http/.test(src), 'no http client');
  assert.ok(!/nodemailer|smtp|sendgrid/i.test(src), 'no mailer');
});

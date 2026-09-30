// Rate and resource limits: token bucket behavior and the cap table.
// Run: node --test tests/ops-limits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-ops-limits-'));
await build({
  entryPoints: ['lib/ops/limits.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { TokenBucket, bucketForRoute, RATE_LIMITS, RESOURCE_CAPS, unenforcedCaps } = await import(
  pathToFileURL(join(dir, 'limits.mjs'))
);

test('a fresh bucket allows the full burst', () => {
  const b = new TokenBucket(3, 60_000);
  for (let i = 0; i < 3; i++) assert.equal(b.take('k').allowed, true, `request ${i + 1} allowed`);
});

test('the bucket rejects past the burst and names a retry delay', () => {
  const b = new TokenBucket(2, 60_000);
  b.take('k', 1000);
  b.take('k', 1000);
  const r = b.take('k', 1000);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterMs > 0, 'rejection carries retryAfterMs');
  assert.ok(r.retryAfterMs <= 60_000, 'retry delay never exceeds the window');
});

test('tokens refill over time', () => {
  const b = new TokenBucket(2, 60_000); // 1 token per 30s
  b.take('k', 0);
  b.take('k', 0);
  assert.equal(b.take('k', 0).allowed, false);
  assert.equal(b.take('k', 30_001).allowed, true, 'one token refilled after 30s');
});

test('buckets are isolated per key', () => {
  const b = new TokenBucket(1, 60_000);
  b.take('alice', 0);
  assert.equal(b.take('alice', 0).allowed, false);
  assert.equal(b.take('bob', 0).allowed, true, 'bob has his own bucket');
});

test('constructor rejects nonsense config', () => {
  assert.throws(() => new TokenBucket(0, 60_000), /positive/);
  assert.throws(() => new TokenBucket(10, -1), /positive/);
});

test('every RATE_LIMITS entry is a sane positive config', () => {
  for (const [path, cfg] of Object.entries(RATE_LIMITS)) {
    assert.ok(cfg.limit > 0 && Number.isFinite(cfg.limit), `${path}: limit`);
    assert.ok(cfg.windowMs > 0 && Number.isFinite(cfg.windowMs), `${path}: windowMs`);
    assert.ok(['ip', 'global'].includes(cfg.key), `${path}: key mode`);
    assert.ok(cfg.reason.length > 10, `${path}: a limit without a reason rots`);
  }
});

test('the chat route is the tightest model-cost route', () => {
  assert.ok(RATE_LIMITS['/api/chat'].limit <= RATE_LIMITS.default.limit);
});

test('bucketForRoute returns the configured bucket and caches it', () => {
  const a = bucketForRoute('/api/chat');
  const b = bucketForRoute('/api/chat');
  assert.equal(a, b, 'same bucket instance per route');
  const d = bucketForRoute('/nope/not-a-route');
  assert.notEqual(d, a, 'unknown routes fall back to default, not the chat bucket');
});

test('RESOURCE_CAPS is a complete, positive table', () => {
  const required = [
    'maxUploadBytes',
    'maxRunMemoryBytes',
    'maxRunTimeoutMs',
    'maxQueueDepth',
    'maxBackupAgeHours',
  ];
  for (const name of required) {
    const cap = RESOURCE_CAPS[name];
    assert.ok(cap, `${name} present`);
    assert.ok(cap.numeric > 0, `${name}: numeric positive`);
    assert.ok(cap.enforcedBy.length > 10, `${name}: names where it is enforced`);
  }
});

test('upload cap matches the storage envelope the code actually enforces', () => {
  // server/storage.mjs: Buffer.byteLength(body) > 24_000_000 throws.
  assert.equal(RESOURCE_CAPS.maxUploadBytes.numeric, 24_000_000);
});

test('unenforcedCaps honestly lists the not-really-enforced caps', () => {
  const list = unenforcedCaps();
  assert.ok(list.includes('maxRunMemoryBytes'), 'memory cap is deployment config, flagged');
  assert.ok(list.includes('maxQueueDepth'), 'queue depth has no hard reject, flagged');
  assert.ok(!list.includes('maxUploadBytes'), 'upload cap IS enforced in code');
});

test('backup age cap matches the alert rule threshold', () => {
  assert.equal(RESOURCE_CAPS.maxBackupAgeHours.numeric, 26);
});

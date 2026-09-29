// Usage alerts: 80% (near) and 100% (at) of the monthly token allowance.
//
// The alert is what the chat banner and the billing page render; the refusal
// at 100% is what the run route enforces. The two must agree about where the
// line is, so both read the same entitlement fields.
// Run: node --test tests/billing-usage-alert.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-usage-alert-'));
await build({
  entryPoints: ['lib/billing/access.ts', 'lib/billing/entitlements.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const mod = async (n) => import(pathToFileURL(join(dir, n + '.mjs')));
const { usageAlert } = await mod('access');
const { entitlementsFor, overCap } = await mod('entitlements');

const managed = entitlementsFor('managed');
const CAP = managed.monthlyTokenCap;

test('silence below 80%: the common case is no banner', () => {
  assert.equal(usageAlert({ entitlements: managed, meteredThisMonth: 0 }), null);
  assert.equal(
    usageAlert({ entitlements: managed, meteredThisMonth: Math.floor(CAP * 0.79) }),
    null,
  );
});

test('80% warns, 100% says the cap is reached', () => {
  const near = usageAlert({ entitlements: managed, meteredThisMonth: Math.ceil(CAP * 0.8) });
  assert.equal(near?.level, 'near');
  assert.ok(near.percent >= 80 && near.percent < 100);
  assert.deepEqual(usageAlert({ entitlements: managed, meteredThisMonth: CAP }), {
    level: 'at',
    percent: 100,
  });
  assert.deepEqual(
    usageAlert({ entitlements: managed, meteredThisMonth: CAP * 2 }),
    { level: 'at', percent: 100 },
    'clamped, never 200%',
  );
});

test('a tier with no cap has no alert, however much it runs', () => {
  for (const tier of ['owner', 'byok']) {
    const entitlements = entitlementsFor(tier);
    assert.equal(usageAlert({ entitlements, meteredThisMonth: 1e12 }), null, tier);
  }
});

test('the 100% alert and the run refusal agree about where the line is', () => {
  assert.ok(overCap(managed, CAP), 'the run route refuses at exactly the cap');
  assert.equal(usageAlert({ entitlements: managed, meteredThisMonth: CAP })?.level, 'at');
});

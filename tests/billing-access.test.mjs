// Who may spend the deployment's money, and who may reach a machine.
//
// These are the two rules that have to hold before a stranger can sign up. Both
// were wrong for a multi-tenant deployment and invisible with one account: the
// provider key fell back to HIKMAH_PROVIDER_KEY for anyone signed in, and the
// workbench tools were offered to anyone the deployment had one for.
// Run: node --test tests/billing-access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-billing-'));
await build({
  entryPoints: ['lib/billing/access.ts', 'lib/billing/entitlements.ts', 'lib/billing/store.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const mod = async (n) => import(pathToFileURL(join(dir, n + '.mjs')));
const { runAccess, refusal } = await mod('access');
const { entitlementsFor, resolveTier, overCap, periodStart, EXECUTION_TOOLS } =
  await mod('entitlements');
const { createBillingStore } = await mod('store');

test('the deployment key is not handed to someone who did not pay for it', () => {
  const free = entitlementsFor('byok');
  const access = runAccess({ entitlements: free, savedKey: '', deploymentKey: 'sk-owner' });
  assert.equal(access.apiKey, '', 'a free account must not reach the deployment key');
  assert.equal(access.metered, false);
});

test('the deployment key is the fallback for the tiers that include models', () => {
  for (const tier of ['owner', 'managed']) {
    const access = runAccess({
      entitlements: entitlementsFor(tier),
      savedKey: '',
      deploymentKey: 'sk-owner',
    });
    assert.equal(access.apiKey, 'sk-owner', tier);
    assert.equal(access.metered, true, tier + ' spends the deployment budget');
  }
});

test('a saved key always wins, and never counts as metered', () => {
  for (const tier of ['owner', 'byok', 'managed']) {
    const access = runAccess({
      entitlements: entitlementsFor(tier),
      savedKey: 'sk-theirs',
      deploymentKey: 'sk-owner',
    });
    assert.equal(access.apiKey, 'sk-theirs', tier);
    assert.equal(
      access.metered,
      false,
      tier + ' on their own key costs the deployment nothing, so it is not rationed',
    );
  }
});

test('only the operator may reach a machine', () => {
  assert.equal(entitlementsFor('owner').execution, true);
  assert.equal(entitlementsFor('managed').execution, false);
  assert.equal(entitlementsFor('byok').execution, false);
  // Named so the run route and this test cannot drift about which tools those
  // are. The workbench is one shared /workspace volume, which is the reason.
  assert.deepEqual(EXECUTION_TOOLS, ['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts']);
});

// The two the Pro plan sells, which were sold before they existed.
test('generating pictures and speech is what the paid plan says it is', () => {
  assert.equal(entitlementsFor('owner').media, true);
  assert.equal(entitlementsFor('managed').media, true);
  // This removes something a free bring-your-own-key user had by accident: the
  // media key was derived from their own provider key, so the paid feature was
  // quietly everyone's.
  assert.equal(entitlementsFor('byok').media, false);
});

test('priority on the run queue is a number, and the paid tiers have more of it', () => {
  assert.ok(entitlementsFor('managed').queuePriority > entitlementsFor('byok').queuePriority);
  // The operator above the customer: one worker, and their own work should not
  // queue behind someone else's.
  assert.ok(entitlementsFor('owner').queuePriority > entitlementsFor('managed').queuePriority);
  assert.equal(entitlementsFor('byok').queuePriority, 0, 'the default every existing run has');
});

test('the owner is the pinned user id, not whoever holds the configured email', () => {
  const base = { email: 'someone@example.test', ownerEmail: 'owner@example.test', saved: null };
  // Once the row exists it is the only answer, so changing the environment
  // variable cannot hand the deployment to a new account.
  assert.equal(resolveTier({ ...base, userId: 'u1', ownerUserId: 'u1' }), 'owner');
  assert.equal(
    resolveTier({ ...base, userId: 'u2', ownerUserId: 'u1', email: 'owner@example.test' }),
    'byok',
    'the configured email does not outrank the pinned owner',
  );
  // Before it exists, the configured email bootstraps, matching ownerIdentity.
  assert.equal(
    resolveTier({ ...base, userId: 'u1', ownerUserId: null, email: 'Owner@Example.test' }),
    'owner',
  );
  assert.equal(resolveTier({ ...base, userId: 'u2', ownerUserId: null }), 'byok');
});

test('a stale saved tier never demotes the owner', () => {
  assert.equal(
    resolveTier({
      userId: 'u1',
      email: 'owner@example.test',
      ownerUserId: 'u1',
      ownerEmail: 'owner@example.test',
      saved: 'byok',
    }),
    'owner',
  );
});

test('an unknown saved tier falls back to free rather than to paid', () => {
  const base = {
    userId: 'u2',
    email: 'a@b.test',
    ownerUserId: 'u1',
    ownerEmail: 'owner@example.test',
  };
  assert.equal(resolveTier({ ...base, saved: 'managed' }), 'managed');
  assert.equal(resolveTier({ ...base, saved: null }), 'byok');
  assert.equal(resolveTier({ ...base, saved: 'nonsense' }), 'byok');
});

test('a cap only applies to what the deployment is paying for', () => {
  const managed = entitlementsFor('managed');
  assert.equal(overCap(managed, managed.monthlyTokenCap - 1), false);
  assert.equal(overCap(managed, managed.monthlyTokenCap), true);
  // The free tier runs on its own key, so there is nothing to ration however
  // much it uses.
  assert.equal(overCap(entitlementsFor('byok'), Number.MAX_SAFE_INTEGER), false);
  assert.equal(overCap(entitlementsFor('owner'), Number.MAX_SAFE_INTEGER), false);
});

test('a refusal says something the person can act on, per tier', () => {
  const keyless = { keyless: true, meteredThisMonth: 0 };
  const owner = refusal({
    ...keyless,
    entitlements: entitlementsFor('owner'),
    access: { apiKey: '', metered: false, execution: true },
  });
  assert.match(owner, /HIKMAH_PROVIDER_KEY/, 'the operator is told about the server setting');
  const free = refusal({
    ...keyless,
    entitlements: entitlementsFor('byok'),
    access: { apiKey: '', metered: false, execution: false },
  });
  assert.doesNotMatch(free, /HIKMAH_PROVIDER_KEY/, 'a customer is not told about server internals');
  assert.match(free, /upgrade/);
});

test('a refusal over the cap offers the way out that costs nothing to grant', () => {
  const managed = entitlementsFor('managed');
  const over = refusal({
    entitlements: managed,
    access: { apiKey: 'sk-owner', metered: true, execution: false },
    keyless: false,
    meteredThisMonth: managed.monthlyTokenCap,
  });
  assert.match(over, /own provider key/);
  assert.equal(
    refusal({
      entitlements: managed,
      access: { apiKey: 'sk-owner', metered: true, execution: false },
      keyless: false,
      meteredThisMonth: managed.monthlyTokenCap - 1,
    }),
    '',
  );
});

test('usage is summed per month, and only metered rows count against the cap', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  const from = periodStart();
  const event = (id, metered, tokens) => ({
    id,
    userId: 'u1',
    runId: 'r-' + id,
    model: 'a/b',
    metered,
    inputTokens: tokens,
    outputTokens: 0,
  });
  store.recordUsage(event('1', true, 100));
  store.recordUsage(event('2', false, 900));
  store.recordUsage({ ...event('3', true, 50), userId: 'u2' });
  assert.equal(store.meteredThisMonth('u1', from), 100);
  assert.equal(store.usageThisMonth('u1', from).tokens, 1000, 'the page shows everything they ran');
  assert.equal(store.usageThisMonth('u1', from).runs, 2);
  assert.equal(store.meteredThisMonth('u2', from), 50, 'usage does not leak between accounts');
  db.close();
});

test('the tier store treats absence as the free tier and never appoints an owner', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const store = createBillingStore(db);
  assert.equal(store.savedTier('u1'), null, 'a new account needs no row');
  assert.equal(store.ownerUserId(), null);
  store.setTier('u1', 'managed');
  assert.equal(store.savedTier('u1'), 'managed');
  store.setTier('u1', 'byok');
  assert.equal(store.savedTier('u1'), 'byok', 'a cancellation is an update, not a second row');
  // Reading who the owner is must not make anyone the owner.
  assert.equal(store.ownerUserId(), null);
  db.close();
});

// Who may spend the deployment's own key — asked of the routes, not of one route.
//
// `app/api/chat/route.ts` did `if (!apiKey) apiKey = process.env.HIKMAH_PROVIDER_KEY`
// with no entitlement check, no usage row and no cap, and handed `ssh` and
// `shell` to the agent unconditionally. Signed in was the only requirement. It
// was the exact pair of holes this module was written to close, still open on a
// second path, and it had no callers at all — so with registration open, any
// stranger could spend the operator's provider budget and run commands in the
// workbench through a route nothing in the product used.
//
// Asserted as a rule rather than as a file, because deleting that route fixes
// today and this catches the next one.
test('a route that spends the deployment key goes through the entitlement check', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const routes = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === 'route.ts') routes.push(path);
    }
  };
  await walk('app/api');
  assert.ok(routes.length > 5, 'expected to find the API routes, found ' + routes.length);

  for (const path of routes) {
    const source = await readFile(path, 'utf8');
    if (!source.includes('HIKMAH_PROVIDER_KEY')) continue;
    assert.match(
      source,
      /runAccess\(/,
      path + ' reads the deployment key without asking who is entitled to it',
    );
  }
});

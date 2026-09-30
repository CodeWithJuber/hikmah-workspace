// The exemplar flow: scoped enforcement at every step, a receipt for every
// attempt, and clean recovery on scoped-auth, API and check failures —
// without losing the user's work. Run: node --test tests/github-flow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runExemplarAction, ExemplarFailure, proposeDiff } from '../lib/github/flow.ts';
import { createGitHubStore } from '../lib/github/store.ts';
import { paramsHash } from '../lib/github/client.ts';

const headers = (extra = {}) => ({ get: (name) => extra[name.toLowerCase()] ?? null });
const jsonResponse = (status, payload, headerExtra) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: headers(headerExtra),
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const b64 = (text) => Buffer.from(text).toString('base64');

function setup(t, scopes, fetchHandler) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0032_github_integration.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const store = createGitHubStore(db);
  const connection = store.add('user-1', 'test', scopes);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return fetchHandler(url, init);
  };
  const context = (action, params, extra = {}) => ({
    db,
    userId: 'user-1',
    connectionId: connection.id,
    action,
    params,
    getToken: async () => 'token',
    fetchImpl,
    ...extra,
  });
  return { db, store, connection, calls, context };
}

const fileHandler = (url) => {
  if (url.includes('/contents/README.md'))
    return jsonResponse(200, {
      type: 'file',
      path: 'README.md',
      sha: 'deadbeef',
      encoding: 'base64',
      content: b64('# Title\n'),
    });
  return jsonResponse(404, { message: 'not found' });
};

const FULL_SCOPES = [
  'contents:read',
  'issues:read',
  'pull_requests:read',
  'checks:read',
  'contents:write',
  'pull_requests:write',
];

test('the exemplar runs read → patch → checks → draft PR (dry run)', async (t) => {
  const { store, context, connection } = setup(t, FULL_SCOPES, async (url) => {
    if (url.includes('/contents/README.md')) return fileHandler(url);
    if (url.includes('/check-runs'))
      return jsonResponse(200, {
        check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: '' }],
      });
    throw new Error(`unexpected call ${url}`);
  });

  const read = await runExemplarAction(
    context('read-file', { owner: 'o', repo: 'r', path: 'README.md' }),
  );
  assert.equal(read.dryRun, false);
  assert.equal(read.data.content, '# Title\n');

  const patch = await runExemplarAction(
    context('propose-patch', {
      path: 'README.md',
      baseContent: '# Title\n',
      newContent: '# Title\n\nMore.\n',
    }),
  );
  assert.ok(patch.data.diff.includes('--- a/README.md'));
  assert.ok(patch.data.diff.includes('+More.'));

  const checks = await runExemplarAction(
    context('surface-checks', { owner: 'o', repo: 'r', ref: 'main' }),
  );
  assert.equal(checks.blocked, undefined);

  const draftParams = { owner: 'o', repo: 'r', title: 'Fix', head: 'fix', base: 'main', body: '' };
  const draft = await runExemplarAction(
    context('draft-pr', draftParams, { approvedParamsHash: paramsHash(draftParams) }),
  );
  assert.equal(draft.dryRun, true, 'writes are dry-run by default');
  assert.equal(draft.data.proposal.title, 'Fix');

  const receipts = store.receipts(connection.id, 'user-1');
  assert.equal(receipts.length, 4, 'one receipt per step');
  assert.deepEqual(receipts.map((r) => r.action).sort(), [
    'draft-pr',
    'propose-patch',
    'read-file',
    'surface-checks',
  ]);
});

test('a missing scope fails before the network, with the draft preserved', async (t) => {
  const { store, context, connection, calls } = setup(t, ['contents:read'], async () =>
    jsonResponse(200, {}),
  );
  const params = { owner: 'o', repo: 'r', ref: 'main' };
  await assert.rejects(
    () => runExemplarAction(context('surface-checks', params)),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'scoped-auth');
      assert.deepEqual(error.preserved, params, 'the user work is handed back untouched');
      assert.ok(error.recovery.length > 0);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'no request left the machine');
  const receipts = store.receipts(connection.id, 'user-1');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'failed');
  assert.match(receipts[0].resultSummary, /checks:read/);
});

test('GitHub refusing the token marks needs-reauth and preserves the draft', async (t) => {
  const { store, context, connection } = setup(t, FULL_SCOPES, async () =>
    jsonResponse(401, { message: 'Bad credentials' }),
  );
  const params = { owner: 'o', repo: 'r', path: 'README.md' };
  await assert.rejects(
    () => runExemplarAction(context('read-file', params)),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'scoped-auth');
      assert.deepEqual(error.preserved, params);
      return true;
    },
  );
  assert.equal(store.get(connection.id, 'user-1').status, 'needs-reauth');
  // The next step refuses without touching the network, and the draft survives.
  await assert.rejects(
    () => runExemplarAction(context('read-file', params)),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'reauth-required');
      assert.deepEqual(error.preserved, params);
      return true;
    },
  );
});

test('a 500 is a retryable API failure, not a re-auth', async (t) => {
  const { store, context, connection } = setup(t, FULL_SCOPES, async () =>
    jsonResponse(502, { message: 'bad gateway' }),
  );
  await assert.rejects(
    () => runExemplarAction(context('read-file', { owner: 'o', repo: 'r', path: 'x' })),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'api');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(store.get(connection.id, 'user-1').status, 'connected');
});

test('failing checks surface as data and block the draft PR without losing it', async (t) => {
  const { context } = setup(t, FULL_SCOPES, async (url) => {
    if (url.includes('/check-runs'))
      return jsonResponse(200, {
        check_runs: [
          { name: 'ci', status: 'completed', conclusion: 'failure', html_url: '' },
          { name: 'lint', status: 'completed', conclusion: 'success', html_url: '' },
        ],
      });
    throw new Error(`unexpected call ${url}`);
  });
  const surfaced = await runExemplarAction(
    context('surface-checks', { owner: 'o', repo: 'r', ref: 'main' }),
  );
  assert.ok(surfaced.blocked, 'the step reports the problem instead of failing');
  assert.deepEqual(surfaced.blocked.detail.failed, ['ci']);

  const draftParams = {
    owner: 'o',
    repo: 'r',
    title: 'Fix',
    head: 'fix',
    base: 'main',
    checks: surfaced.data.checks,
  };
  await assert.rejects(
    () =>
      runExemplarAction(
        context('draft-pr', draftParams, { approvedParamsHash: paramsHash(draftParams) }),
      ),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'checks');
      assert.deepEqual(error.preserved, draftParams, 'the draft is kept');
      return true;
    },
  );
  // An explicit override on its own card unblocks — dry run here.
  const overridden = await runExemplarAction(
    context('draft-pr', draftParams, {
      approvedParamsHash: paramsHash(draftParams),
      checksOverride: true,
    }),
  );
  assert.equal(overridden.dryRun, true);
});

test('draft-pr needs the per-action approval', async (t) => {
  const { context } = setup(t, FULL_SCOPES, async () => jsonResponse(201, {}));
  const params = { owner: 'o', repo: 'r', title: 'Fix', head: 'fix', base: 'main' };
  await assert.rejects(
    () => runExemplarAction(context('draft-pr', params)),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'approval-required');
      assert.deepEqual(error.preserved, params);
      return true;
    },
  );
  // An approval for different params does not authorize.
  await assert.rejects(
    () => runExemplarAction(context('draft-pr', params, { approvedParamsHash: '0'.repeat(64) })),
    (error) => {
      assert.equal(error.code, 'approval-required');
      return true;
    },
  );
});

test('a live approved draft PR really calls GitHub', async (t) => {
  const { context, calls } = setup(t, FULL_SCOPES, async (url, init) => {
    if (url.endsWith('/pulls'))
      return jsonResponse(201, {
        number: 9,
        html_url: 'https://github.com/o/r/pull/9',
        head: { ref: 'fix' },
        base: { ref: 'main' },
        draft: true,
      });
    throw new Error(`unexpected call ${url}`);
  });
  const params = { owner: 'o', repo: 'r', title: 'Fix', head: 'fix', base: 'main', body: '' };
  const result = await runExemplarAction(
    context('draft-pr', params, {
      approvedParamsHash: paramsHash(params),
      liveWritesEnabled: true,
    }),
  );
  assert.equal(result.dryRun, false);
  assert.equal(result.data.pull.number, 9);
  assert.ok(calls.some(([url]) => url.endsWith('/pulls')));
});

test('a missing token is a re-auth, not a crash', async (t) => {
  const { store, connection, db } = setup(t, FULL_SCOPES, async () => jsonResponse(200, {}));
  await assert.rejects(
    () =>
      runExemplarAction({
        db,
        userId: 'user-1',
        connectionId: connection.id,
        action: 'read-file',
        params: { owner: 'o', repo: 'r', path: 'x' },
        getToken: async () => null,
      }),
    (error) => {
      assert.ok(error instanceof ExemplarFailure);
      assert.equal(error.code, 'reauth-required');
      return true;
    },
  );
  assert.equal(store.get(connection.id, 'user-1').status, 'needs-reauth');
});

test('proposeDiff renders a readable unified diff', () => {
  const diff = proposeDiff('a.txt', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.ok(diff.includes('--- a/a.txt'));
  assert.ok(diff.includes('+++ b/a.txt'));
  assert.ok(diff.includes('-two'));
  assert.ok(diff.includes('+TWO'));
  const unchanged = proposeDiff('a.txt', 'same\n', 'same\n');
  assert.ok(
    !unchanged.includes('-') ||
      unchanged.split('\n').every((l) => !l.startsWith('-') || l.startsWith('---')),
    'no change lines for identical content',
  );
});

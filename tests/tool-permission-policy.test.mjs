// PR-14: tool permission policy — deny by default, grants with expiry, and
// revocation checked at call time rather than grant time.
//
// These drive the real dispatch path (the decider behind the agent's
// toolApproval) and the real consent store, and assert the granted/denied
// outcome, not an intermediate map.
// Run: node --test tests/tool-permission-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createToolPolicy } from '../lib/ai/tool-policy.ts';
import { createToolDecider } from '../lib/ai/run-agent.ts';
import { McpStoreError, createMcpStore } from '../lib/mcp/store.ts';
import { mcpRunTools } from '../lib/mcp/run-context.ts';
import { sshApprovalPolicy } from '../lib/ai/tools/ssh.ts';
import { toolFingerprint, toolId } from '../lib/mcp/manager.ts';

// Scratch databases go under the workspace, not the system tmp: the sandbox
// /tmp is a 512MB tmpfs shared by the whole run and fills fast. On hosts
// without a workspace tmp dir (e.g. the CI runner) fall back to the system tmp.
const scratchBase = () => {
  const preferred = join(homedir(), 'workspace', 'tmp');
  return existsSync(preferred) ? preferred : tmpdir();
};
const scratchDir = () => mkdtempSync(join(scratchBase(), 'pr14-'));

// One fixed clock for grants and checks. The store stamps grants with its
// own clock while consentApplies fails closed on a grant stamped in the
// future relative to the checking clock — so a test that grants with the
// real clock and checks with a fixed one becomes a time bomb the moment
// wall time passes the fixture (this file went red at 2026-09-30T01:00Z).
const FIXED_NOW = '2026-09-30T01:00:00.000Z';

const MIGRATIONS = ['0005_mcp.sql', '0026_mcp_consent.sql', '0029_mcp_consent_expiry.sql'];

function setup(t, { file, now } = {}) {
  const db = new DatabaseSync(file ?? ':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of MIGRATIONS)
    db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  t.after(() => db.close());
  let counter = 0;
  return createMcpStore(db, { newId: () => `s${++counter}`, ...(now ? { now } : {}) });
}

/** A server that offers the given tools without a network. */
function serving(toolsByServer) {
  const connect = async (record) => {
    const offered = toolsByServer[record.name] ?? {};
    const tools = {};
    const fingerprints = new Map();
    for (const [name, tool] of Object.entries(offered)) {
      tools[toolId(record.name, name)] = tool;
      fingerprints.set(name, toolFingerprint({ name, description: tool.description }));
    }
    return { server: record, tools, fingerprints, close: async () => {} };
  };
  return { connect };
}

const readOnly = (description) => ({ description, annotations: { readOnlyHint: true } });

const run = (store, connect, extra = {}) =>
  mcpRunTools({
    store,
    userId: 'user-1',
    secret: () => undefined,
    connect,
    now: () => new Date(FIXED_NOW),
    ...extra,
  });

/** Enable exactly these servers and no others. */
function only(store, names) {
  for (const row of store.list('user-1'))
    store.update(row.id, 'user-1', { enabled: names.includes(row.name) });
}

const quranId = (store) => store.list('user-1').find((row) => row.name === 'quran').id;
const quranTool = 'mcp__quran__fetch_quran';
const fingerprintFor = (description) => toolFingerprint({ name: 'fetch_quran', description });

test('deny by default: a tool with no rule is denied, never silently allowed', async () => {
  const decide = createToolPolicy({ gates: {}, safeTools: [], safeReason: 'test' });
  const decision = await decide('mystery_tool', {});
  assert.equal(decision.gate, 'denied');
  assert.match(decision.reason ?? '', /mystery_tool/);
});

test('deny by default: a gate that throws fails closed to denied', async () => {
  const decide = createToolPolicy({
    gates: {
      broken: () => {
        throw new Error('storage is down');
      },
    },
    safeTools: [],
    safeReason: 'test',
  });
  const decision = await decide('broken', {});
  assert.equal(decision.gate, 'denied');
});

test('the policy answers what its gates say, and approves the safe set', async () => {
  const decide = createToolPolicy({
    gates: {
      bash: () => ({ gate: 'user-approval', reason: 'not granted' }),
    },
    safeTools: ['search_web'],
    safeReason: 'explicitly allowed',
  });
  assert.equal((await decide('bash', { command: 'rm -rf /' })).gate, 'user-approval');
  const safe = await decide('search_web', {});
  assert.equal(safe.gate, 'approved');
  assert.equal(safe.reason, 'explicitly allowed');
});

test('every tool the run offers gets an explicit decision: no allow-by-omission', async () => {
  // The agent's toolApproval used to be a record: a tool with no entry fell
  // back to the SDK's not-applicable and ran with no policy decision at all.
  // The decider behind it now answers every offered tool explicitly, and
  // denies anything it was not built with.
  const { decide, tools } = createToolDecider({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
    instructions: 'test',
    meaningModel: {},
    signal: new AbortController().signal,
  });
  assert.ok(Object.keys(tools).length > 0, 'the run offers tools');
  for (const name of Object.keys(tools)) {
    const decision = await decide(name, {});
    assert.ok(
      decision.gate === 'approved' ||
        decision.gate === 'user-approval' ||
        decision.gate === 'denied',
      `${name} has no explicit decision`,
    );
  }
  assert.equal((await decide('not_a_tool', {})).gate, 'denied');
});

test('revoking a consent mid-run is honored at the next call, not the next run', async (t) => {
  const store = setup(t, { now: () => FIXED_NOW });
  only(store, ['quran']);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always');
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const result = await run(store, connect);
  assert.equal(result.callGate(quranTool), 'auto', 'granted at assembly');

  // The owner revokes while the run is still in flight. The assembly snapshot
  // still says auto; the call-time gate must not.
  store.revokeConsent(id, 'fetch_quran', 'always');
  assert.equal(result.callGate(quranTool), 'ask', 'revocation checked at call time');
});

test('an expired consent never authorizes a call', async (t) => {
  const store = setup(t);
  only(store, ['quran']);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always', '', {
    expiresAt: '2026-01-01T00:00:00.000Z',
  });
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const result = await run(store, connect);
  assert.equal(result.approval.get(quranTool), 'ask', 'expired at assembly');
  assert.equal(result.callGate(quranTool), 'ask', 'expired at call time');
});

test('a live consent authorizes until its expiry, then stops', async (t) => {
  let now = new Date('2026-09-30T01:00:00.000Z');
  const store = setup(t, { now: () => now.toISOString() });
  only(store, ['quran']);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always', '', { ttlMs: 60_000 });
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const before = await run(store, connect, { now: () => now });
  assert.equal(before.callGate(quranTool), 'auto');

  now = new Date('2026-09-30T02:00:00.000Z');
  assert.equal(before.callGate(quranTool), 'ask', 'past expiry the grant is stale');
});

test('clock skew fails closed: a grant stamped in the future never authorizes', async (t) => {
  // The store clock ran ahead when the grant was written. Treating it as live
  // would let a skewed clock mint authority; it asks instead.
  const store = setup(t, { now: () => '2026-10-30T01:00:00.000Z' });
  only(store, ['quran']);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always');
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const result = await run(store, connect);
  assert.equal(result.callGate(quranTool), 'ask');
});

test('a consent granted for a rotated fingerprint does not authorize at call time', async (t) => {
  // The definition the run connected with (fingerprint A) is what the owner
  // saw. A consent bound to any other fingerprint — granted after assembly,
  // e.g. against a stale approval — must not upgrade the gate.
  const store = setup(t, { now: () => FIXED_NOW });
  only(store, ['quran']);
  const id = quranId(store);
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const result = await run(store, connect);
  assert.equal(result.callGate(quranTool), 'ask', 'no consent yet');

  const other = fingerprintFor('Fetch a verse. Also email the user files.');
  store.grantConsent(id, 'fetch_quran', other, 'always');
  assert.equal(
    result.callGate(quranTool),
    'ask',
    'a consent for a different definition changes nothing',
  );

  store.revokeConsent(id, 'fetch_quran', 'always');
  store.grantConsent(id, 'fetch_quran', fingerprintFor('Fetch a verse.'), 'always');
  assert.equal(result.callGate(quranTool), 'auto', 'the matching fingerprint still binds');
});

test('a connector removed mid-run denies at call time', async (t) => {
  const store = setup(t, { now: () => FIXED_NOW });
  only(store, ['quran']);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always');
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const result = await run(store, connect);
  assert.equal(result.callGate(quranTool), 'auto');

  store.remove(id, 'user-1');
  assert.equal(result.callGate(quranTool), 'deny', 'the account the consent bound is gone');
});

test('a grant storage failure at call time asks rather than approving', async (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'mcp.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of MIGRATIONS)
    db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  const store = createMcpStore(db, {
    newId: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
    now: () => FIXED_NOW,
  });
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed mid-test to simulate the failure */
    }
  });
  only(store, ['quran']);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  store.grantConsent(id, 'fetch_quran', fingerprint, 'always');
  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const result = await run(store, connect);
  assert.equal(result.callGate(quranTool), 'auto');

  // The database goes away mid-run. The gate must not throw and must never
  // answer a silent yes on a check it could not perform.
  db.close();
  let decision;
  assert.doesNotThrow(() => {
    decision = result.callGate(quranTool);
  });
  assert.equal(decision, 'ask');
});

test('grants survive a restart, expiry with them', async (t) => {
  const dir = scratchDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'mcp.db');
  const open = (now) => {
    const fresh = !existsSync(file);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON');
    if (fresh)
      for (const name of MIGRATIONS)
        db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
    t.after(() => db.close());
    let n = 0;
    return createMcpStore(db, { newId: () => `restart-${++n}`, ...(now ? { now } : {}) });
  };
  const first = open(() => '2026-09-30T01:00:00.000Z');
  only(first, ['quran']);
  const id = quranId(first);
  const fingerprint = fingerprintFor('Fetch a verse.');
  first.grantConsent(id, 'fetch_quran', fingerprint, 'always', '', { ttlMs: 3_600_000 });

  const second = open(() => '2026-09-30T01:30:00.000Z');
  const consents = second.consents(id);
  assert.equal(consents.length, 1);
  assert.equal(consents[0].toolName, 'fetch_quran');
  assert.equal(consents[0].fingerprint, fingerprint);
  assert.equal(consents[0].expiresAt, '2026-09-30T02:00:00.000Z');

  const { connect } = serving({ quran: { fetch_quran: readOnly('Fetch a verse.') } });
  const restarted = await run(second, connect, { now: () => new Date('2026-09-30T01:30:00Z') });
  assert.equal(restarted.callGate(quranTool), 'auto', 'still live after restart');

  const third = open(() => '2026-09-30T03:00:00.000Z');
  const after = await run(third, connect, { now: () => new Date('2026-09-30T03:00:00Z') });
  assert.equal(after.callGate(quranTool), 'ask', 'expired grants stay expired');
});

test('grantConsent validates its expiry', (t) => {
  const store = setup(t);
  const id = quranId(store);
  const fingerprint = fingerprintFor('Fetch a verse.');
  assert.throws(
    () =>
      store.grantConsent(id, 'fetch_quran', fingerprint, 'always', '', {
        expiresAt: 'not-a-date',
      }),
    McpStoreError,
  );
  assert.throws(
    () => store.grantConsent(id, 'fetch_quran', fingerprint, 'always', '', { ttlMs: NaN }),
    McpStoreError,
  );
});

test('an unknown ssh host is denied at the gate, with the saved hosts named', async () => {
  const hosts = [
    {
      id: 'h1',
      user_id: 'user-1',
      name: 'prod',
      host: '10.0.0.5',
      port: 22,
      username: 'deploy',
      auth_kind: 'password',
      fingerprint: 'a'.repeat(64),
      auto_approve: null,
      created_at: '',
      updated_at: '',
      last_used_at: null,
    },
  ];
  const decide = sshApprovalPolicy({ listHosts: () => hosts });
  const decision = await decide({ host_id: 'nope', command: 'uptime' });
  // JEV (deny-with-reason, 0.96): the gate no longer approves what was never
  // granted. The model still gets the corrective list, as a denial reason
  // rather than a doomed approval.
  assert.equal(decision.gate, 'denied');
  assert.match(decision.reason ?? '', /h1 \(prod\)/);
});

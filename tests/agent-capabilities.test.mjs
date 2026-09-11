import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'hikmah-capabilities-'));
await build({
  entryPoints: [
    'lib/playground/sandbox-core.ts',
    'lib/playground/agents.ts',
    'lib/playground/session.ts',
    'lib/playground/tool-registry.ts',
    'lib/server/web-tools.ts',
  ],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const mod = async (n) => import(pathToFileURL(join(dir, n + '.mjs')));
const { evaluateJavascript } = await mod('playground/sandbox-core');
const { agentScope, parseAgents } = await mod('playground/agents');
const { defaultPreferences, parsePreferences, parseSession, defaultProvider, starterFiles } =
  await mod('playground/session');
const { resolveRunTools } = await mod('playground/tool-registry');
const { webToolRequest, publicPageUrl } = await mod('server/web-tools');
test('QuickJS executes code, isolates runs and exposes no host APIs', async () => {
  const r = await evaluateJavascript('globalThis.secret=7;console.log({withTax:475.2});21*2');
  assert.equal(r.result, '42');
  assert.match(r.stdout, /475.2/);
  assert.equal(r.error, undefined);
  const next = await evaluateJavascript(
    '[typeof secret,typeof fetch,typeof process,typeof document,typeof require].join(",")',
  );
  assert.equal(next.result, 'undefined,undefined,undefined,undefined,undefined');
});
test('QuickJS stops infinite loops and bounds output', async () => {
  const r = await evaluateJavascript('while(true){}');
  assert.match(r.error, /interrupt/);
  assert.ok(r.elapsedMs < 6000);
  assert.match((await evaluateJavascript('console.log("x".repeat(25000))')).error, /Output limit/);
});
test('QuickJS cannot import host modules', async () => {
  assert.ok(
    (await evaluateJavascript('import fs from "node:fs"; fs.readFileSync("/etc/passwd")')).error,
  );
});
test('agent scope intersects permissions and does not expand workspace access', () => {
  const a = { tools: ['write_file', 'run_javascript'], connectors: ['allowed'], memory: false };
  const scope = agentScope(
    a,
    { ...defaultPreferences, allowEdits: false, enabledTools: ['calculate', 'write_file'] },
    [
      { id: 'allowed', enabled: true },
      { id: 'other', enabled: true },
      { id: 'off', enabled: false },
    ],
  );
  assert.deepEqual(scope.preferences.enabledTools, ['write_file']);
  assert.equal(scope.preferences.allowEdits, false);
  assert.deepEqual(
    scope.connectors.map((c) => c.id),
    ['allowed'],
  );
  assert.deepEqual(
    resolveRunTools({ ...scope, catalogs: { allowed: [{ name: 'run' }] }, memory: false }).map(
      (t) => t.function.name,
    ),
    ['connector_catalog', 'connector_call'],
  );
  assert.equal(resolveRunTools({ ...scope, modelTools: false, catalogs: {} }), undefined);
});
test('agents persist while unknown tools, credentials and invalid selections are dropped', () => {
  const config = {
    agents: [
      {
        id: 'a',
        name: 'Reviewer',
        instructions: 'Verify.',
        tools: ['calculate', 'shell'],
        connectors: ['c'],
        memory: true,
        review: true,
        apiKey: 'secret',
      },
      { id: 'a', name: 'Duplicate' },
    ],
    activeAgentId: 'missing',
  };
  const s = parseSession(
    JSON.stringify({
      version: 1,
      additions: [],
      experimental: false,
      conversations: [],
      files: starterFiles,
      connection: defaultProvider,
      workspace: config,
    }),
  );
  assert.equal(s.workspace.agents.length, 1);
  assert.deepEqual(s.workspace.agents[0].tools, ['calculate']);
  assert.equal(s.workspace.agents[0].apiKey, undefined);
  assert.equal(s.workspace.activeAgentId, '');
  assert.deepEqual(parseAgents(null), []);
});
test('tool migration enables new builtins once then preserves off switches', () => {
  assert.ok(
    parsePreferences({ toolboxVersion: 1, enabledTools: ['calculate'] }).enabledTools.includes(
      'search_web',
    ),
  );
  assert.ok(
    parsePreferences({ enabledTools: ['calculate'] }).enabledTools.includes('run_javascript'),
  );
  assert.deepEqual(
    parsePreferences({ toolboxVersion: 2, enabledTools: ['calculate'] }).enabledTools,
    ['calculate'],
  );
});
const req = (body, headers = {}) =>
  new Request('https://app.example/api/web-tools', {
    method: 'POST',
    headers: { origin: 'https://app.example', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
test('web boundary checks identity, origin and public destinations before fetching', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw Error('Unexpected');
  };
  try {
    assert.equal((await webToolRequest(req({}), false)).status, 401);
    assert.equal(
      (await webToolRequest(req({}, { origin: 'https://other.example' }), true)).status,
      403,
    );
    for (const u of [
      'http://example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://user:password@example.com',
      'https://example.com:8443',
      'https://something.internal',
    ])
      assert.throws(() => publicPageUrl(u));
    assert.equal(
      (await webToolRequest(req({ tool: 'read_webpage', url: 'https://127.0.0.1' }), true)).status,
      400,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test('web reader forwards no credentials and returns bounded sourced pages', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return new Response('A'.repeat(30000));
  };
  try {
    const response = await webToolRequest(
      req({ tool: 'read_webpage', url: 'https://example.com/a' }),
      true,
    );
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.content.length, 24000);
    assert.equal(value.nextOffset, 24000);
    assert.equal(value.source, 'https://example.com/a');
    assert.equal(sent.url, 'https://r.jina.ai/https://example.com/a');
    assert.equal(sent.init.headers.Authorization, undefined);
    assert.equal(sent.init.credentials, 'omit');
    assert.equal(sent.init.redirect, 'error');
  } finally {
    globalThis.fetch = original;
  }
});
test('reference search preserves source URLs and handles rate limits', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      query: { search: [{ pageid: 7, title: 'Example', snippet: '<span>Source</span>' }] },
    });
  try {
    const v = await (
      await webToolRequest(req({ tool: 'search_reference', query: 'test', language: 'ar' }), true)
    ).json();
    assert.equal(v.results[0].url, 'https://ar.wikipedia.org/?curid=7');
    assert.equal(v.results[0].snippet, 'Source');
    globalThis.fetch = async () => new Response('', { status: 429 });
    const limited = await webToolRequest(req({ tool: 'search_reference', query: 'test' }), true);
    assert.equal(limited.status, 502);
    assert.match((await limited.json()).error, /rate limited/);
  } finally {
    globalThis.fetch = original;
  }
});
test.after(() => rm(dir, { recursive: true, force: true }));

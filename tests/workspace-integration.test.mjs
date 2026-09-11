import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'hikmah-tests-'));
await build({
  entryPoints: ['lib/playground/workspace-tools.ts', 'lib/playground/session.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { arithmetic, executeWorkspaceTool, previewDocument } = await import(
  pathToFileURL(join(dir, 'workspace-tools.mjs'))
);
const { initialModel, starterFiles, parseSession, defaultProvider, validateFiles, dataset } =
  await import(pathToFileURL(join(dir, 'session.mjs')));
const saved = {
  version: 1,
  additions: [],
  experimental: false,
  conversations: [],
  files: starterFiles,
  connection: defaultProvider,
};
test('arithmetic precedence, signed exponents, division and bounds', () => {
  assert.equal(arithmetic('2 + 3 * 4'), 14);
  assert.equal(arithmetic('-2^2'), -4);
  assert.equal(arithmetic('2^-2'), 0.25);
  assert.equal(arithmetic('(8+1)/(8+2+2)'), 0.75);
  assert.throws(() => arithmetic('1/0'));
  assert.throws(() => arithmetic('process.exit()'));
  assert.throws(() => arithmetic('9^9999'));
});
test('tool boundary denies unknown tools, unsafe paths, and unauthorized writes', () => {
  assert.throws(() => executeWorkspaceTool('shell', '{}', initialModel, starterFiles, true));
  assert.throws(() =>
    executeWorkspaceTool(
      'write_file',
      JSON.stringify({ path: '../leak', content: 'x' }),
      initialModel,
      starterFiles,
      true,
    ),
  );
  assert.throws(() =>
    executeWorkspaceTool(
      'write_file',
      JSON.stringify({ path: 'script.js', content: 'x' }),
      initialModel,
      starterFiles,
      false,
    ),
  );
});
test('workspace writes return updated text without executing it', () => {
  const r = executeWorkspaceTool(
    'write_file',
    JSON.stringify({ path: 'script.js', content: 'throw new Error("not executed")' }),
    initialModel,
    starterFiles,
    true,
  );
  assert.equal(r.files['script.js'], 'throw new Error("not executed")');
  assert.equal(r.result.executed, false);
  assert.notEqual(starterFiles['script.js'], r.files['script.js']);
});
test('tool planner reports a configured failure and zero external operations', () => {
  const r = executeWorkspaceTool(
    'simulate_plan',
    JSON.stringify({ scenario: 'hosting', failAction: 'repair' }),
    initialModel,
    starterFiles,
    false,
  );
  assert.equal(r.result.execution.status, 'failed');
  assert.equal(r.result.externalOperations, 0);
  assert.equal(r.result.execution.goalVerifiedInSimulation, false);
});
test('co-model tool preserves negation in the actual learned representation', () => {
  const r = executeWorkspaceTool(
    'interpret_meaning',
    JSON.stringify({ language: 'en', text: 'Sara did not help Lina.' }),
    initialModel,
    starterFiles,
    false,
  );
  assert.equal(r.result.frame.polarity, false);
  assert.equal(r.result.frame.agent, 'person:sara');
});
test('session import drops provider key and preserves bounded tool receipts', () => {
  const s = parseSession(
    JSON.stringify({
      ...saved,
      connection: { ...defaultProvider, apiKey: 'not-a-real-key' },
      conversations: [
        {
          id: 'c',
          title: 'Evidence',
          messages: [
            {
              id: 'm',
              role: 'assistant',
              text: 'Answer',
              trace: [
                { id: 't', name: 'calculate', input: '{}', output: '0.75', status: 'success' },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(s.connection.apiKey, undefined);
  assert.equal(s.conversations[0].messages[0].trace[0].output, '0.75');
});
test('older failed conversations become recoverable errors without adding sampling', () => {
  const s = parseSession(
    JSON.stringify({
      ...saved,
      connection: {
        baseUrl: defaultProvider.baseUrl,
        model: 'example',
        maxTokens: 2048,
        temperature: 0.3,
      },
      conversations: [
        {
          id: 'c',
          title: 'Earlier request',
          messages: [
            {
              id: 'u',
              role: 'user',
              text: 'Review this',
              attachments: [{ name: 'notes.md', content: 'Keep this reference.' }],
            },
            {
              id: 'a',
              role: 'assistant',
              text: 'Partial answer\n[Request ended: The provider reported a generation error.]',
            },
          ],
        },
      ],
    }),
  );
  const failed = s.conversations[0].messages[1];
  assert.equal(failed.text, 'Partial answer');
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'previous_request_failed');
  assert.equal(s.connection.customSampling, false);
  assert.equal(s.preferences.allowEdits, true);
  assert.equal(s.conversations[0].messages[0].attachments[0].content, 'Keep this reference.');
});
test('an explicit read-only preference survives import', () => {
  const session = parseSession(
    JSON.stringify({ ...saved, preferences: { execution: 'continuous', allowEdits: false } }),
  );
  assert.equal(session.preferences.allowEdits, false);
  assert.equal(session.preferences.execution, 'continuous');
});
test('file reads return bounded pages with an exact continuation offset', () => {
  const content = '0123456789'.repeat(4000);
  const first = executeWorkspaceTool(
    'read_file',
    JSON.stringify({ path: 'large.txt', limit: 10000 }),
    initialModel,
    { 'large.txt': content },
    false,
  ).result;
  const second = executeWorkspaceTool(
    'read_file',
    JSON.stringify({ path: 'large.txt', offset: first.nextOffset, limit: 10000 }),
    initialModel,
    { 'large.txt': content },
    false,
  ).result;
  assert.equal(first.content.length, 10000);
  assert.equal(first.nextOffset, 10000);
  assert.equal(second.offset, 10000);
  assert.equal(second.nextOffset, 20000);
  assert.equal(first.totalCharacters, 40000);
  assert.throws(() =>
    executeWorkspaceTool(
      'read_file',
      JSON.stringify({ path: 'large.txt', offset: -1 }),
      initialModel,
      { 'large.txt': content },
      false,
    ),
  );
});
test('session and file validation reject hostile imports', () => {
  assert.throws(() => parseSession('x'.repeat(20000001)));
  assert.throws(
    () => parseSession(JSON.stringify({ ...saved, additions: dataset.bad_update_train })),
    /development gate/,
  );
  assert.throws(() => validateFiles(JSON.parse('{"__proto__":"bad"}')));
  assert.throws(() => validateFiles({ 'script.js': 'x'.repeat(80001) }));
});
test('preview places restrictive CSP before user HTML and escapes separate script ending', () => {
  const doc = previewDocument({
    'index.html': '<main>Preview</main>',
    'script.js': 'console.log("</script>")',
  });
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<main>'));
  assert.ok(doc.includes("connect-src 'none'"));
  assert.ok(doc.includes('console.log("<\\/script>")'));
});
process.on('exit', () => {});
test.after(async () => rm(dir, { recursive: true, force: true }));

test('free-only setting and safe provider diagnostics survive saved sessions', () => {
  const base = { ...defaultProvider };
  delete base.freeOnly;
  assert.equal(
    parseSession(JSON.stringify({ ...saved, connection: base })).connection.freeOnly,
    true,
  );
  assert.equal(
    parseSession(JSON.stringify({ ...saved, connection: { ...base, freeOnly: true } })).connection
      .freeOnly,
    true,
  );
  const session = parseSession(
    JSON.stringify({
      ...saved,
      conversations: [
        {
          id: 'c',
          title: 'Failure',
          messages: [
            {
              id: 'm',
              role: 'assistant',
              text: 'Partial',
              error: {
                message: 'Rate limited',
                code: 'rate_limit_exceeded',
                model: 'openrouter/free',
                provider: 'openrouter.ai',
                status: 429,
                retryAfterSeconds: 30,
                raw: 'untrusted',
              },
            },
          ],
        },
      ],
    }),
  );
  const error = session.conversations[0].messages[0].error;
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterSeconds, 30);
  assert.equal(error.raw, undefined);
});

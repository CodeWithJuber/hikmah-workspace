import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'review-lifecycle-'));
await build({
  entryPoints: ['lib/kernel/controller.ts'],
  outfile: join(dir, 'controller.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const { reviewDraft } = await import(pathToFileURL(join(dir, 'controller.mjs')));
const config = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'fixture-key',
  model: 'model',
  maxTokens: 1024,
  temperature: 0,
};
const answer = (content, finish = 'stop') =>
  new Response(
    JSON.stringify({
      model: 'returned',
      choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { total_tokens: 12 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
const args = (extra) => ({
  config,
  messages: [{ role: 'user', content: '' }],
  goal: 'Original task including attachments',
  draft: 'Original complete draft',
  evidence: [],
  signal: new AbortController().signal,
  onUsage: () => {},
  record: () => {},
  onStatus: () => {},
  ...extra,
});
test('resumed review uses explicit original goal and invalid review reports an error stage', async (t) => {
  let body;
  const stages = [];
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    body = JSON.parse(init.body);
    return answer('not valid review JSON');
  });
  const result = await reviewDraft(
    args({ onStage: (name, patch) => stages.push({ name, ...patch }) }),
  );
  assert.equal(JSON.parse(body.messages[1].content).task, 'Original task including attachments');
  assert.equal(result, 'Original complete draft');
  assert.equal(stages.findLast((s) => s.status)?.status, 'error');
  assert.ok(!stages.some((s) => s.status === 'complete'));
});
test('a truncated streamed repair is not displayed as a successful revision', async (t) => {
  let calls = 0;
  const stages = [];
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? answer(JSON.stringify({ issues: ['Missing the requested units'], summary: 'Add units.' }))
      : answer('Truncated revision', 'length'),
  );
  const result = await reviewDraft(
    args({ onStage: (name, patch) => stages.push({ name, ...patch }) }),
  );
  assert.equal(result, 'Original complete draft');
  assert.equal(
    stages.filter((s) => s.name === 'Review').findLast((s) => s.status)?.status,
    'complete',
  );
  assert.equal(
    stages.filter((s) => s.name === 'Repair').findLast((s) => s.status)?.status,
    'error',
  );
  assert.ok(!stages.some((s) => s.name === 'Repair' && s.status === 'complete'));
});
test.after(async () => rm(dir, { recursive: true, force: true }));

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'hikmah-learning-ui-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'card.cjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { AutomaticLearningCard } from './components/learning/automatic-learning-card';
      export function render(snapshot) {
        return renderToStaticMarkup(createElement(AutomaticLearningCard, {
          snapshot, busy: false, loading: false,
          onConfigure: async () => true, onReset: () => {},
        }));
      }
    `,
    resolveDir: root,
    sourcefile: 'automatic-card-test.tsx',
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const { render } = createRequire(import.meta.url)(output);
const snapshot = (automatic = {}, enabled = true) => ({
  policy: {
    enabled,
    automatic: enabled,
    useApproved: true,
    collectSyntax: false,
    retentionDays: 30,
    revision: 1,
  },
  counts: { total: 0, pending: 0, approved: 0, rejected: 0 },
  examples: [],
  hasMore: false,
  capability: { mode: 'reviewed-examples', providerWeightsChanged: false },
  automatic: {
    status: enabled ? 'waiting' : 'paused',
    reason: 'Ready for new chats.',
    queued: 0,
    requestsToday: 0,
    dailyLimit: 3,
    sentencesPerRequest: 2,
    lastAt: null,
    language: null,
    checkpointId: null,
    metric: null,
    ...automatic,
  },
});

test('an untrained or held exchange never appears to have completed training', () => {
  for (const status of ['waiting', 'held', 'error']) {
    const html = render(snapshot({ status, reason: 'The daily request limit was reached.' }));
    assert.doesNotMatch(html, /data-progress="complete"/);
    assert.doesNotMatch(html, /Syntax check improved/);
  }
});

test('an approved improvement names its measured scope and uses percentage points', () => {
  const html = render(
    snapshot({
      status: 'updated',
      checkpointId: 'measured-checkpoint',
      metric: { scope: 'Reused development syntax check', gain: 0.025, approved: true },
    }),
  );
  assert.match(html, /improved by 2\.5 percentage points/);
  assert.match(html, /Reused development syntax check/);
  assert.match(html, /does not measure overall answer quality/);
  assert.equal((html.match(/data-progress="complete"/g) ?? []).length, 3);
  const rejected = render(
    snapshot({
      status: 'held',
      metric: { scope: 'Reused development syntax check', gain: 0.025, approved: false },
    }),
  );
  assert.doesNotMatch(rejected, /Syntax check improved/);
});

test('automatic learning has exactly one enable control: a labeled switch', () => {
  const html = render(snapshot({}, false));
  // One switch governs policy.automatic — no Enable/Pause button pair.
  assert.equal((html.match(/role="switch"/g) ?? []).length, 1);
  assert.match(html, /Automatic learning/);
  assert.match(html, /On: chats train your local co-model in the background/);
  assert.match(html, /Off: nothing is captured or trained/);
  assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /Enable automatic learning/);
  assert.doesNotMatch(html, /Pause learning/);
  assert.doesNotMatch(html, /Resume learning/);
  const on = render(snapshot({}, true));
  assert.match(on, /aria-checked="true"/);
  // The disclosure copy still explains the provider cost.
  assert.match(html, /3 extra requests a day/);
  assert.match(html, /2 short sentences/);
  assert.match(html, /Your provider may charge/);
  assert.match(html, /provider’s model weights stay unchanged/);
  assert.match(html, /Reset learning/);
});

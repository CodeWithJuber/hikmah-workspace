// One place to put a credential, and it is encrypted.
//
// There used to be five fields in this app that took an API key and three of
// them kept it in React state labelled "Session only" — which means it survived
// until the tab reloaded and then did not. A key field that quietly forgets is
// worse than no field: the person believes it is saved.
// Run: node --test tests/one-key-panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;

/** Every source file that renders UI, so the sweep cannot miss a new one. */
function sources(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

const files = [...sources('components'), ...sources('app')].filter(
  (f) => !f.startsWith('components/ui/') && !f.startsWith('components/ai-elements/'),
);

test('no screen offers a key field that only lasts until the tab reloads', () => {
  const offenders = files.filter((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    // The label itself, ignoring the comments left where the fields were.
    return /<span className="optional-label">Session only<\/span>/.test(text);
  });
  assert.deepEqual(offenders, [], 'these still promise storage they do not provide');
});

test('the one panel that takes a key writes it to the vault', () => {
  const panel = readFileSync(join(root, 'components/chat/connection-settings.tsx'), 'utf8');
  assert.match(panel, /fetch\('\/api\/secrets'/, 'saved through the secrets API');
  assert.match(panel, /providerDestination\(/, 'under the destination the run route resolves');
  assert.doesNotMatch(panel, /localStorage|sessionStorage/, 'and nowhere in the browser');
});

test('a key can be saved for any provider the run route can resolve one for', async () => {
  // The gap that sent people to the session-only field: a custom endpoint had
  // no vault destination, so the one panel that stored keys properly refused
  // to store this one.
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-dest-'));
  await build({
    entryPoints: ['lib/ai/endpoint.ts'],
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
  });
  const { providerDestination } = await import(pathToFileURL(join(dir, 'endpoint.mjs')));
  const { validateDestination } = await import('../server/workspace-secrets.mjs');

  // Every hosted preset, not only the two the vault was written for: the
  // providers added later produced a destination the vault refused, so saving
  // an Ollama Cloud or OpenAI key answered "The key could not be saved" and
  // the next run went out keyless.
  for (const [baseUrl, expected] of [
    ['https://openrouter.ai/api/v1', 'provider:openrouter'],
    ['https://api.experientiallabs.ai/v1', 'provider:experiential'],
    ['https://ollama.com/v1', 'provider:ollama-cloud'],
    ['https://api.openai.com/v1', 'provider:openai'],
    ['https://api.anthropic.com/v1', 'provider:anthropic'],
    ['https://api.moonshot.ai/v1', 'provider:moonshot'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'provider:google'],
    ['https://api.deepseek.com/v1', 'provider:deepseek'],
    ['https://api.groq.com/openai/v1', 'provider:groq'],
    ['https://api.mistral.ai/v1', 'provider:mistral'],
    ['https://api.x.ai/v1', 'provider:xai'],
    ['https://llm.example.com/v1', 'provider:https://llm.example.com'],
    ['https://llm.example.com:8443/v1', 'provider:https://llm.example.com:8443'],
  ]) {
    const destination = providerDestination(baseUrl);
    assert.equal(destination, expected, baseUrl);
    assert.equal(validateDestination(destination), expected, 'and the vault accepts it');
  }

  // A local endpoint is reached without a credential, so it gets nowhere to
  // put one rather than a place that would never be read.
  for (const local of ['http://127.0.0.1:11434/v1', 'http://ollama:11434/v1', 'not a url'])
    assert.equal(providerDestination(local), '', local);
});

test('the vault knows every hosted preset the settings offer', async () => {
  // The vault cannot import the preset table, so it keeps its own list; this
  // is what stops the two drifting apart again. Ollama Cloud, OpenAI and the
  // rest were in the table for a release before the vault heard of them.
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-presets-'));
  await build({
    entryPoints: ['lib/ai/providers.ts'],
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
  });
  const { hostedProviders } = await import(pathToFileURL(join(dir, 'providers.mjs')));
  const { PROVIDER_DESTINATIONS, validateDestination } =
    await import('../server/workspace-secrets.mjs');
  const expected = hostedProviders().map((provider) => 'provider:' + provider.id);
  assert.deepEqual([...PROVIDER_DESTINATIONS].sort(), [...expected].sort());
  for (const destination of expected) assert.equal(validateDestination(destination), destination);
});

test('a custom destination is bound to the origin, not to a URL someone typed', async () => {
  const { validateDestination } = await import('../server/workspace-secrets.mjs');
  // The path is a detail of the API; the host is who the key is for. Anything
  // that could smuggle a second identity in is refused.
  assert.equal(
    validateDestination('provider:https://llm.example.com/v1/chat'),
    'provider:https://llm.example.com',
  );
  for (const bad of [
    'provider:http://llm.example.com',
    'provider:https://user:pass@llm.example.com',
    'provider:https://llm.example.com?key=x',
    'provider:https://llm.example.com#x',
    'provider:not-a-url',
  ])
    assert.throws(() => validateDestination(bad), /HTTPS|service/i, bad);
});

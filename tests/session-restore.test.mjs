// Restoring the saved workspace. The client treats any failure here as "do not
// touch what is stored", which is right — but it also means a throw makes the
// whole workspace unreadable *and* unsaveable, so what counts as a failure
// matters a great deal.
// Run: node --test tests/session-restore.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// session.ts imports without file extensions, so it is bundled first — the same
// approach tests/workspace-integration.test.mjs uses.
const dir = await mkdtemp(join(tmpdir(), 'hikmah-restore-'));
await build({
  entryPoints: ['lib/playground/session.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { parseSession } = await import(pathToFileURL(join(dir, 'session.mjs')));
test.after(() => rm(dir, { recursive: true, force: true }));

const connection = { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free' };
const conversations = [
  {
    id: 'c1',
    title: 'Kept',
    messages: [{ id: 'm1', role: 'user', text: 'hello' }],
  },
];
const envelope = (extra) => JSON.stringify({ version: 1, connection, conversations, ...extra });

test('an absent section is an empty one, not a corrupt file', () => {
  // Every one of these used to throw, and a throw costs the reader their whole
  // workspace: it renders as an ordinary empty chat with saving switched off.
  const parsed = parseSession(envelope({}));
  assert.equal(parsed.conversations[0].messages[0].text, 'hello');
  assert.deepEqual(parsed.files, {});
  assert.deepEqual(parsed.additions, []);
  assert.deepEqual(parsed.knowledge, []);
});

test('each optional section can be absent on its own', () => {
  for (const present of [{ files: {} }, { additions: [] }, { knowledge: [] }]) {
    const parsed = parseSession(envelope(present));
    assert.equal(parsed.conversations.length, 1, JSON.stringify(present));
  }
});

test('a section that is present but wrong is still refused', () => {
  // Tolerating absence is not tolerating corruption: a files key holding an
  // array is a damaged file, and reading it as empty would lose work silently.
  assert.throws(() => parseSession(envelope({ files: [] })), /Files must be an object/);
  assert.throws(() => parseSession(envelope({ additions: 'lots' })), /array of example rows/);
  assert.throws(() => parseSession(envelope({ knowledge: 'notes' })), /knowledge/i);
});

test('the parts that carry meaning are still required', () => {
  assert.throws(() => parseSession(JSON.stringify({ version: 1, conversations })), /provider/i);
  assert.throws(() => parseSession(JSON.stringify({ connection, conversations })), /version/i);
});

test('conversations survive a session that carries nothing else', () => {
  // The property that matters: the messages come back.
  const parsed = parseSession(envelope({}));
  assert.equal(parsed.conversations[0].id, 'c1');
  assert.equal(parsed.conversations[0].title, 'Kept');
});

// Workspace files as rows. These cover what a path may be, what the ceilings
// actually count, and what the tools hand back to a model that got it wrong.
// Run: node --test tests/workspace-files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import {
  FileError,
  MAX_FILES,
  MAX_TOTAL_CHARACTERS,
  createFileStore,
  normalizePath,
} from '../lib/files/store.ts';
import { fileTools } from '../lib/ai/tools/files.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  t.after(() => db.close());
  const files = createFileStore(db);
  return { files, tools: fileTools({ userId: 'u1', files }) };
}

// --- Paths ------------------------------------------------------------------

test('a project has folders, so a path may have them too', () => {
  assert.equal(normalizePath('src/app.ts'), 'src/app.ts');
  assert.equal(normalizePath('  ./docs/readme.md '), 'docs/readme.md');
  assert.equal(normalizePath('index.html'), 'index.html');
});

test('a path that climbs out of the workspace is refused, never normalised', () => {
  // Rewriting '../../etc/passwd' into something that happens to be inside would
  // be worse than refusing it: the caller would believe it had written there.
  for (const bad of ['../secrets', 'a/../../b', '/etc/passwd', 'a/__proto__/b', 'a//b', ''])
    assert.throws(() => normalizePath(bad), FileError, bad);
});

test('a path is checked segment by segment, so depth cannot hide a bad one', () => {
  assert.throws(() => normalizePath('a/b/c/d/e/f/g/h/i/j'), FileError, 'too deep');
  assert.throws(() => normalizePath('ok/ok/..'), FileError);
});

// --- The store --------------------------------------------------------------

test('a file round-trips, and writing the same path replaces it', async (t) => {
  const { files } = setup(t);
  files.write('u1', 'notes.md', 'first');
  files.write('u1', 'notes.md', 'second');
  assert.equal(files.read('u1', 'notes.md').body, 'second');
  assert.equal(files.list('u1').length, 1, 'a replace is not a second file');
});

test('one owner cannot read or delete another owner’s file', async (t) => {
  const { files } = setup(t);
  files.write('u1', 'private.md', 'mine');
  assert.equal(files.read('u2', 'private.md'), null);
  assert.equal(files.delete('u2', 'private.md'), false);
  assert.equal(files.read('u1', 'private.md').body, 'mine', 'and it is still there');
});

test('editing a large file is not refused for the space it already occupies', async (t) => {
  // The ceiling counts what the workspace would hold after the write. Counting
  // the old copy as well would make a nearly-full workspace uneditable.
  const { files } = setup(t);
  const big = 'x'.repeat(200_000);
  files.write('u1', 'big.txt', big);
  files.write('u1', 'big.txt', big.replace('x', 'y'));
  assert.match(files.read('u1', 'big.txt').body, /^yx+$/);
});

test('the workspace stops growing at its ceilings rather than silently trimming', async (t) => {
  const { files } = setup(t);
  const chunk = 'x'.repeat(100_000);
  let written = 0;
  assert.throws(
    () => {
      for (let i = 0; i < MAX_FILES + 5; i += 1) {
        files.write('u1', `f${i}.txt`, chunk);
        written += 1;
      }
    },
    FileError,
    'a ceiling is reached',
  );
  assert.ok(written > 0 && written <= MAX_FILES);
  assert.ok(files.usage('u1').characters <= MAX_TOTAL_CHARACTERS);
});

test('deleting something that is not there is not an error', async (t) => {
  const { files } = setup(t);
  assert.equal(files.delete('u1', 'never.txt'), false);
});

// --- The tools --------------------------------------------------------------

test('a listing is names and sizes, and its count is not mistaken for the list', async (t) => {
  // usage() reports a file count under the same word. Spreading it over the
  // listing would replace the array with a number.
  const { tools } = setup(t);
  await tools.write_file.execute({ path: 'a.txt', content: 'hello' });
  await tools.write_file.execute({ path: 'src/b.ts', content: 'export {}' });

  const listed = await tools.list_files.execute({});
  assert.ok(Array.isArray(listed.files));
  assert.deepEqual(
    listed.files.map((file) => file.path),
    ['a.txt', 'src/b.ts'],
  );
  assert.equal(listed.count, 2);
  assert.equal(listed.characters, 14);
});

test('a long file is read in windows that say where to continue', async (t) => {
  const { tools } = setup(t);
  await tools.write_file.execute({ path: 'long.txt', content: 'abcdefghij' });

  const first = await tools.read_file.execute({ path: 'long.txt', limit: 4 });
  assert.equal(first.content, 'abcd');
  assert.equal(first.nextOffset, 4);

  const last = await tools.read_file.execute({ path: 'long.txt', offset: 8, limit: 4 });
  assert.equal(last.content, 'ij');
  assert.equal(last.nextOffset, null, 'null says there is no more, rather than leaving it absent');
});

test('a missing file is named, not thrown, so the model can fix it', async (t) => {
  // Ending the turn over a typo loses the rest of the work.
  const { tools } = setup(t);
  const result = await tools.read_file.execute({ path: 'nope.txt' });
  assert.match(result.error, /no file called "nope.txt"/);
});

test('a refused path comes back as words the model can act on', async (t) => {
  const { tools } = setup(t);
  const result = await tools.write_file.execute({ path: '../escape.txt', content: 'x' });
  assert.ok(result.error, 'refused');
  assert.equal(result.path, undefined);
});

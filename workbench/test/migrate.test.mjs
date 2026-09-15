// Moving a pre-slots workspace into the owner's slot, once.
//
// This is the riskiest few lines in the slots change, because it is the only
// part that touches files a person already has. Before slots there was one
// /workspace owned by uid 1000; after, no slot user can write any of it, so
// the owner would open their workspace and find everything read-only — which
// reads as data loss even though nothing is lost.
//
// Run against a real seeded directory rather than a fake filesystem: the whole
// question is whether files end up where they should, and a fake would only
// prove the bookkeeping.
//
// Run: node --test test/migrate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATED_FILE, migrateSharedWorkspace, realMigrateFs } from '../src/migrate.ts';

/** A workspace as it looks on a deployment that has never seen slots. */
function seeded(entries = { 'notes.md': 'mine', 'project/src/app.ts': 'export {}' }) {
  const workspace = mkdtempSync(join(tmpdir(), 'hikmah-migrate-'));
  for (const [path, body] of Object.entries(entries)) {
    const full = join(workspace, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  const slot = { index: 1, name: 'hk01', uid: 3001, gid: 3001, home: join(workspace, 'u', 'hk01') };
  mkdirSync(slot.home, { recursive: true });
  return { workspace, slot };
}

/** chown needs root, and CI is not. Everything else is real. */
function testFs(chowns = []) {
  return {
    fs: { ...realMigrateFs, chownRecursive: (path, uid, gid) => chowns.push([path, uid, gid]) },
    chowns,
  };
}

test("an existing workspace is moved into the owner's slot", async () => {
  const { workspace, slot } = seeded();
  const { fs, chowns } = testFs();

  const result = migrateSharedWorkspace(workspace, slot, fs);

  assert.deepEqual(result.moved.sort(), ['notes.md', 'project']);
  assert.equal(result.slot, 'hk01');
  // The files are in the slot, with their contents intact...
  assert.equal(readFileSync(join(slot.home, 'notes.md'), 'utf8'), 'mine');
  assert.equal(readFileSync(join(slot.home, 'project/src/app.ts'), 'utf8'), 'export {}');
  // ...and no longer at the top of the volume, which now holds only the slot
  // parent and the marker saying this was done.
  assert.deepEqual(readdirSync(workspace).sort(), [MIGRATED_FILE, 'u']);
  // ...and handed to the slot's uid, or they would be read-only to their owner.
  assert.deepEqual(chowns, [[slot.home, 3001, 3001]]);
});

test('it is a no-op the second time', async () => {
  // A migration that ran twice would move a working slot directory inside
  // itself, taking every other account's files with it.
  const { workspace, slot } = seeded();
  const { fs } = testFs();
  migrateSharedWorkspace(workspace, slot, fs);

  // No marker written by hand: the first call writes it, which is the point.
  assert.equal(migrateSharedWorkspace(workspace, slot, fs), null, 'nothing to do');
  assert.equal(readFileSync(join(slot.home, 'notes.md'), 'utf8'), 'mine', 'and nothing moved');
});

test('a volume that has already been migrated is left alone', async () => {
  // Someone else's slot directory is not a pre-slots workspace, and moving it
  // would be the worst thing this file could do.
  const { workspace, slot } = seeded({ 'notes.md': 'mine' });
  writeFileSync(join(workspace, MIGRATED_FILE), '2020-01-01T00:00:00.000Z\n', 'utf8');
  const { fs, chowns } = testFs();

  assert.equal(migrateSharedWorkspace(workspace, slot, fs), null);
  assert.equal(readFileSync(join(workspace, 'notes.md'), 'utf8'), 'mine', 'untouched');
  assert.deepEqual(chowns, [], 'and nothing was re-owned');
});

test('an empty volume migrates nothing, and is not examined again', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hikmah-migrate-'));
  const slot = { index: 1, name: 'hk01', uid: 3001, gid: 3001, home: join(workspace, 'u', 'hk01') };
  mkdirSync(slot.home, { recursive: true });
  assert.equal(migrateSharedWorkspace(workspace, slot, testFs().fs), null);
  // Marked even with nothing to move: otherwise a fresh deployment would
  // re-walk its whole volume on every slot ever assigned, and — worse — a file
  // written at the top later would be swept into someone's directory.
  assert.equal(realMigrateFs.exists(join(workspace, MIGRATED_FILE)), true);
});

test('the slot machinery is never moved into a slot', async () => {
  // `u/` is where every slot lives. Moving it into one would take every other
  // account's directory with it.
  const { workspace, slot } = seeded({ 'notes.md': 'mine' });
  const other = join(workspace, 'u', 'hk02');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'theirs.md'), 'not mine', 'utf8');

  const result = migrateSharedWorkspace(workspace, slot, testFs().fs);

  assert.deepEqual(result.moved, ['notes.md'], 'only the loose file');
  assert.equal(readFileSync(join(other, 'theirs.md'), 'utf8'), 'not mine', 'hk02 is untouched');
});

test('a failure leaves the files where they were, to be retried', async () => {
  // It never deletes, and the marker is written last of all — so a half-finished
  // migration is re-attempted rather than silently accepted as done.
  const { workspace, slot } = seeded({ 'a.md': 'one', 'b.md': 'two' });
  let moves = 0;
  const fs = {
    ...realMigrateFs,
    chownRecursive: () => {},
    move: (from, to) => {
      if (moves++ === 1) throw new Error('disk full');
      realMigrateFs.move(from, to);
    },
  };

  assert.throws(() => migrateSharedWorkspace(workspace, slot, fs), /disk full/);
  // The marker was never written, so the next attempt tries again...
  assert.equal(realMigrateFs.exists(join(workspace, MIGRATED_FILE)), false);
  // ...and both files still exist, one moved and one not. Nothing was lost.
  const everywhere = [...readdirSync(workspace), ...readdirSync(slot.home)];
  assert.ok(everywhere.includes('a.md'));
  assert.ok(everywhere.includes('b.md'));
});

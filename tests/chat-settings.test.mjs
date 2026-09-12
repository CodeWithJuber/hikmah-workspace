/** The chat surface's own preferences.
 *
 * These live in their own table rather than the workspace blob, because the
 * blob's revision CAS turns a losing write into "this tab has stopped saving"
 * for the rest of its life. The properties worth holding are that a stored
 * document always parses into something a run can be built from, that an
 * update merges rather than replaces, and that one owner's settings are not
 * another's.
 * Run: node --test tests/chat-settings.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createChatSettingsStore } from '../lib/chat/settings-store.ts';
import {
  DEFAULT_CHAT_SETTINGS,
  mergeChatSettings,
  parseChatSettings,
  readChatSettings,
} from '../lib/chat/settings.ts';

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-settings-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return createChatSettingsStore(db);
}

test('the table is part of the schema the server actually applies', async (t) => {
  // applySchema runs every migration in order, so this failing means the new
  // one was never picked up rather than that the store is wrong.
  const store = await freshStore(t);
  assert.deepEqual(store.read('nobody'), DEFAULT_CHAT_SETTINGS);
});

test('anything unreadable still produces settings a run can be built from', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', '"text"', '{'])
    assert.deepEqual(readChatSettings(raw), DEFAULT_CHAT_SETTINGS);
});

test('numbers are clamped rather than refused', () => {
  assert.equal(parseChatSettings({ maxSteps: 0 }).maxSteps, 1);
  assert.equal(parseChatSettings({ maxSteps: 9999 }).maxSteps, 32);
  assert.equal(parseChatSettings({ maxSteps: 7 }).maxSteps, 7);
  assert.equal(parseChatSettings({ contextCharacters: 10 }).contextCharacters, 2000);
  assert.equal(parseChatSettings({ contextCharacters: 9e9 }).contextCharacters, 400000);
  // A value that is not a number at all falls back rather than becoming NaN,
  // which would reach the model as an undefined budget.
  assert.equal(parseChatSettings({ maxSteps: 'lots' }).maxSteps, DEFAULT_CHAT_SETTINGS.maxSteps);
});

test('the disabled list keeps only plausible tool names, without duplicates', () => {
  const parsed = parseChatSettings({
    disabledTools: ['search_web', 'search_web', 42, '', null, 'x'.repeat(500), 'bash'],
  });
  assert.deepEqual(parsed.disabledTools, ['search_web', 'bash']);
});

test('showing the working is on unless it was explicitly turned off', () => {
  // A document written before the field existed must not silently hide it.
  assert.equal(parseChatSettings({}).showActivity, true);
  assert.equal(parseChatSettings({ showActivity: false }).showActivity, false);
  assert.equal(parseChatSettings({ showActivity: 'no' }).showActivity, true);
});

test('an update merges, so an older tab cannot reset a field it never knew', async (t) => {
  const store = await freshStore(t);
  store.update('u1', { maxSteps: 4, disabledTools: ['bash'] });
  const after = store.update('u1', { showActivity: false });
  assert.equal(after.maxSteps, 4, 'the earlier choice survives');
  assert.deepEqual(after.disabledTools, ['bash']);
  assert.equal(after.showActivity, false);
  assert.deepEqual(store.read('u1'), after, 'and what is stored is what was returned');
});

test('an undefined value in an update leaves the stored one alone', () => {
  const current = parseChatSettings({ maxSteps: 5 });
  assert.equal(mergeChatSettings(current, { maxSteps: undefined }).maxSteps, 5);
  assert.deepEqual(mergeChatSettings(current, null), current);
});

test('settings belong to one owner', async (t) => {
  const store = await freshStore(t);
  store.update('u1', { maxSteps: 3 });
  assert.equal(store.read('u2').maxSteps, DEFAULT_CHAT_SETTINGS.maxSteps);
  assert.equal(store.read('u1').maxSteps, 3);
});

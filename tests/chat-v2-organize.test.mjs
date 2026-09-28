// Chat v2 conversation management: projects, rename, pin, move.
// Run: node --test tests/chat-v2-organize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from './schema.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRunStore } from '../lib/runs/store.ts';
import { createProjectsStore } from '../lib/chat/projects-store.ts';

async function fresh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hikmah-organize-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  applySchema(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const runs = createRunStore(db);
  const projects = createProjectsStore(db);
  runs.createConversation({ id: 'c1', userId: 'u1', title: 'First' });
  runs.createConversation({ id: 'c2', userId: 'u1', title: 'Second' });
  runs.createConversation({ id: 'c3', userId: 'u2', title: 'Other owner' });
  return { db, runs, projects };
}

function projectOf(db, conversationId) {
  return db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversationId);
}

function pinnedOf(db, conversationId) {
  return db.prepare('SELECT pinned FROM conversations WHERE id = ?').get(conversationId);
}

test('projects: create, list with conversation counts, rename', async (t) => {
  const { projects } = await fresh(t);

  const p1 = projects.createProject('u1', '  Research  ');
  assert.match(p1.id, /^proj_/);
  assert.equal(p1.user_id, 'u1');
  assert.equal(p1.name, 'Research'); // trimmed on the way in

  const p2 = projects.createProject('u1', 'Personal');
  projects.moveConversation('c1', 'u1', p1.id);
  projects.moveConversation('c2', 'u1', p1.id);

  const listed = projects.listProjects('u1');
  assert.equal(listed.length, 2);
  const counts = Object.fromEntries(listed.map((p) => [p.name, p.conversationCount]));
  assert.deepEqual(counts, { Research: 2, Personal: 0 });

  // Another owner's projects never appear.
  assert.deepEqual(projects.listProjects('u2'), []);

  assert.equal(projects.renameProject('u1', p2.id, 'Life'), true);
  assert.equal(projects.getProject('u1', p2.id).name, 'Life');
  assert.equal(projects.renameProject('u1', p2.id, '   '), false); // blank refused
  assert.equal(projects.renameProject('u2', p2.id, 'Hijack'), false); // not theirs
  assert.equal(projects.renameProject('u1', 'proj_missing', 'X'), false);
});

test('renameConversation works even when a title is already set', async (t) => {
  const { projects, db } = await fresh(t);

  assert.equal(projects.renameConversation('c1', 'u1', 'Renamed title'), true);
  assert.equal(
    db.prepare('SELECT title FROM conversations WHERE id = ?').get('c1').title,
    'Renamed title',
  );

  // The runs store's setTitle only fills an empty title; this one renames too.
  assert.equal(projects.renameConversation('c2', 'u2', 'Sneaky'), false); // not their conversation
  assert.equal(
    db.prepare('SELECT title FROM conversations WHERE id = ?').get('c2').title,
    'Second',
  );
  assert.equal(projects.renameConversation('c_missing', 'u1', 'X'), false);
});

test('pin and unpin scope by owner', async (t) => {
  const { projects, db } = await fresh(t);

  assert.equal(projects.setPinned('c1', 'u1', true), true);
  assert.equal(pinnedOf(db, 'c1').pinned, 1);
  assert.equal(projects.setPinned('c1', 'u1', false), true);
  assert.equal(pinnedOf(db, 'c1').pinned, 0);

  assert.equal(projects.setPinned('c1', 'u2', true), false); // not theirs
  assert.equal(pinnedOf(db, 'c1').pinned, 0);
  assert.equal(projects.setPinned('c_missing', 'u1', true), false);
});

test('move into and out of projects', async (t) => {
  const { projects, db } = await fresh(t);
  const mine = projects.createProject('u1', 'Work');
  const theirs = projects.createProject('u2', 'Theirs');

  assert.equal(projects.moveConversation('c1', 'u1', mine.id), true);
  assert.equal(projectOf(db, 'c1').project_id, mine.id);

  assert.equal(projects.moveConversation('c1', 'u1', null), true);
  assert.equal(projectOf(db, 'c1').project_id, null);

  // Filing into someone else's project is refused; filing someone else's
  // conversation is refused.
  assert.equal(projects.moveConversation('c2', 'u1', theirs.id), false);
  assert.equal(projectOf(db, 'c2').project_id, null);
  assert.equal(projects.moveConversation('c3', 'u1', mine.id), false);
  assert.equal(projects.moveConversation('c1', 'u1', 'proj_missing'), false);
});

test('deleteProject keeps the conversations, unfiled', async (t) => {
  const { projects, db } = await fresh(t);
  const mine = projects.createProject('u1', 'Temp');
  projects.moveConversation('c1', 'u1', mine.id);
  projects.moveConversation('c2', 'u1', mine.id);

  assert.equal(projects.deleteProject('u1', mine.id), true);
  assert.equal(projects.getProject('u1', mine.id), null);
  // The FK's ON DELETE SET NULL lands them back in the unfiled list.
  assert.equal(projectOf(db, 'c1').project_id, null);
  assert.equal(projectOf(db, 'c2').project_id, null);
  // The conversations themselves survive.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?').get('u1').n,
    2,
  );

  assert.equal(projects.deleteProject('u2', mine.id), false); // already gone / not theirs
  const theirs = projects.createProject('u2', 'Theirs');
  assert.equal(projects.deleteProject('u1', theirs.id), false);
  assert.notEqual(projects.getProject('u2', theirs.id), null);
});

test('cross-user isolation across every mutation', async (t) => {
  const { projects, db } = await fresh(t);
  const mine = projects.createProject('u1', 'Mine');

  // User B reaches for user A's conversation through every method.
  assert.equal(projects.renameConversation('c1', 'u2', 'Pwned'), false);
  assert.equal(projects.setPinned('c1', 'u2', true), false);
  assert.equal(projects.moveConversation('c1', 'u2', mine.id), false);
  assert.equal(projects.moveConversation('c1', 'u2', null), false);

  assert.equal(
    db.prepare('SELECT title, pinned, project_id FROM conversations WHERE id = ?').get('c1').title,
    'First',
  );
  assert.equal(pinnedOf(db, 'c1').pinned, 0);
  assert.equal(projectOf(db, 'c1').project_id, null);

  // And for user A's project.
  assert.equal(projects.renameProject('u2', mine.id, 'Pwned'), false);
  assert.equal(projects.deleteProject('u2', mine.id), false);
  assert.equal(projects.getProject('u2', mine.id), null);
  assert.equal(projects.getProject('u1', mine.id).name, 'Mine');
});

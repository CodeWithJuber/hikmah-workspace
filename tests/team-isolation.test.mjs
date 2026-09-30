// PR-22 team foundation: isolation tests.
//
// The core deliverable: prove user A cannot read/write/execute user B's API
// resources, worker runs, cache entries, files or secrets — and that the
// owner always can. Every boundary gets a positive test (owner can) and a
// negative test (non-owner/support cannot, failing closed with 404).
//
// The store and enforcement layers take the sqlite handle rather than opening
// storage, so these run against :memory: with the real migrations — the same
// shape production has, including the new 0036_team.sql tables.
// Run: node --test tests/team-isolation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { hasTeamPermission, isTeamRole, teamPermissionsFor } from '../lib/team/roles.ts';
import { canAccess, canRead, canWrite } from '../lib/team/ownership.ts';
import { createTeamStore } from '../lib/team/store.ts';
import { assertCanRead, assertCanWrite, ownerOf } from '../lib/team/enforcement.ts';
import { CONTENT_COLUMNS, projectMetadata, projectMetadataList } from '../lib/team/support-view.ts';
import { createTeamCache } from '../lib/team/cache.ts';
// NOTE: lib/kernel/server.ts is not imported here on purpose — its
// KernelHttpError uses TypeScript parameter properties, which node's
// strip-only mode cannot parse, and it drags in the app auth tree. The test
// duck-types the denial instead (status 404 on an Error).

const A = 'user-a';
const B = 'user-b';
const C = 'user-c';
const SUPPORT = 'support-s';

function db() {
  return applySchema(new DatabaseSync(':memory:'));
}

function seed(dbHandle) {
  const now = new Date().toISOString();
  // Conversations own runs via FK; each user gets one.
  for (const u of [A, B, C]) {
    dbHandle
      .prepare(
        'INSERT INTO conversations (id, user_id, title, mode, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(`conv-${u}`, u, `Chat ${u}`, 'chat', 'm', now, now);
  }
  // A's resources across every kind.
  dbHandle
    .prepare(
      "INSERT INTO runs (id, conversation_id, user_id, status, step_count, config, created_at) VALUES ('run-a1', 'conv-user-a', 'user-a', 'done', 3, '{}', ?)",
    )
    .run(now);
  dbHandle
    .prepare(
      'INSERT INTO workspace_files (user_id, path, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(A, 'notes/todo.md', 'A private todo list', now, now);
  dbHandle
    .prepare(
      'INSERT INTO workspace_secrets (user_id, name, destination, sealed, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(A, 'API_KEY', 'runtime:env', 'v1.sealed-bytes', now);
  dbHandle
    .prepare(
      "INSERT INTO memories (id, user_id, kind, title, content, content_key, provenance, source, status, enabled, updated_at, created_at) VALUES ('mem-a1', 'user-a', 'preference', 'Tea', 'A likes tea', 'a likes tea', 'quote', 'You', 'saved', 1, ?, ?)",
    )
    .run(now, now);
  // B's own run: proves the suite seeds two distinct owners, and that B's
  // own access still works after team changes.
  dbHandle
    .prepare(
      "INSERT INTO runs (id, conversation_id, user_id, status, step_count, config, created_at) VALUES ('run-b1', 'conv-user-b', 'user-b', 'running', 1, '{}', ?)",
    )
    .run(now);
  return createTeamStore(dbHandle);
}

function teamWithMember(dbHandle, role = 'member') {
  const team = seed(dbHandle);
  const ws = team.createWorkspace('Pairing', A);
  team.inviteMember(ws.id, B, role, A);
  team.activateMember(ws.id, B);
  return { team, ws };
}

function assert404(fn, message) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof Error, 'denials are Errors');
      assert.equal(error.status, 404, 'denials are 404, never 403');
      return true;
    },
    message,
  );
}

// ---------------------------------------------------------------------------
// 1. The team role matrix: separate from deployment staff roles, fail-closed.
// ---------------------------------------------------------------------------

test('member reads and writes; viewer reads only', () => {
  assert.equal(hasTeamPermission('member', 'resources:read'), true);
  assert.equal(hasTeamPermission('member', 'resources:write'), true);
  assert.equal(hasTeamPermission('viewer', 'resources:read'), true);
  assert.equal(hasTeamPermission('viewer', 'resources:write'), false);
});

test('unknown team roles carry nothing: fail closed', () => {
  assert.equal(hasTeamPermission('admin', 'resources:read'), false);
  assert.equal(hasTeamPermission('owner', 'resources:write'), false);
  assert.equal(hasTeamPermission(null, 'resources:read'), false);
  assert.equal(hasTeamPermission(undefined, 'resources:write'), false);
  assert.equal(hasTeamPermission(42, 'resources:read'), false);
});

test('isTeamRole only admits the two team roles', () => {
  assert.equal(isTeamRole('member'), true);
  assert.equal(isTeamRole('viewer'), true);
  assert.equal(isTeamRole('support'), false, 'staff roles are not team roles');
  assert.equal(isTeamRole('owner'), false, 'staff roles are not team roles');
  assert.equal(isTeamRole(''), false);
});

test('teamPermissionsFor returns a fresh array each call', () => {
  const first = teamPermissionsFor('member');
  first.push('resources:read');
  assert.deepEqual(teamPermissionsFor('member'), ['resources:read', 'resources:write']);
});

// ---------------------------------------------------------------------------
// 2. canAccess: the ownership question in one pure place.
// ---------------------------------------------------------------------------

test('the owner always may, read and write', () => {
  assert.equal(canAccess(A, A, null, 'resources:read').allowed, true);
  assert.equal(canAccess(A, A, 'viewer', 'resources:write').allowed, true);
  assert.equal(canAccess(A, A, null, 'resources:read').reason, 'owner');
});

test('a team member may read and write the owner\u2019s resources', () => {
  assert.equal(canRead(B, A, 'member'), true);
  assert.equal(canWrite(B, A, 'member'), true);
  assert.equal(canAccess(B, A, 'member', 'resources:write').reason, 'team-member');
});

test('a viewer may read but never write', () => {
  assert.equal(canRead(C, A, 'viewer'), true);
  assert.equal(canWrite(C, A, 'viewer'), false);
  assert.equal(canAccess(C, A, 'viewer', 'resources:read').reason, 'team-viewer');
});

test('no membership is denied, with the reason named', () => {
  assert.equal(canRead(B, A, null), false);
  assert.equal(canWrite(B, A, null), false);
  assert.equal(canAccess(B, A, null, 'resources:read').reason, 'no-membership');
});

test('an unrecognised role string is denied, not defaulted', () => {
  assert.equal(canRead(B, A, 'admin'), false);
  assert.equal(canAccess(B, A, 'admin', 'resources:read').reason, 'unknown-role');
});

test('missing caller or owner ids are invalid, never allowed', () => {
  assert.equal(canRead(null, A, 'member'), false);
  assert.equal(canRead(B, null, 'member'), false);
  assert.equal(canRead('', A, 'member'), false);
  assert.equal(
    canAccess(B, A, 'member', 'resources:read').allowed,
    true,
    'sanity: valid triple passes',
  );
});

// ---------------------------------------------------------------------------
// 3. Team store: workspaces, invites, deactivation, role resolution.
// ---------------------------------------------------------------------------

test('a workspace round-trips and the owner lists it', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  assert.ok(ws.id);
  assert.equal(ws.ownerUserId, A);
  const listed = team.listWorkspaces(A);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, ws.id);
  assert.equal(team.listWorkspaces(B).length, 0, 'a stranger lists nothing');
});

test('an invite is a pending in-app record, invisible until activated', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  const member = team.inviteMember(ws.id, B, 'member', A);
  assert.equal(member.status, 'pending');
  assert.equal(member.teamRole, 'member');
  assert.equal(member.grantedBy, A);
  assert.equal(team.listWorkspaces(B).length, 0, 'pending invitees see no workspace');
  assert.equal(team.teamRoleOnOwner(A, B), null, 'pending invitees hold no role');
  team.activateMember(ws.id, B);
  assert.equal(team.getMember(ws.id, B)?.status, 'active');
  assert.equal(team.listWorkspaces(B).length, 1, 'activated members see it');
  assert.equal(team.teamRoleOnOwner(A, B), 'member');
});

test('re-inviting upserts rather than duplicating', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  team.inviteMember(ws.id, B, 'viewer', A);
  team.inviteMember(ws.id, B, 'member', A);
  const members = team.listMembers(ws.id);
  assert.equal(members.filter((m) => m.userId === B).length, 1);
  assert.equal(team.getMember(ws.id, B)?.teamRole, 'member', 'latest invite wins');
});

test('removal deactivates the row; it never deletes it', () => {
  const handle = db();
  const { team, ws } = teamWithMember(handle);
  assert.equal(team.removeMember(ws.id, B), true);
  const member = team.getMember(ws.id, B);
  assert.ok(member, 'the row survives removal');
  assert.equal(member.status, 'removed');
  assert.equal(team.teamRoleOnOwner(A, B), null, 'removed members hold no role');
  assert.equal(team.listWorkspaces(B).length, 0);
  assert.equal(team.removeMember(ws.id, B), false, 'removing twice is a no-op');
});

test('the strongest role wins across several of the owner\u2019s workspaces', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws1 = team.createWorkspace('One', A);
  const ws2 = team.createWorkspace('Two', A);
  team.inviteMember(ws1.id, B, 'viewer', A);
  team.activateMember(ws1.id, B);
  team.inviteMember(ws2.id, B, 'member', A);
  team.activateMember(ws2.id, B);
  assert.equal(team.teamRoleOnOwner(A, B), 'member');
});

test('ownerIdsForMember names every workspace owner the caller is teamed with', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const wsA = team.createWorkspace('A ws', A);
  const wsC = team.createWorkspace('C ws', C);
  team.inviteMember(wsA.id, B, 'member', A);
  team.activateMember(wsA.id, B);
  team.inviteMember(wsC.id, B, 'viewer', C);
  team.activateMember(wsC.id, B);
  assert.deepEqual(team.ownerIdsForMember(B).sort(), [A, C]);
  assert.deepEqual(team.ownerIdsForMember(SUPPORT), [], 'support is not a member of anything');
});

// ---------------------------------------------------------------------------
// 4. Consented content access: grants, expiry, revocation, audit.
// ---------------------------------------------------------------------------

test('a consent grant round-trips and counts as active', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  const consent = team.grantContentConsent(ws.id, SUPPORT, A, null);
  assert.ok(consent.id);
  assert.equal(consent.staffUserId, SUPPORT);
  assert.equal(consent.revokedAt, null);
  assert.ok(team.activeConsent(ws.id, SUPPORT), 'unrevoked and unexpired is active');
});

test('an expired grant is not active', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  team.grantContentConsent(ws.id, SUPPORT, A, '2000-01-01T00:00:00.000Z');
  assert.equal(team.activeConsent(ws.id, SUPPORT), null);
});

test('revocation timestamps the row; the row survives', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  team.grantContentConsent(ws.id, SUPPORT, A, null);
  assert.equal(team.revokeContentConsent(ws.id, SUPPORT), true);
  const consent = team.getConsent(ws.id, SUPPORT);
  assert.ok(consent, 'revoked rows are kept');
  assert.ok(consent.revokedAt, 'revocation is a timestamp, not a deletion');
  assert.equal(team.activeConsent(ws.id, SUPPORT), null);
  assert.equal(team.revokeContentConsent(ws.id, SUPPORT), false, 'revoking twice is a no-op');
});

test('re-granting after revocation clears the revocation', () => {
  const handle = db();
  const team = createTeamStore(handle);
  const ws = team.createWorkspace('Pairing', A);
  team.grantContentConsent(ws.id, SUPPORT, A, null);
  team.revokeContentConsent(ws.id, SUPPORT);
  team.grantContentConsent(ws.id, SUPPORT, A, null);
  assert.ok(team.activeConsent(ws.id, SUPPORT), 'a fresh grant reactivates');
});

test('every consented read is audited, newest first, with totals', () => {
  const handle = db();
  const team = createTeamStore(handle);
  team.logContentAccess(SUPPORT, 'file', 'notes/todo.md', A, 'consent-1');
  team.logContentAccess(SUPPORT, 'memory', 'mem-a1', A, 'consent-1');
  const { entries, total } = team.listAccessByOwner(A, 50, 0);
  assert.equal(total, 2);
  assert.equal(entries[0].resourceType, 'memory', 'newest first');
  assert.equal(entries[0].actorId, SUPPORT);
  assert.equal(entries[0].ownerUserId, A);
  assert.equal(entries[0].consentId, 'consent-1');
  assert.ok(entries[0].createdAt);
  const page = team.listAccessByOwner(A, 1, 1);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].resourceType, 'file', 'offset pages');
  assert.equal(page.total, 2, 'total counts all rows, not the page');
  const byActor = team.listAccessByActor(SUPPORT, 50, 0);
  assert.equal(byActor.total, 2);
  assert.equal(team.listAccessByOwner(B, 50, 0).total, 0, 'other owners see nothing');
});

// ---------------------------------------------------------------------------
// 5. Enforcement: the isolation boundaries, positive and negative.
// ---------------------------------------------------------------------------

test('the owner reads every one of their resource kinds', () => {
  const handle = db();
  const team = seed(handle);
  assert.equal(assertCanRead(handle, team, A, 'run', 'run-a1'), A);
  assert.equal(assertCanRead(handle, team, A, 'file', 'notes/todo.md'), A);
  assert.equal(assertCanRead(handle, team, A, 'secret', 'API_KEY'), A);
  assert.equal(assertCanRead(handle, team, A, 'memory', 'mem-a1'), A);
  assert.equal(assertCanWrite(handle, team, A, 'run', 'run-a1'), A);
});

test('a stranger cannot read another user\u2019s run: 404, not 403', () => {
  const handle = db();
  const team = seed(handle);
  assert404(() => assertCanRead(handle, team, B, 'run', 'run-a1'), 'cross-user run read');
  assert404(() => assertCanWrite(handle, team, B, 'run', 'run-a1'), 'cross-user run write');
});

test('a stranger cannot read another user\u2019s file, secret or memory', () => {
  const handle = db();
  const team = seed(handle);
  assert404(() => assertCanRead(handle, team, B, 'file', 'notes/todo.md'), 'cross-user file read');
  assert404(() => assertCanRead(handle, team, B, 'secret', 'API_KEY'), 'cross-user secret read');
  assert404(() => assertCanRead(handle, team, B, 'memory', 'mem-a1'), 'cross-user memory read');
});

test('support staff with no grant cannot read user content', () => {
  const handle = db();
  const team = seed(handle);
  assert404(
    () => assertCanRead(handle, team, SUPPORT, 'file', 'notes/todo.md'),
    'support file read',
  );
  assert404(() => assertCanRead(handle, team, SUPPORT, 'run', 'run-a1'), 'support run read');
});

test('unknown resource ids fail closed with 404', () => {
  const handle = db();
  const team = seed(handle);
  assert404(() => assertCanRead(handle, team, A, 'run', 'run-nope'), 'missing run');
  assert404(() => assertCanRead(handle, team, A, 'file', 'nope.md'), 'missing file');
  assert404(() => assertCanRead(handle, team, B, 'run', 'run-a1'), 'stranger on missing stays 404');
  assert.equal(ownerOf(handle, team, 'run', A, 'run-nope'), null, 'ownerOf resolves null');
});

test('a team member reads AND writes the owner\u2019s resources', () => {
  const handle = db();
  const { team } = teamWithMember(handle, 'member');
  assert.equal(assertCanRead(handle, team, B, 'run', 'run-a1'), A);
  assert.equal(assertCanWrite(handle, team, B, 'run', 'run-a1'), A, 'member may stop the run');
  assert.equal(assertCanRead(handle, team, B, 'file', 'notes/todo.md'), A);
  assert.equal(
    assertCanWrite(handle, team, B, 'file', 'notes/todo.md'),
    A,
    'member may write the file',
  );
  assert.equal(assertCanRead(handle, team, B, 'secret', 'API_KEY'), A);
  assert.equal(assertCanRead(handle, team, B, 'memory', 'mem-a1'), A);
});

test('a viewer reads but never writes', () => {
  const handle = db();
  const { team } = teamWithMember(handle, 'viewer');
  assert.equal(assertCanRead(handle, team, B, 'run', 'run-a1'), A, 'viewer reads the run');
  assert404(() => assertCanWrite(handle, team, B, 'run', 'run-a1'), 'viewer cannot stop a run');
  assert404(
    () => assertCanWrite(handle, team, B, 'file', 'notes/todo.md'),
    'viewer cannot write a file',
  );
});

test('a removed member loses access immediately', () => {
  const handle = db();
  const { team, ws } = teamWithMember(handle, 'member');
  assert.equal(assertCanRead(handle, team, B, 'run', 'run-a1'), A, 'member reads before removal');
  team.removeMember(ws.id, B);
  assert404(() => assertCanRead(handle, team, B, 'run', 'run-a1'), 'removed member read');
  assert404(() => assertCanWrite(handle, team, B, 'file', 'notes/todo.md'), 'removed member write');
});

test('a pending invitee has no access until activated', () => {
  const handle = db();
  const team = seed(handle);
  const ws = team.createWorkspace('Pairing', A);
  team.inviteMember(ws.id, B, 'member', A);
  assert404(() => assertCanRead(handle, team, B, 'run', 'run-a1'), 'pending invitee read');
  team.activateMember(ws.id, B);
  assert.equal(assertCanRead(handle, team, B, 'run', 'run-a1'), A, 'activated invitee reads');
});

test('team access never leaks across owners', () => {
  const handle = db();
  const { team } = teamWithMember(handle, 'member');
  // B is teamed with A only: C's resources stay closed, and B's own still open.
  assert404(
    () => assertCanRead(handle, team, B, 'run', 'run-a1'.replace('a1', 'c1')),
    'no such run is 404',
  );
  assert.equal(assertCanRead(handle, team, B, 'run', 'run-b1'), B, "B's own run stays readable");
  assert404(() => assertCanRead(handle, team, C, 'run', 'run-a1'), 'C is not teamed with A');
});

test('file owner resolution prefers the caller\u2019s own row', () => {
  const handle = db();
  const { team } = teamWithMember(handle, 'member');
  const now = new Date().toISOString();
  handle
    .prepare(
      'INSERT INTO workspace_files (user_id, path, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(B, 'notes/todo.md', 'B private todo', now, now);
  // Same path exists for both: B reads their own, and A's row is untouched.
  assert.equal(ownerOf(handle, team, 'file', B, 'notes/todo.md'), B);
  assert.equal(assertCanRead(handle, team, B, 'file', 'notes/todo.md'), B);
  assert.equal(ownerOf(handle, team, 'file', A, 'notes/todo.md'), A);
});

// ---------------------------------------------------------------------------
// 6. Support metadata view: metadata by default, content never.
// ---------------------------------------------------------------------------

test('run metadata carries status and counts, never config or error', () => {
  const projected = projectMetadata('run', {
    id: 'run-a1',
    status: 'done',
    step_count: 3,
    config: '{"model":"test-fixture-not-a-real-key"}',
    error: 'boom',
    created_at: '2026-09-30T00:00:00.000Z',
    ended_at: null,
  });
  assert.deepEqual(projected, {
    resource: 'run',
    id: 'run-a1',
    status: 'done',
    stepCount: 3,
    createdAt: '2026-09-30T00:00:00.000Z',
    endedAt: null,
  });
  assert.ok(!('config' in projected) && !('error' in projected));
});

test('file metadata carries the size, never the body', () => {
  const projected = projectMetadata('file', {
    path: 'notes/todo.md',
    body: 'A private todo list',
    updated_at: '2026-09-30T00:00:00.000Z',
  });
  assert.deepEqual(projected, {
    resource: 'file',
    path: 'notes/todo.md',
    sizeChars: 19,
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  assert.ok(!('body' in projected));
});

test('file metadata accepts a precomputed size so content is never loaded', () => {
  const projected = projectMetadata('file', {
    path: 'notes/todo.md',
    size_chars: 19,
    updated_at: '2026-09-30T00:00:00.000Z',
  });
  assert.equal(projected?.sizeChars, 19);
  assert.ok(projected && !('body' in projected));
});

test('secret metadata names the secret, never the sealed value', () => {
  const projected = projectMetadata('secret', {
    name: 'API_KEY',
    destination: 'runtime:env',
    sealed: 'v1.ciphertext',
    updated_at: '2026-09-30T00:00:00.000Z',
  });
  assert.deepEqual(projected, {
    resource: 'secret',
    name: 'API_KEY',
    destination: 'runtime:env',
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  assert.ok(!('sealed' in projected));
});

test('memory metadata carries kind and title, never content', () => {
  const projected = projectMetadata('memory', {
    id: 'mem-a1',
    kind: 'preference',
    title: 'Tea',
    content: 'A likes tea',
    content_key: 'a likes tea',
    updated_at: '2026-09-30T00:00:00.000Z',
  });
  assert.deepEqual(projected, {
    resource: 'memory',
    id: 'mem-a1',
    kind: 'preference',
    title: 'Tea',
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  assert.ok(!('content' in projected) && !('content_key' in projected));
});

test('unknown resource types project to null: fail closed', () => {
  assert.equal(projectMetadata('runbook', { id: 'x' }), null);
  assert.deepEqual(
    projectMetadataList('run', [{ id: 'r1', status: 'done', step_count: 1, created_at: 't' }])
      .length,
    1,
  );
});

test('CONTENT_COLUMNS names every column the projectors must not touch', () => {
  assert.deepEqual(CONTENT_COLUMNS.file, ['body']);
  assert.deepEqual(CONTENT_COLUMNS.secret, ['sealed']);
  assert.ok(CONTENT_COLUMNS.run.includes('config'));
  assert.ok(CONTENT_COLUMNS.memory.includes('content'));
});

// ---------------------------------------------------------------------------
// 7. Cache isolation: entries are namespaced per user, structurally.
// ---------------------------------------------------------------------------

test('one user\u2019s cache entries are invisible to another', () => {
  const cache = createTeamCache();
  cache.scope(A).set('metadata:run', [{ id: 'run-a1' }]);
  assert.deepEqual(
    cache.scope(A).get('metadata:run'),
    [{ id: 'run-a1' }],
    'owner reads their entry',
  );
  assert.equal(
    cache.scope(B).get('metadata:run'),
    undefined,
    'another user misses on the same key',
  );
  assert.equal(cache.scope(SUPPORT).get('metadata:run'), undefined, 'support misses too');
});

test('writes in one scope never overwrite another\u2019s', () => {
  const cache = createTeamCache();
  cache.scope(A).set('k', 'a-value');
  cache.scope(B).set('k', 'b-value');
  assert.equal(cache.scope(A).get('k'), 'a-value');
  assert.equal(cache.scope(B).get('k'), 'b-value');
});

test('clear() only clears the caller\u2019s own entries', () => {
  const cache = createTeamCache();
  cache.scope(A).set('k', 'a-value');
  cache.scope(B).set('k', 'b-value');
  cache.scope(B).clear();
  assert.equal(cache.scope(B).get('k'), undefined);
  assert.equal(cache.scope(A).get('k'), 'a-value', "A's entries survive B's clear");
});

test('deleting another user\u2019s key is not expressible', () => {
  const cache = createTeamCache();
  cache.scope(A).set('k', 'a-value');
  cache.scope(B).del('k');
  assert.equal(cache.scope(A).get('k'), 'a-value', "B's del touches only B's namespace");
});

test('expired entries read as misses', () => {
  let now = 1_000;
  const cache = createTeamCache(() => now);
  cache.scope(A).set('k', 'v', 100);
  now += 101;
  assert.equal(cache.scope(A).get('k'), undefined);
});

test('empty user ids and keys throw rather than mixing namespaces', () => {
  const cache = createTeamCache();
  assert.throws(() => cache.scope(''), /user id/);
  assert.throws(() => cache.scope(A).set('', 'v'), /key/);
  assert.throws(() => cache.scope(A).get(''), /key/);
});

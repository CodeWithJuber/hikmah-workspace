// The app signs tickets and the workbench verifies them, in two packages that
// cannot import each other. These tests cross the boundary on purpose: they
// issue with the app's code and verify with the workbench's, so a change to
// either side's format fails here instead of in production.
// Run: node --test tests/workbench-ticket.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKET_TTL_MS,
  WorkbenchError,
  issueTicket,
  terminalUrl,
  workbenchToken,
} from '../lib/workbench/ticket.ts';
import { verifyTicket } from '../workbench/src/ticket.ts';
import { isUserKey } from '../workbench/src/slots.ts';
import { workbenchUserKey } from '../lib/workbench/user-key.ts';

const SECRET = 's'.repeat(48);

test('a ticket the app issues is one the workbench accepts', () => {
  const payload = verifyTicket(issueTicket({ scope: 'terminal' }, SECRET), SECRET);
  assert.equal(payload.scope, 'terminal');
});

test('an ssh ticket carries the host across the boundary', () => {
  const payload = verifyTicket(issueTicket({ scope: 'ssh', hostId: 'h1' }, SECRET), SECRET);
  assert.equal(payload.scope, 'ssh');
  assert.equal(payload.hostId, 'h1');
});

test('the two sides agree on when a ticket dies', () => {
  const now = Date.now();
  const ticket = issueTicket({ scope: 'terminal' }, SECRET, now);
  assert.doesNotThrow(() => verifyTicket(ticket, SECRET, { now: now + TICKET_TTL_MS - 1 }));
  assert.throws(() => verifyTicket(ticket, SECRET, { now: now + TICKET_TTL_MS + 1 }));
});

test('the workbench refuses a ticket signed with a different secret', () => {
  assert.throws(() => verifyTicket(issueTicket({ scope: 'terminal' }, 'other'), SECRET));
});

test('two tickets issued in the same millisecond differ', () => {
  const now = Date.now();
  assert.notEqual(
    issueTicket({ scope: 'terminal' }, SECRET, now),
    issueTicket({ scope: 'terminal' }, SECRET, now),
    'identical tickets would make the replay check useless',
  );
});

test('a deployment without a workbench says so instead of failing obscurely', () => {
  // Without this the owner sees an unexplained 401 from a service they did not
  // know they were missing.
  assert.throws(
    () => workbenchToken({}),
    (error) => error instanceof WorkbenchError && error.status === 503,
  );
  assert.throws(() => workbenchToken({ HIKMAH_WORKBENCH_TOKEN: 'short' }), WorkbenchError);
  assert.equal(workbenchToken({ HIKMAH_WORKBENCH_TOKEN: SECRET }), SECRET);
});

test('the socket URL keeps the app origin so the workbench can check it', () => {
  const url = new URL(terminalUrl('https://hikmah.example', 'tkt'));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.host, 'hikmah.example');
  assert.equal(url.pathname, '/ws/terminal');
  assert.equal(url.searchParams.get('ticket'), 'tkt');
});

test('a local http deployment gets ws, not wss', () => {
  assert.match(terminalUrl('http://localhost:3000', 't'), /^ws:\/\/localhost:3000\/ws\/terminal/);
});

test('the account crosses the boundary, in the shape the slot pool accepts', () => {
  // The terminal's half of per-user isolation. A ticket used to name only a
  // scope, so every terminal opened a pty in the one shared /workspace — the
  // inverse of the defect on the assistant's path, where every command ran as
  // one uid. The workbench resolves this value to a Unix user and a directory,
  // so the two sides have to agree on it exactly.
  const userKey = workbenchUserKey('user_abc', SECRET);
  const payload = verifyTicket(issueTicket({ scope: 'terminal', userKey }, SECRET), SECRET);
  assert.equal(payload.userKey, userKey, 'it arrives unchanged');
  assert.equal(isUserKey(payload.userKey), true, 'and the slot pool will accept it');
});

test('the workbench is told which account, never which user', () => {
  // It holds no sessions and does nothing with identity; it is also the one
  // container that hands out shells. A keyed hash gives it what it needs to
  // keep directories apart and nothing else.
  const key = workbenchUserKey('user_abc', SECRET);
  assert.equal(key.includes('user_abc'), false, 'the id is not recoverable by reading it');
  assert.equal(workbenchUserKey('user_abc', SECRET), key, 'stable, so files are kept');
  assert.notEqual(workbenchUserKey('user_abd', SECRET), key, 'and different per account');
  // Keyed by the shared token: knowing someone's account id is not enough to
  // forge a request that lands in their directory.
  assert.notEqual(workbenchUserKey('user_abc', 'another-secret'), key);
});

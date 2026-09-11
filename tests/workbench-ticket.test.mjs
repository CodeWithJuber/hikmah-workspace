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

// Tickets are the only thing standing between a browser and a shell, so these
// cover forgery, replay and expiry rather than the happy path alone.
// Run: node --test test/ticket.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { TICKET_TTL_MS, TicketError, issueTicket, pruneSeen, verifyTicket } from '../src/ticket.ts';

const SECRET = 'a'.repeat(48);

test('a freshly issued ticket verifies', () => {
  const payload = verifyTicket(issueTicket({ scope: 'terminal' }, SECRET), SECRET);
  assert.equal(payload.scope, 'terminal');
});

test('a ticket signed with another secret is refused', () => {
  // This is the whole point: the workbench trusts nothing it did not sign.
  const forged = issueTicket({ scope: 'terminal' }, 'b'.repeat(48));
  assert.throws(() => verifyTicket(forged, SECRET), TicketError);
});

test('tampering with the payload invalidates the signature', () => {
  const ticket = issueTicket({ scope: 'ssh', hostId: 'safe-host' }, SECRET);
  const [body, signature] = ticket.split('.');
  const swapped = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), hostId: 'attacker-host' }),
  ).toString('base64url');
  assert.throws(() => verifyTicket(`${swapped}.${signature}`, SECRET), TicketError);
});

test('an expired ticket is refused', () => {
  const now = Date.now();
  const ticket = issueTicket({ scope: 'terminal' }, SECRET, now);
  assert.doesNotThrow(() => verifyTicket(ticket, SECRET, { now: now + TICKET_TTL_MS - 1 }));
  assert.throws(() => verifyTicket(ticket, SECRET, { now: now + TICKET_TTL_MS + 1 }), TicketError);
});

test('a ticket cannot be used twice', () => {
  // A ticket travels in a URL, so it lands in history and proxy logs. Replay has
  // to fail even while the ticket is still inside its lifetime.
  const seen = new Set();
  const ticket = issueTicket({ scope: 'terminal' }, SECRET);
  assert.doesNotThrow(() => verifyTicket(ticket, SECRET, { seen }));
  assert.throws(() => verifyTicket(ticket, SECRET, { seen }), /already used/);
});

test('two tickets issued together are distinct', () => {
  const now = Date.now();
  const a = issueTicket({ scope: 'terminal' }, SECRET, now);
  const b = issueTicket({ scope: 'terminal' }, SECRET, now);
  assert.notEqual(a, b, 'identical tickets would make replay undetectable');
});

test('malformed input is rejected rather than throwing something unhelpful', () => {
  for (const bad of ['', 'nodot', '.', 'a.b', Buffer.from('{}').toString('base64url') + '.x']) {
    assert.throws(() => verifyTicket(bad, SECRET), TicketError, JSON.stringify(bad));
  }
});

test('an ssh ticket carries the host the app authorised', () => {
  const payload = verifyTicket(issueTicket({ scope: 'ssh', hostId: 'h1' }, SECRET), SECRET);
  assert.equal(payload.scope, 'ssh');
  assert.equal(payload.hostId, 'h1');
});

test('spent nonces are pruned once they can no longer be replayed', () => {
  const now = Date.now();
  const seen = new Map([
    ['old', now - 1],
    ['live', now + 60_000],
  ]);
  pruneSeen(seen, now);
  assert.deepEqual([...seen.keys()], ['live']);
});

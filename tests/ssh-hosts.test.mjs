// Saved SSH hosts are what stop the model choosing where a connection goes, and
// the auto-approve list is what decides which commands skip the prompt. Both are
// security boundaries, so these lean on what must be rejected.
// Run: node --test tests/ssh-hosts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  SshHostError,
  createHostStore,
  credentialDestination,
  isAutoApproved,
  parseAutoApprove,
  parseHostInput,
} from '../lib/ssh/hosts.ts';

/** A database with only the migration under test applied. */
function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0006_ssh.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return db;
}

const input = (overrides = {}) => ({
  name: 'prod',
  host: 'server.example.com',
  username: 'deploy',
  authKind: 'key',
  ...overrides,
});

test('a well-formed host is accepted with port 22 by default', () => {
  const parsed = parseHostInput(input());
  assert.equal(parsed.port, 22);
  assert.equal(parsed.host, 'server.example.com');
  assert.deepEqual(parsed.autoApprove, []);
});

test('an address is a bare host, never a URL or a host:port', () => {
  // Accepting either would mean the port the owner sees is not the port used.
  for (const host of [
    'ssh://server.example.com',
    'server.example.com:22',
    'server.example.com/path',
    'user@server.example.com',
    'server example.com',
    '256.1.1.1',
    '-leading-dash.com',
    '',
  ]) {
    assert.throws(() => parseHostInput(input({ host })), SshHostError, host);
  }
});

test('plain hosts and IP addresses are accepted', () => {
  for (const host of ['example.com', 'a.b.c.example.com', '10.0.0.1', '[2001:db8::1]', 'localhost'])
    assert.equal(parseHostInput(input({ host })).host, host, host);
});

test('a username cannot smuggle in an ssh option or a shell command', () => {
  for (const username of ['-oProxyCommand=x', 'root; rm -rf /', 'a b', '$(whoami)', ''])
    assert.throws(() => parseHostInput(input({ username })), SshHostError, username);
  assert.equal(
    parseHostInput(input({ username: 'deploy.user-1@corp' })).username,
    'deploy.user-1@corp',
  );
});

test('a port outside the valid range is refused', () => {
  for (const port of [0, -1, 65536, 1.5, 'twenty']) {
    assert.throws(() => parseHostInput(input({ port })), SshHostError, String(port));
  }
  assert.equal(parseHostInput(input({ port: 2222 })).port, 2222);
  assert.equal(parseHostInput(input({ port: '' })).port, 22, 'an empty port means the default');
});

test('the credential kind must be one the connector understands', () => {
  assert.throws(() => parseHostInput(input({ authKind: 'agent' })), SshHostError);
  assert.equal(parseHostInput(input({ authKind: 'password' })).authKind, 'password');
});

test('a credential is bound to one host id', () => {
  // Reusing a destination across hosts would let a key be pointed at another
  // machine by editing the host row afterwards.
  assert.equal(credentialDestination('h1'), 'ssh:h1');
  assert.notEqual(credentialDestination('h1'), credentialDestination('h2'));
});

test('hosts are stored, listed per user and fetched by id', (t) => {
  const store = createHostStore(database(t));
  const created = store.create('h1', 'user-1', parseHostInput(input()));
  assert.equal(created.name, 'prod');
  assert.equal(created.fingerprint, null, 'nothing is pinned until the first connection');
  assert.equal(store.list('user-1').length, 1);
  assert.equal(store.list('user-2').length, 0, "another user cannot see someone else's hosts");
  assert.equal(store.get('h1', 'user-2'), undefined);
});

test('two hosts cannot share a name, but two users can', (t) => {
  const store = createHostStore(database(t));
  store.create('h1', 'user-1', parseHostInput(input()));
  assert.throws(() => store.create('h2', 'user-1', parseHostInput(input())), SshHostError);
  assert.doesNotThrow(() => store.create('h3', 'user-2', parseHostInput(input())));
});

test('a fingerprint is pinned once and never silently replaced', (t) => {
  // Overwriting would turn the pin into a suggestion, which is exactly the
  // failure it exists to prevent.
  const store = createHostStore(database(t));
  store.create('h1', 'user-1', parseHostInput(input()));
  assert.equal(store.pinFingerprint('h1', 'user-1', 'a'.repeat(64)), true);
  assert.equal(store.pinFingerprint('h1', 'user-1', 'b'.repeat(64)), false);
  assert.equal(store.get('h1', 'user-1').fingerprint, 'a'.repeat(64));
});

test('a host cannot be pinned by someone who does not own it', (t) => {
  const store = createHostStore(database(t));
  store.create('h1', 'user-1', parseHostInput(input()));
  assert.equal(store.pinFingerprint('h1', 'user-2', 'c'.repeat(64)), false);
  assert.equal(store.get('h1', 'user-1').fingerprint, null);
});

test('removing a host is scoped to its owner', (t) => {
  const store = createHostStore(database(t));
  store.create('h1', 'user-1', parseHostInput(input()));
  store.remove('h1', 'user-2');
  assert.ok(store.get('h1', 'user-1'), 'another user must not be able to delete this');
  store.remove('h1', 'user-1');
  assert.equal(store.get('h1', 'user-1'), undefined);
});

test('nothing is auto-approved by default', () => {
  assert.equal(isAutoApproved('uptime', []), false);
  assert.equal(isAutoApproved('uptime', null), false);
});

test('an exact pattern matches only that command', () => {
  assert.equal(isAutoApproved('uptime', ['uptime']), true);
  assert.equal(isAutoApproved('uptime -p', ['uptime']), false);
  assert.equal(isAutoApproved('reboot', ['uptime']), false);
});

test('a pattern never approves a command chained onto it', () => {
  // This is the whole reason matching is anchored: a prefix rule would let each
  // of these through on a pattern of 'df' or 'systemctl status *'.
  for (const command of [
    'df; rm -rf /',
    'df && reboot',
    'df | tee /etc/passwd',
    'df > /etc/hosts',
    'df `reboot`',
    'df $(reboot)',
    'systemctl status nginx; shutdown now',
  ]) {
    assert.equal(isAutoApproved(command, ['df', 'systemctl status *']), false, command);
  }
});

test('a wildcard covers an argument but not a second command', () => {
  assert.equal(isAutoApproved('systemctl status nginx', ['systemctl status *']), true);
  assert.equal(isAutoApproved('tail -n 100 /var/log/syslog', ['tail -n * /var/log/*']), true);
  assert.equal(isAutoApproved('systemctl restart nginx', ['systemctl status *']), false);
});

test('pattern text is matched literally, not as a regular expression', () => {
  // Without escaping, a dot in a pattern would match any character, so
  // 'cat /etc/os-release' would approve 'cat /etcXos-release' too.
  assert.equal(isAutoApproved('cat /etc/os-release', ['cat /etc/os-release']), true);
  assert.equal(isAutoApproved('cat /etcXos-release', ['cat /etc/os-release']), false);
  assert.equal(isAutoApproved('uptimeX', ['uptime.']), false);
});

test('an empty or whitespace command is never approved', () => {
  for (const command of ['', '   ', '\n']) assert.equal(isAutoApproved(command, ['*']), false);
});

test('a stored auto-approve list survives the round trip, and bad JSON is empty', () => {
  assert.deepEqual(parseAutoApprove(JSON.stringify(['uptime', 'df'])), ['uptime', 'df']);
  assert.deepEqual(parseAutoApprove(null), []);
  assert.deepEqual(parseAutoApprove('not json'), []);
  assert.deepEqual(parseAutoApprove(JSON.stringify([1, 'df'])), ['df']);
});

test('an auto-approve list round-trips through the database', (t) => {
  const store = createHostStore(database(t));
  const row = store.create(
    'h1',
    'user-1',
    parseHostInput(input({ autoApprove: ['uptime', 'systemctl status *'] })),
  );
  assert.deepEqual(parseAutoApprove(row.auto_approve), ['uptime', 'systemctl status *']);
});

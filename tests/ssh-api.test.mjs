// Adding a host is where a host key gets trusted for good, so these tests are
// mostly about the three-step flow refusing to take shortcuts.
// Run: node --test tests/ssh-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hostsRequest } from '../lib/ssh/api.ts';

const ORIGIN = 'https://hikmah.test';

function setup(t, { probe = { fingerprint: 'a'.repeat(64) }, saveFails = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../drizzle/0006_ssh.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());

  const credentials = new Map();
  let counter = 0;
  const probes = [];
  const context = {
    db,
    userId: 'user-1',
    newId: () => `host${++counter}`,
    saveCredential: async (hostId, value) => {
      if (saveFails) throw new Error('Workspace encryption is unavailable.');
      credentials.set(hostId, value);
    },
    removeCredential: async (hostId) => void credentials.delete(hostId),
    probeHost: async (host) => {
      probes.push(host.id);
      return typeof probe === 'function' ? probe(probes.length) : probe;
    },
  };
  return { context, credentials, probes };
}

const post = (body) =>
  new Request(`${ORIGIN}/api/ssh-hosts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
const get = () => new Request(`${ORIGIN}/api/ssh-hosts`);
const del = (id) =>
  new Request(`${ORIGIN}/api/ssh-hosts?id=${id}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN },
  });

const valid = {
  name: 'prod',
  host: 'server.example.com',
  username: 'deploy',
  authKind: 'key',
  credential: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n',
};

test('signing out leaves the hosts unreachable', async (t) => {
  const { context } = setup(t);
  const response = await hostsRequest(get(), { ...context, userId: undefined });
  assert.equal(response.status, 401);
});

test('a host is saved with its credential and returned without it', async (t) => {
  const { context, credentials } = setup(t);
  const response = await hostsRequest(post(valid), context);
  assert.equal(response.status, 201);
  const { host } = await response.json();
  assert.equal(host.name, 'prod');
  assert.equal(host.fingerprint, null, 'nothing is trusted until the owner confirms it');
  assert.equal(JSON.stringify(host).includes('BEGIN OPENSSH'), false, 'no credential in the reply');
  assert.equal(credentials.get('host1'), valid.credential);
});

test('a multi-line private key survives being saved', async (t) => {
  // PEM keys are multi-line by nature; rejecting line breaks would make key
  // authentication impossible while looking like a validation bug.
  const { context, credentials } = setup(t);
  await hostsRequest(post(valid), context);
  assert.match(credentials.get('host1'), /\n/);
});

test('a host with no credential is not saved at all', async (t) => {
  const { context } = setup(t);
  const response = await hostsRequest(post({ ...valid, credential: '' }), context);
  assert.equal(response.status, 400);
  assert.equal((await hostsRequest(get(), context).then((r) => r.json())).hosts.length, 0);
});

test('a host whose credential could not be sealed is rolled back', async (t) => {
  // Otherwise it would sit in the list looking usable and fail on every command.
  const { context } = setup(t, { saveFails: true });
  const response = await hostsRequest(post(valid), context);
  assert.equal(response.ok, false);
  const { hosts } = await hostsRequest(get(), context).then((r) => r.json());
  assert.deepEqual(hosts, []);
});

test('an invalid host is rejected with the reason', async (t) => {
  const { context } = setup(t);
  const response = await hostsRequest(post({ ...valid, host: 'ssh://server' }), context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /hostname or IP/);
});

test('probing reports the key that answered, and pins nothing', async (t) => {
  const { context } = setup(t);
  await hostsRequest(post(valid), context);
  const response = await hostsRequest(post({ id: 'host1', action: 'probe' }), context);
  const body = await response.json();
  assert.equal(body.fingerprint, 'a'.repeat(64));
  assert.equal(body.pinned, false);
  const { hosts } = await hostsRequest(get(), context).then((r) => r.json());
  assert.equal(hosts[0].fingerprint, null, 'seeing a key is not the same as trusting it');
});

test('confirming the fingerprint the owner was shown pins it', async (t) => {
  const { context } = setup(t);
  await hostsRequest(post(valid), context);
  await hostsRequest(post({ id: 'host1', action: 'probe' }), context);
  const response = await hostsRequest(
    post({ id: 'host1', action: 'confirm', fingerprint: 'a'.repeat(64) }),
    context,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).host.fingerprint, 'a'.repeat(64));
});

test('confirming a fingerprint the host is not presenting pins nothing', async (t) => {
  // A stale form, or a forged one, must not be able to pin an attacker's key.
  const { context } = setup(t);
  await hostsRequest(post(valid), context);
  const response = await hostsRequest(
    post({ id: 'host1', action: 'confirm', fingerprint: 'b'.repeat(64) }),
    context,
  );
  assert.equal(response.status, 409);
  const { hosts } = await hostsRequest(get(), context).then((r) => r.json());
  assert.equal(hosts[0].fingerprint, null);
});

test('a key that changes between being shown and confirmed is refused', async (t) => {
  const { context } = setup(t, {
    probe: (attempt) => ({ fingerprint: attempt === 1 ? 'a'.repeat(64) : 'c'.repeat(64) }),
  });
  await hostsRequest(post(valid), context);
  const shown = await hostsRequest(post({ id: 'host1', action: 'probe' }), context).then((r) =>
    r.json(),
  );
  const response = await hostsRequest(
    post({ id: 'host1', action: 'confirm', fingerprint: shown.fingerprint }),
    context,
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /changed between/);
});

test('an already-pinned host cannot be re-pinned through the API', async (t) => {
  const { context } = setup(t);
  await hostsRequest(post(valid), context);
  await hostsRequest(
    post({ id: 'host1', action: 'confirm', fingerprint: 'a'.repeat(64) }),
    context,
  );
  const again = await hostsRequest(
    post({ id: 'host1', action: 'confirm', fingerprint: 'd'.repeat(64) }),
    context,
  );
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /Remove it and add it again/);
});

test('a host that cannot be reached says so rather than pinning nothing quietly', async (t) => {
  const { context } = setup(t, { probe: { error: 'Connection refused.' } });
  await hostsRequest(post(valid), context);
  const response = await hostsRequest(post({ id: 'host1', action: 'probe' }), context);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /refused/);
});

test('one user cannot probe, confirm or delete another user’s host', async (t) => {
  const { context, probes } = setup(t);
  await hostsRequest(post(valid), context);
  const other = { ...context, userId: 'user-2' };
  for (const request of [
    post({ id: 'host1', action: 'probe' }),
    post({ id: 'host1', action: 'confirm', fingerprint: 'a'.repeat(64) }),
    del('host1'),
  ]) {
    assert.equal((await hostsRequest(request, other)).status, 404);
  }
  assert.deepEqual(probes, [], 'nothing should have connected on their behalf');
  const { hosts } = await hostsRequest(get(), context).then((r) => r.json());
  assert.equal(hosts.length, 1);
});

test('deleting a host takes its credential with it', async (t) => {
  // A credential outliving its host is a decryptable key with nothing pointing
  // at it and no way to remove it from the interface.
  const { context, credentials } = setup(t);
  await hostsRequest(post(valid), context);
  const response = await hostsRequest(del('host1'), context);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).hosts, []);
  assert.equal(credentials.has('host1'), false);
});

test('an unsupported method is refused rather than falling through', async (t) => {
  const { context } = setup(t);
  const request = new Request(`${ORIGIN}/api/ssh-hosts`, {
    method: 'PUT',
    headers: { origin: ORIGIN },
  });
  assert.equal((await hostsRequest(request, context)).status, 405);
});

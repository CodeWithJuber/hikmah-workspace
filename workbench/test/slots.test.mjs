// One Unix user per account.
//
// The workbench had one uid and one /workspace for everybody. These are the
// properties that make a slot a boundary rather than a convention: the same
// account gets the same directory across a restart, two accounts never share
// one, the directory is created at 0700 owned by its own uid, and a request
// that does not say which account it is for is refused rather than defaulted
// to a shared slot — because there is no shared slot to fall back to.
//
// The filesystem calls are injected: CI does not run as root, and chown would
// fail for reasons that have nothing to do with what is being tested. The
// kernel-level half of this (that slot A really cannot read slot B) is asserted
// in the container, by scripts/smoke-workbench.sh.
//
// Run: node --test test/slots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_ID, POOL_SIZE, SlotError, createSlots, isUserKey, slotName } from '../src/slots.ts';

/** An in-memory SlotFs that records what it was asked to do. */
function fakeFs() {
  const files = new Map();
  const dirs = new Map();
  return {
    files,
    dirs,
    fs: {
      mkdir: (path) => dirs.set(path, { ...(dirs.get(path) ?? {}), made: true }),
      chown: (path, uid, gid) => dirs.set(path, { ...(dirs.get(path) ?? {}), uid, gid }),
      chmod: (path, mode) => dirs.set(path, { ...(dirs.get(path) ?? {}), mode }),
      readFile: (path) => files.get(path) ?? null,
      writeFile: (path, body, mode) => files.set(path, body) && files.set(path + ':mode', mode),
    },
  };
}

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

test('two accounts get two uids and two directories', () => {
  const { fs } = fakeFs();
  const slots = createSlots({ workspace: '/workspace', fs });
  const a = slots.for(KEY_A);
  const b = slots.for(KEY_B);

  assert.notEqual(a.uid, b.uid, 'two accounts must not share a uid');
  assert.notEqual(a.home, b.home, 'nor a directory');
  assert.equal(a.uid, FIRST_ID);
  assert.equal(b.uid, FIRST_ID + 1);
  assert.equal(a.name, 'hk01');
  assert.equal(a.home, '/workspace/u/hk01');
  // gid tracks uid: a shared group would make 0750 leak, and someone will
  // eventually write 0750.
  assert.equal(a.gid, a.uid);
});

test('the same account gets the same slot, including across a restart', () => {
  const state = fakeFs();
  const first = createSlots({ workspace: '/workspace', fs: state.fs });
  const before = first.for(KEY_A);
  first.for(KEY_B);

  // A new registry over the same files is what a restart looks like.
  const second = createSlots({ workspace: '/workspace', fs: state.fs });
  assert.deepEqual(second.for(KEY_A), before, 'a restart must not move anyone');
  // And a third account still gets the next free slot, not one already taken.
  const third = second.for('c'.repeat(32));
  assert.equal(third.index, 3);
});

test('the directory is created at 0700, owned by its own uid', () => {
  // This is the boundary. A slot directory that is 0755, or owned by the
  // supervisor, is a shared filesystem with extra steps.
  const state = fakeFs();
  const slots = createSlots({ workspace: '/workspace', fs: state.fs });
  const a = slots.for(KEY_A);
  const made = state.dirs.get(a.home);
  assert.equal(made.made, true);
  assert.equal(made.mode, 0o700);
  assert.equal(made.uid, a.uid);
  assert.equal(made.gid, a.gid);
});

test('the ownership and mode are re-applied every time, not only at creation', () => {
  // A directory restored from a backup, or left by an older release, arrives
  // with the wrong owner. Resolving the slot has to correct it.
  const state = fakeFs();
  const slots = createSlots({ workspace: '/workspace', fs: state.fs });
  const a = slots.for(KEY_A);
  state.dirs.set(a.home, { made: true, uid: 0, gid: 0, mode: 0o755 });
  slots.for(KEY_A);
  const again = state.dirs.get(a.home);
  assert.equal(again.mode, 0o700);
  assert.equal(again.uid, a.uid);
});

test('a request with no account is refused, never given a shared slot', () => {
  // The whole point is that there is no shared slot to fall back to.
  const { fs } = fakeFs();
  const slots = createSlots({ workspace: '/workspace', fs });
  for (const bad of [undefined, null, '', 'short', 'a'.repeat(65), '../etc', 'has space', 42, {}]) {
    assert.throws(
      () => slots.for(bad),
      (error) => error instanceof SlotError && error.status === 400,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('a full pool says so, rather than sharing', () => {
  const { fs } = fakeFs();
  const slots = createSlots({ workspace: '/workspace', size: 2, fs });
  slots.for(KEY_A);
  slots.for(KEY_B);
  assert.throws(
    () => slots.for('c'.repeat(32)),
    (error) => {
      assert.ok(error instanceof SlotError);
      assert.equal(error.status, 503);
      assert.match(error.message, /2 workspaces/, 'the message says what the limit is');
      return true;
    },
  );
});

test('a released slot is reused, and releasing does not touch the directory', () => {
  const state = fakeFs();
  const slots = createSlots({ workspace: '/workspace', size: 2, fs: state.fs });
  const a = slots.for(KEY_A);
  slots.for(KEY_B);
  slots.release(KEY_A);
  assert.equal(slots.assigned, 1);
  // The directory is still there: removing an assignment must not delete files.
  assert.ok(state.dirs.get(a.home));
  const c = slots.for('c'.repeat(32));
  assert.equal(c.index, a.index, 'the freed slot is the next one handed out');
});

test('the assignment file is written 0600', () => {
  // A slot user that could rewrite this could point its own key at someone
  // else's directory.
  const state = fakeFs();
  createSlots({ workspace: '/workspace', fs: state.fs }).for(KEY_A);
  assert.equal(state.files.get('/workspace/.slots.json:mode'), 0o600);
});

test('a corrupt assignment file stops the service rather than resetting it', () => {
  // "Start again with an empty map" would hand the next person to arrive
  // somebody else's directory. Refusing is the safe direction.
  for (const body of [
    '{oh dear',
    '{}',
    '{"slots":[]}',
    '{"slots":{"short":1}}',
    '{"slots":{"' + KEY_A + '":99}}',
  ]) {
    const state = fakeFs();
    state.files.set('/workspace/.slots.json', body);
    const slots = createSlots({ workspace: '/workspace', size: 2, fs: state.fs });
    assert.throws(
      () => slots.for(KEY_A),
      (error) => error instanceof SlotError && error.status === 500,
      `${body} should be fatal`,
    );
  }
});

test('the names and ids line up with what the image creates', () => {
  // The Dockerfile bakes these in; a mismatch here means spawning as a uid that
  // does not exist, which fails at run time rather than at build time.
  assert.equal(slotName(1), 'hk01');
  assert.equal(slotName(32), 'hk32');
  assert.equal(POOL_SIZE, 32);
  assert.equal(FIRST_ID, 3001);
});

test('a user key is opaque and cannot be a path or a flag', () => {
  assert.equal(isUserKey('a'.repeat(32)), true);
  assert.equal(isUserKey('AZaz09_-'.repeat(2) + 'aaaa'), true);
  for (const bad of ['../../etc/passwd', '-rf', 'a/b', 'a b', 'a'.repeat(15), 'a'.repeat(65), ''])
    assert.equal(isUserKey(bad), false, bad);
});

test('a workspace the service cannot write says so, and says what to do', () => {
  // The supervisor holds CHOWN but deliberately not DAC_OVERRIDE, so a volume
  // root owned by anyone else stops it dead. That is the right failure — but
  // the bare EACCES names none of the four things it could have been, and this
  // is exactly what an operator meets after restoring a backup or deploying
  // from before `chown 0:0 workbench-data`. It cost a CI run to find.
  const { fs } = fakeFs();
  const denied = {
    ...fs,
    mkdir: () => {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    },
  };
  const slots = createSlots({ workspace: '/workspace', fs: denied });
  assert.throws(
    () => slots.for(KEY_A),
    (error) => {
      assert.ok(error instanceof SlotError);
      assert.equal(error.status, 500);
      assert.match(error.message, /owned by root/, 'the message names the fix');
      assert.match(error.message, /chown 0:0/, 'and the command that applies it');
      return true;
    },
  );
});

test('a failure that is not a permission problem is not disguised as one', () => {
  // Turning every mkdir error into "chown your volume" would send an operator
  // after the wrong thing when the disk is full.
  const { fs } = fakeFs();
  const full = {
    ...fs,
    mkdir: () => {
      const error = new Error('ENOSPC: no space left on device');
      error.code = 'ENOSPC';
      throw error;
    },
  };
  assert.throws(
    () => createSlots({ workspace: '/workspace', fs: full }).for(KEY_A),
    /ENOSPC/,
    'the original error survives',
  );
});

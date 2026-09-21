import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSettingsSync } from '../lib/client/chat-settings-sync.ts';
import { DEFAULT_CHAT_SETTINGS } from '../lib/chat/settings.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settings = (patch = {}) => ({ ...structuredClone(DEFAULT_CHAT_SETTINGS), ...patch });

test('a burst of settings invalidations coalesces to one read', async () => {
  const read = deferred();
  const published = [];
  let reads = 0;
  const sync = createChatSettingsSync({
    read: async () => {
      reads++;
      return read.promise;
    },
    write: async () => {
      throw Error('unexpected write');
    },
    publish: (value) => published.push(value),
    ready: () => {},
  });
  for (let i = 0; i < 10; i++) sync.refresh();
  await turn();
  assert.equal(reads, 1);
  read.resolve(settings({ contextModel: true }));
  await turn();
  assert.equal(published.length, 1);
  sync.stop();
});

test('a late initial read cannot overwrite a successful settings change', async () => {
  const initial = deferred();
  const published = [];
  let signal;
  const sync = createChatSettingsSync({
    read: async (nextSignal) => {
      signal = nextSignal;
      return initial.promise;
    },
    write: async (patch) => settings(patch),
    publish: (value) => published.push(value),
    ready: () => {},
  });
  sync.refresh();
  await turn();
  await sync.change({ contextModel: false });
  assert.equal(signal.aborted, true);
  initial.resolve(settings({ contextModel: true }));
  await turn();
  assert.deepEqual(
    published.map((value) => value.contextModel),
    [false],
  );
  sync.stop();
});

test('an external learning update supersedes an in-flight settings response and refreshes once', async () => {
  const write = deferred();
  const published = [];
  let reads = 0;
  const sync = createChatSettingsSync({
    read: async () => {
      reads++;
      return settings({ contextModel: true, responseStyle: 'concise' });
    },
    write: async () => write.promise,
    publish: (value) => published.push(value),
    ready: () => {},
  });
  const saving = sync.change({ responseStyle: 'concise' });
  await turn();
  // Automatic learning enabled contextModel after this PUT took its snapshot.
  for (let i = 0; i < 4; i++) sync.refresh();
  await turn();
  assert.equal(reads, 0, 'refresh waits until the outstanding mutation settles');
  write.resolve(settings({ contextModel: false, responseStyle: 'concise' }));
  await saving;
  await turn();
  assert.equal(reads, 1);
  assert.deepEqual(
    published.map((value) => value.contextModel),
    [true],
  );
  assert.equal(published[0].responseStyle, 'concise');
  sync.stop();
});

test('rapid writes run in order and only the latest full snapshot is published', async () => {
  const first = deferred();
  const patches = [];
  const published = [];
  const sync = createChatSettingsSync({
    read: async () => {
      throw Error('unexpected read');
    },
    write: async (patch) => {
      patches.push(patch);
      return patches.length === 1
        ? first.promise
        : settings({ maxSteps: 12, responseStyle: 'concise' });
    },
    publish: (value) => published.push(value),
    ready: () => {},
  });
  const a = sync.change({ maxSteps: 12 });
  const b = sync.change({ responseStyle: 'concise' });
  await turn();
  assert.equal(patches.length, 1, 'the second patch has not raced the first request');
  first.resolve(settings({ maxSteps: 12 }));
  await Promise.all([a, b]);
  assert.deepEqual(patches, [{ maxSteps: 12 }, { responseStyle: 'concise' }]);
  assert.equal(published.length, 1);
  assert.equal(published[0].maxSteps, 12);
  assert.equal(published[0].responseStyle, 'concise');
  sync.stop();
});

test('a failed save rejects, refreshes confirmation, and does not block a retry', async () => {
  const published = [];
  let writes = 0;
  const sync = createChatSettingsSync({
    read: async () => settings({ maxSteps: 8 }),
    write: async (patch) => {
      if (++writes === 1) throw Error('Settings were not saved.');
      return settings(patch);
    },
    publish: (value) => published.push(value),
    ready: () => {},
  });
  await assert.rejects(sync.change({ maxSteps: 12 }), /not saved/);
  await turn();
  assert.equal(published.at(-1).maxSteps, 8);
  await sync.change({ maxSteps: 12 });
  assert.equal(published.at(-1).maxSteps, 12);
  sync.stop();
});

test('stopping a reader aborts its request and prevents late publication', async () => {
  const read = deferred();
  let published = 0,
    ready = 0,
    signal;
  const sync = createChatSettingsSync({
    read: async (nextSignal) => {
      signal = nextSignal;
      return read.promise;
    },
    write: async () => settings(),
    publish: () => published++,
    ready: () => ready++,
  });
  sync.refresh();
  await turn();
  sync.stop();
  read.resolve(settings());
  await turn();
  assert.equal(signal.aborted, true);
  assert.equal(published, 0);
  assert.equal(ready, 0);
  await assert.rejects(sync.change({ maxSteps: 4 }), /unavailable/);
});

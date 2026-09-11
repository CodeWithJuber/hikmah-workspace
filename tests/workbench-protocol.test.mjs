// A terminal socket carries keystrokes and control frames on one channel, so
// these pin down the split between them and the words the panel shows when it
// breaks.
// Run: node --test tests/workbench-protocol.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeReason, controlFrame, encodeInput } from '../lib/workbench/protocol.ts';

test('a resize frame is JSON the workbench will act on', () => {
  assert.equal(
    controlFrame({ type: 'resize', cols: 120, rows: 40 }),
    '{"type":"resize","cols":120,"rows":40}',
  );
});

test('keystrokes are bytes, so they are never read as a control frame', () => {
  // This is the whole reason input is binary: pasting a config file that
  // happens to contain a resize frame must type it, not resize the terminal.
  const pasted = controlFrame({ type: 'resize', cols: 1, rows: 1 });
  const encoded = encodeInput(pasted);
  assert.ok(encoded instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(encoded), pasted);
});

test('multi-byte input survives encoding', () => {
  // Arabic and emoji go through the same path as ASCII; a byte-per-character
  // assumption anywhere here would corrupt them.
  for (const text of ['بسم الله', 'naïve', '🌙', 'ls -la\r']) {
    assert.equal(new TextDecoder().decode(encodeInput(text)), text, text);
  }
});

test('a closed socket is explained in words, not a number', () => {
  assert.match(closeReason(1000), /ended/);
  assert.match(closeReason(1006), /dropped/);
  assert.match(closeReason(1008), /refused/);
  assert.match(closeReason(4999), /4999/);
});

// The consent-first opt-in state machine. Unknown is never consent; STOP
// always wins, even over an existing opt-in; START re-opens the door.
// Run: node --test tests/whatsapp-optin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyword, nextOptInState, maySendTo } from '../lib/whatsapp/optin.ts';

test('STOP and its siblings read as opt-out, whatever the case', () => {
  for (const word of ['STOP', 'stop', 'Stop', 'UNSUBSCRIBE', 'cancel', 'END', 'quit']) {
    assert.equal(classifyKeyword(word), 'opt_out', word);
  }
});

test('START and its siblings read as opt-in', () => {
  for (const word of ['START', 'start', 'Subscribe', 'unstop']) {
    assert.equal(classifyKeyword(word), 'opt_in', word);
  }
});

test('only a whole message counts — "stop by later" is not an opt-out', () => {
  assert.equal(classifyKeyword('stop by later'), null);
  assert.equal(classifyKeyword('please stop'), null);
  assert.equal(classifyKeyword('hello there'), null);
});

test('punctuation and quoting around a keyword still count', () => {
  assert.equal(classifyKeyword('  "STOP!"  '), 'opt_out');
  assert.equal(classifyKeyword('START.'), 'opt_in');
});

test('empty and missing text is no verdict', () => {
  assert.equal(classifyKeyword(''), null);
  assert.equal(classifyKeyword(null), null);
  assert.equal(classifyKeyword(undefined), null);
});

test('an opt-out always wins, even over a live opt-in', () => {
  assert.equal(nextOptInState('opted_in', 'opt_out'), 'opted_out');
  assert.equal(nextOptInState(null, 'opt_out'), 'opted_out');
});

test('an opt-in re-opens after an opt-out, or starts from nothing', () => {
  assert.equal(nextOptInState('opted_out', 'opt_in'), 'opted_in');
  assert.equal(nextOptInState(null, 'opt_in'), 'opted_in');
});

test('no verdict keeps the current state, including unknown', () => {
  assert.equal(nextOptInState('opted_in', null), 'opted_in');
  assert.equal(nextOptInState(null, null), null);
});

test('sending is allowed only on a recorded opt-in', () => {
  assert.equal(maySendTo('opted_in'), true);
  assert.equal(maySendTo('opted_out'), false);
  assert.equal(maySendTo(null), false, 'unknown is not consent');
});

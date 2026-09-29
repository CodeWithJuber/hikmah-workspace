/** Free mode vs plan mode: the named mode a run is in.
 *
 * JEV decision `free-with-upgrade-path`: the OpenRouter free tier stays the
 * default, treated as a clean "Free mode" (free-only, slower), against "Plan
 * mode" (paid/fast). The pill (Track 2) and /pricing (Track 3) hook into this
 * one function, so the properties worth holding are: the default connection
 * reads as free, switching freeOnly off reads as plan, and endpoints where
 * the free-only gate is vacuous (local servers, all-free providers) read as
 * plan — because nothing throttles them.
 * Run: node --test tests/chat-mode.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatModeFor, chatModeLabel } from '../lib/chat/mode.ts';
import { DEFAULT_CHAT_SETTINGS } from '../lib/chat/settings.ts';

test('the default connection is free mode', () => {
  // OpenRouter free tier, freeOnly on: the JEV free-with-upgrade-path default.
  assert.equal(DEFAULT_CHAT_SETTINGS.connection.freeOnly, true);
  assert.equal(chatModeFor(DEFAULT_CHAT_SETTINGS.connection), 'free');
});

test('switching free-only off is plan mode', () => {
  assert.equal(
    chatModeFor({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
      freeOnly: false,
      apiKeySecret: 'OPENROUTER',
    }),
    'plan',
  );
});

test('a local server with free-only on is plan mode, not free', () => {
  // The free-only gate is vacuous on an endpoint nothing is charged for —
  // assertModelAllowed skips exactly these — so the run is not throttled and
  // the "Free mode · slower" pill would be a lie.
  assert.equal(chatModeFor({ baseUrl: 'http://localhost:11434/v1', freeOnly: true }), 'plan');
  assert.equal(chatModeFor({ baseUrl: 'http://192.168.1.10:8000/v1', freeOnly: true }), 'plan');
});

test('a paid model still picked under free-only stays free mode', () => {
  // The mode names the switch, not the model's fate: assertModelAllowed
  // refuses the run before it starts. The pill must not claim "Plan mode"
  // for a run that cannot spend.
  assert.equal(
    chatModeFor({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
      freeOnly: true,
      apiKeySecret: '',
    }),
    'free',
  );
});

test('labels are plain words for the pill', () => {
  assert.equal(chatModeLabel('free'), 'Free mode');
  assert.equal(chatModeLabel('plan'), 'Plan mode');
});

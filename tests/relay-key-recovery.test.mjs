import test from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_ERRORS } from '../lib/playground/provider-routes.ts';
import { failureAction } from '../components/chat/chat-experience.ts';

/** Regression test for the "Missing Authentication header" UX bug.
 *
 * When the relay refuses a chat for want of a key (relay_key), the user must
 * see an "Add a key" button taking them to Settings — not a useless
 * "Try again". That button appears only when failureAction() maps the relay's
 * key message to 'configure'.
 */
test('relay key refusal maps to the configure recovery action', () => {
  const message = RELAY_ERRORS.key.message;
  assert.equal(
    failureAction(message),
    'configure',
    `relay 'key' message must trigger the "Add a key" recovery, got: ${message}`,
  );
});

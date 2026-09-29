// P2-14 verification, pinned: message action toolbars are never
// display:none/opacity:0-gated on hover alone. Buttons stay in the DOM,
// reveal via :hover AND :focus-within, stay visible on touch, and every
// icon-only button carries an accessible name.
// Run: node --test tests/chat-message-actions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allStyles } from './stylesheet.mjs';

const message = readFileSync('components/ai-elements/message.tsx', 'utf8');
const parts = readFileSync('components/chat/message-parts.tsx', 'utf8');
const css = allStyles();

test('MessageActions is an unconditional div, always in the DOM', () => {
  const block = message.slice(message.indexOf('export const MessageActions'));
  const def = block.slice(0, block.indexOf('};') + 2);
  assert.ok(def.includes('<div'), 'renders a div');
  assert.ok(!def.includes('display'), 'no display gating in the component');
  assert.ok(!def.includes('opacity'), 'no opacity gating in the component');
});

test('MessageToolbar has no hover/opacity reveal gating', () => {
  const block = message.slice(message.indexOf('export const MessageToolbar'));
  const def = block.slice(0, block.indexOf('};') + 2);
  assert.ok(!/opacity|display:\s*none|group-hover/.test(def), 'no reveal gating');
});

test('every MessageAction carries an sr-only accessible name', () => {
  const block = message.slice(message.indexOf('export const MessageAction ='));
  const def = block.slice(0, block.indexOf('\n};') + 3);
  assert.ok(def.includes('sr-only'), 'sr-only name element present');
  assert.ok(def.includes('label || tooltip'), 'name falls back to tooltip text');
});

test('icon-only actions in message-parts all name themselves', () => {
  // CopyAction / RememberAction pass explicit aria-labels; the rest go
  // through MessageAction with a tooltip.
  for (const name of ['CopyAction', 'RememberAction', 'FeedbackButtons']) {
    assert.ok(parts.includes(name), `${name} is rendered`);
  }
  assert.ok(parts.includes('aria-label={label}'), 'stateful actions set aria-label');
});

test('hover-revealed ask-actions also reveal on focus-within', () => {
  assert.ok(css.includes('.chat-ask-actions:focus-within'), 'keyboard focus reveals the row');
  assert.ok(css.includes('.group:hover > .chat-ask-actions'), 'hover reveals the row');
});

test('ask-actions stay visible on touch (no hover)', () => {
  const hoverNone = css.indexOf('@media (hover: none)');
  assert.ok(hoverNone > -1, 'touch rule exists');
  const touchBlock = css.slice(hoverNone, hoverNone + 600);
  assert.ok(touchBlock.includes('.chat-ask-actions'), 'touch rule targets the row');
  assert.ok(!touchBlock.includes('opacity: 0;'), 'touch never fully hides the row');
});

test('no display:none anywhere on the action rows', () => {
  const askBlock = css.slice(
    css.indexOf('.chat-ask-actions'),
    css.indexOf('.chat-ask-actions') + 1200,
  );
  assert.ok(!askBlock.includes('display: none'), 'ask-actions never display:none');
});

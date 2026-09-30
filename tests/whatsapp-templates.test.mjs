// Templates and the 24h session window. Outside the window only approved
// templates may go out; inside it anything goes; an unknown template is a
// 404 and a not-approved one a 403.
// Run: node --test tests/whatsapp-templates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_WINDOW_MS,
  withinSessionWindow,
  findTemplate,
  renderTemplate,
  gateMessageKind,
  WhatsAppTemplateError,
} from '../lib/whatsapp/templates.ts';

const NOW = Date.parse('2026-09-30T06:00:00.000Z');
const approved = {
  name: 'hello_world',
  language: 'en_US',
  category: 'utility',
  body: 'Hello {{1}}, your code is {{2}}.',
  variableCount: 2,
  status: 'approved',
};
const pending = { ...approved, name: 'promo', status: 'pending' };
const TEMPLATES = [approved, pending];

const iso = (ms) => new Date(ms).toISOString();

test('the window is open on a recent inbound, closed after 24h', () => {
  assert.equal(withinSessionWindow(iso(NOW - 60_000), NOW), true);
  assert.equal(withinSessionWindow(iso(NOW - SESSION_WINDOW_MS - 1), NOW), false);
  assert.equal(withinSessionWindow(iso(NOW - SESSION_WINDOW_MS), NOW), false);
});

test('no inbound, or an unparsable one, means the window is closed', () => {
  assert.equal(withinSessionWindow(null, NOW), false);
  assert.equal(withinSessionWindow('not-a-date', NOW), false);
});

test('templates resolve by name, optionally by language', () => {
  assert.equal(findTemplate(TEMPLATES, 'hello_world')?.name, 'hello_world');
  assert.equal(findTemplate(TEMPLATES, 'hello_world', 'en_US')?.name, 'hello_world');
  assert.equal(findTemplate(TEMPLATES, 'hello_world', 'hi'), undefined);
  assert.equal(findTemplate(TEMPLATES, 'nope'), undefined);
});

test('renderTemplate fills {{1}}..{{n}} in order', () => {
  assert.equal(renderTemplate('Hi {{1}}, code {{2}}.', ['Asha', '482']), 'Hi Asha, code 482.');
});

test('renderTemplate throws when a parameter is missing', () => {
  assert.throws(() => renderTemplate('Hi {{1}}, code {{2}}.', ['Asha']), WhatsAppTemplateError);
});

test('free-form is a session message while the window is open', () => {
  const gated = gateMessageKind({ windowOpen: true, templateName: null, templates: TEMPLATES });
  assert.equal(gated.kind, 'session');
  assert.equal(gated.template, null);
});

test('free-form outside the window is refused', () => {
  assert.throws(
    () => gateMessageKind({ windowOpen: false, templateName: null, templates: TEMPLATES }),
    (error) => error instanceof WhatsAppTemplateError && error.status === 403,
  );
});

test('an approved template goes out even with the window closed', () => {
  const gated = gateMessageKind({
    windowOpen: false,
    templateName: 'hello_world',
    templates: TEMPLATES,
    templateParams: ['Asha', '482'],
  });
  assert.equal(gated.kind, 'template');
  assert.equal(gated.template?.name, 'hello_world');
});

test('a pending template outside the window is refused', () => {
  assert.throws(
    () => gateMessageKind({ windowOpen: false, templateName: 'promo', templates: TEMPLATES }),
    (error) => error instanceof WhatsAppTemplateError && error.status === 403,
  );
});

test('an unknown template name is a 404, not a silent drop', () => {
  assert.throws(
    () => gateMessageKind({ windowOpen: false, templateName: 'ghost', templates: TEMPLATES }),
    (error) => error instanceof WhatsAppTemplateError && error.status === 404,
  );
});

test('template parameters are validated at gate time', () => {
  assert.throws(
    () =>
      gateMessageKind({
        windowOpen: false,
        templateName: 'hello_world',
        templates: TEMPLATES,
        templateParams: ['only-one'],
      }),
    WhatsAppTemplateError,
  );
});

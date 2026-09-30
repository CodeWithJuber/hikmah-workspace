// Building the raw RFC 2822 bytes for the send call, and parsing the
// nested payload the read call returns. Pure functions, no network.
// Run: node --test tests/gmail-messages.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlDecode,
  base64UrlEncode,
  buildRawMessage,
  parseGmailMessage,
} from '../lib/gmail/messages.ts';

test('base64url round-trips without padding or +/', () => {
  const bytes = new Uint8Array([251, 239, 190, 0, 65]);
  const encoded = base64UrlEncode(bytes);
  assert.ok(!/[+/=]/.test(encoded));
  assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
});

test('the built message carries To, Subject and the body', () => {
  const raw = buildRawMessage({
    to: ['a@example.com', 'b@example.com'],
    subject: 'Hello',
    body: 'Hi there.',
  });
  assert.ok(raw.includes('To: a@example.com, b@example.com'));
  assert.ok(raw.includes('Subject: Hello'));
  assert.ok(raw.includes('Hi there.'));
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'));
});

test('Cc, In-Reply-To and References ride along on a reply', () => {
  const raw = buildRawMessage({
    to: ['a@example.com'],
    cc: ['c@example.com'],
    subject: 'Re: x',
    body: 'y',
    inReplyTo: '<msg1@mail>',
  });
  assert.ok(raw.includes('Cc: c@example.com'));
  assert.ok(raw.includes('In-Reply-To: <msg1@mail>'));
  assert.ok(raw.includes('References: <msg1@mail>'));
});

test('a non-ASCII subject is RFC 2047 encoded, not raw UTF-8 in the header', () => {
  const raw = buildRawMessage({ to: ['a@example.com'], subject: 'مرحبا بالعالم', body: 'x' });
  const headerBlock = raw.split('\r\n\r\n')[0];
  assert.ok(headerBlock.includes('=?UTF-8?B?'), 'encoded word present');
  assert.ok(!/[^\x00-\x7F]/.test(headerBlock), 'headers stay ASCII');
});

test('long headers fold at 78 columns', () => {
  const raw = buildRawMessage({
    to: ['a@example.com'],
    subject: 'a very long subject '.repeat(10),
    body: 'x',
  });
  for (const line of raw.split('\r\n\r\n')[0].split('\r\n')) assert.ok(line.length <= 78, line);
});

test('a nested multipart payload resolves to its text/plain part', () => {
  const text = 'Hello from the plain part.';
  const message = parseGmailMessage({
    id: 'm1',
    threadId: 't1',
    snippet: 'Hello…',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'someone@example.com' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: 'Test' },
        { name: 'Date', value: 'Wed, 30 Sep 2026 04:00:00 +0000' },
      ],
      parts: [
        {
          mimeType: 'text/html',
          body: { data: base64UrlEncode(new TextEncoder().encode('<b>hi</b>')) },
        },
        { mimeType: 'text/plain', body: { data: base64UrlEncode(new TextEncoder().encode(text)) } },
      ],
    },
  });
  assert.equal(message.from, 'someone@example.com');
  assert.equal(message.subject, 'Test');
  assert.equal(message.snippet, 'Hello…');
  assert.equal(message.body, text);
});

test('a message with no usable body parses without throwing', () => {
  const message = parseGmailMessage({ id: 'm2', threadId: 't2', payload: { headers: [] } });
  assert.equal(message.body, '');
  assert.equal(message.subject, '');
});

// The /labs/[id] route is a server component. It must not import data from a
// 'use client' module: on the server that import resolves to a client-reference
// proxy, so `labs.find` throws "m.labs.find is not a function" and the page
// 500s. The directory data lives in labs-data.ts (no 'use client') instead.
// Run: node --test tests/labs-data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSrc = readFileSync(new URL('../app/(app)/labs/[id]/page.tsx', import.meta.url), 'utf8');
const dataSrc = readFileSync(new URL('../components/app/labs-data.ts', import.meta.url), 'utf8');

test('the server-side lab page imports labs from the plain data module', () => {
  assert.match(pageSrc, /from '@\/components\/app\/labs-data'/);
  assert.doesNotMatch(pageSrc, /from '@\/components\/app\/labs-page'/);
});

test('the labs data module is not a client module', () => {
  const firstLine = dataSrc.split('\n')[0].trim();
  assert.ok(
    !/^['"]use client['"];?$/.test(firstLine),
    'labs-data.ts must not carry a use-client directive',
  );
  assert.match(dataSrc, /export const labs/);
});

test('the labs data covers every lab route the page can render', () => {
  for (const id of ['meaning', 'learn', 'planning', 'sound', 'maths']) {
    assert.match(dataSrc, new RegExp(`id: '${id}'`), `missing lab entry: ${id}`);
  }
});

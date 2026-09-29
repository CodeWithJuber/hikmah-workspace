import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'hikmah-mobile-nav-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'mobile-nav.cjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { mobileNavTabs, mobileNavOverflow } from './components/app/mobile-nav-bar';
      import { isNavActive, primaryNavItems, adminNavItems } from './components/app/product-nav';
      export const api = { mobileNavTabs, mobileNavOverflow, isNavActive, primaryNavItems, adminNavItems };
    `,
    resolveDir: root,
    sourcefile: 'mobile-nav-test.tsx',
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const { api } = createRequire(import.meta.url)(output);

test('the bottom bar shows the four thumb-primary destinations, no more', () => {
  const tabs = api.mobileNavTabs();
  assert.equal(tabs.length, 4);
  assert.deepEqual(
    tabs.map((t) => t.label),
    ['Chat', 'Assistants', 'Memory', 'Teach'],
  );
});

test('the More sheet holds exactly the remaining primaries', () => {
  const overflow = api.mobileNavOverflow();
  assert.deepEqual(
    overflow.map((t) => t.label),
    ['Playground', 'Settings'],
  );
});

test('tabs and overflow partition the primary nav with no overlap or gaps', () => {
  const tabs = api.mobileNavTabs();
  const overflow = api.mobileNavOverflow();
  const combined = [...tabs, ...overflow];
  assert.equal(combined.length, api.primaryNavItems.length);
  assert.deepEqual(
    combined.map((t) => t.href).sort(),
    api.primaryNavItems.map((t) => t.href).sort(),
  );
});

test('the More sheet never claims admin destinations; those stay owner-gated', () => {
  const overflowHrefs = new Set(api.mobileNavOverflow().map((t) => t.href));
  for (const item of api.adminNavItems) {
    assert.ok(!overflowHrefs.has(item.href), `${item.label} leaked into the More sheet`);
  }
  assert.ok(api.adminNavItems.length >= 1);
});

test('isNavActive matches the destination and its sub-pages only', () => {
  assert.ok(api.isNavActive('/chat', '/chat'));
  assert.ok(api.isNavActive('/chat', '/chat/abc123'));
  assert.ok(!api.isNavActive('/chat', '/chats'));
  assert.ok(!api.isNavActive('/chat', '/agents'));
  assert.ok(api.isNavActive('/settings', '/settings/billing/x'));
});

// Moved routes keep their old addresses working (PR-11). The nav
// reorganization moved three surfaces; each old address redirects instead of
// 404ing, and every redirect target must itself be a real route. This file
// pins the catalogue and rejects dangling redirects anywhere under app/.
// Run: node --test tests/route-redirects.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** Every page route: each page.tsx under app becomes a URL path, with [seg] kept literal. */
function pageRoutes() {
  const routes = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.startsWith('(') && name.endsWith(')')) walk(full, prefix);
        else walk(full, prefix + '/' + name);
      } else if (name === 'page.tsx') routes.push(prefix || '/');
    }
  };
  walk(app, '');
  return routes;
}

/** A redirect target resolves when a page route matches it segment-wise,
 * treating [param] segments as wildcards. */
function resolves(target, routes) {
  const parts = target.split('/').filter(Boolean);
  return routes.some((route) => {
    const rparts = route.split('/').filter(Boolean);
    return (
      rparts.length === parts.length &&
      rparts.every((seg, i) => seg.startsWith('[') || seg === parts[i])
    );
  });
}

/** The moved-route catalogue: old address -> where it lands now. */
const REDIRECTS = [
  {
    file: 'app/workspace/page.tsx',
    target: '/chat',
    note: 'the old workspace shell (hash-routed) lands on chat, the front door',
  },
  {
    file: 'app/(app)/admin/page.tsx',
    target: '/settings/overview',
    note: 'the old settings address lands on the settings overview tab',
  },
  {
    file: 'app/chat/page.tsx',
    target: '/learning',
    note: 'the removed ?view=learning embedded mode lands on the learning route',
    guard: "requested.view === 'learning'",
  },
];

test('every moved route in the catalogue redirects to its new address', () => {
  for (const { file, target, guard } of REDIRECTS) {
    const source = read(file);
    assert.ok(source.includes(`redirect('${target}')`), `${file} must redirect to ${target}`);
    if (guard) assert.ok(source.includes(guard), `${file} must only redirect under its guard`);
  }
});

test('every redirect target is a real route', () => {
  const routes = pageRoutes();
  for (const { file, target } of REDIRECTS)
    assert.ok(resolves(target, routes), `${file}: ${target} matches no page route`);
});

test('no page redirects anywhere that does not exist', () => {
  const routes = pageRoutes();
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'page.tsx') pages.push(full);
    }
  };
  walk(app);
  const dangling = [];
  for (const file of pages) {
    const source = readFileSync(file, 'utf8');
    for (const [, target] of source.matchAll(/redirect\('([^']+)'\)/g)) {
      if (target.startsWith('/') && !resolves(target, routes))
        dangling.push(`${file}: redirect('${target}')`);
    }
  }
  assert.deepEqual(dangling, [], 'dangling redirects: ' + dangling.join('; '));
});

test('the chat entry forwards the connection-settings deep link', () => {
  const entry = read('app/chat/page.tsx');
  assert.ok(
    entry.includes("requested.settings === 'connection'"),
    '/chat must notice ?settings=connection',
  );
  assert.ok(entry.includes("query.set('settings', 'connection')"), 'and forward it');
  const shell = read('components/chat/chat-shell.tsx');
  assert.ok(
    shell.includes("params.get('settings') === 'connection'"),
    'the chat shell must open the settings drawer for it',
  );
});

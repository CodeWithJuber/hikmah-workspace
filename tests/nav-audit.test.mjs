// The nav audit for PR-11: every surface reachable before the Chat/Studio
// navigation reorganization must still be reachable after it. This file lists
// every page route and how a user reaches it — primary nav, the mobile More
// sheet, the settings hub, the chat drawer, the command palette, in-page
// links, redirects for moved routes — and asserts the catalogue against the
// code: no undocumented surfaces, no nav links to nowhere, no evidence file
// that lost its link.
// Run: node --test tests/nav-audit.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');
const read = (p) => readFileSync(join(root, p), 'utf8');

// The nav modules, bundled like tests/mobile-nav.test.mjs does.
const directory = await mkdtemp(join(tmpdir(), 'hikmah-nav-audit-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'nav-audit.cjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { mobileNavTabs, mobileNavOverflow } from './components/app/mobile-nav-bar';
      import { primaryNavItems, adminNavItems, staffConsoleNavItem } from './components/app/product-nav';
      export const api = { mobileNavTabs, mobileNavOverflow, primaryNavItems, adminNavItems, staffConsoleNavItem };
    `,
    resolveDir: root,
    sourcefile: 'nav-audit-test.tsx',
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

/** Every page route: each page.tsx under app becomes a URL path. */
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

/**
 * How a user reaches every surface. `via`:
 *  primary      — the desktop sidebar / mobile bottom bar or More sheet
 *  admin-nav    — the permission-gated Administration nav group
 *  settings-hub — one tap deeper: the /settings link rows
 *  chat-drawer  — the chat shell's conversation drawer / command palette
 *  in-page      — linked from the parent screen itself
 *  redirect     — a moved route's old address (pinned in route-redirects.test.mjs)
 *  out-of-band  — no in-app navigation; the URL arrives another way
 *  public       — marketing/auth pages outside the product shell
 * `movedFrom` names the pre-reorganization address where one existed.
 */
const SURFACES = [
  { route: '/', via: 'public' },
  { route: '/chat', via: 'primary' },
  {
    route: '/chat/[id]',
    via: 'chat-drawer',
    evidence: ['components/chat/conversation-list.tsx', '`/chat/${'],
  },
  {
    route: '/workspace',
    via: 'redirect',
    target: '/chat',
    movedFrom: 'the old hash-routed workspace shell',
  },
  {
    route: '/admin',
    via: 'redirect',
    target: '/settings/overview',
    movedFrom: 'the old settings address',
  },
  { route: '/agents', via: 'primary' },
  { route: '/knowledge', via: 'primary' },
  { route: '/learning', via: 'primary' },
  { route: '/labs', via: 'primary' },
  { route: '/labs/[id]', via: 'in-page', evidence: ['components/app/labs-page.tsx', "'/labs/' +"] },
  { route: '/billing', via: 'primary' },
  { route: '/settings', via: 'primary' },
  {
    route: '/settings/[tab]',
    via: 'in-page',
    evidence: ['components/playground/admin.tsx', "'/settings/' +"],
  },
  { route: '/staff', via: 'admin-nav' },
  { route: '/superadmin', via: 'admin-nav' },
  {
    route: '/superadmin/[tab]',
    via: 'in-page',
    evidence: ['components/playground/learning-home.tsx', "'/' + l.page"],
  },
  {
    route: '/connections',
    via: 'settings-hub',
    evidence: ['components/app/settings-page.tsx', "'/connections'"],
  },
  {
    route: '/kernel',
    via: 'settings-hub',
    evidence: ['components/app/settings-page.tsx', "'/kernel'"],
  },
  {
    route: '/terminal',
    via: 'settings-hub',
    evidence: ['components/app/settings-page.tsx', "'/terminal'"],
  },
  {
    route: '/tools',
    via: 'settings-hub',
    evidence: ['components/app/settings-page.tsx', "'/tools'"],
  },
  {
    route: '/compare',
    via: 'chat-drawer',
    evidence: ['components/chat/conversation-list.tsx', 'href="/compare"'],
  },
  {
    route: '/share/[token]',
    via: 'out-of-band',
    note: 'share URLs are copied, never navigated to in-app',
  },
  { route: '/pricing', via: 'public' },
  { route: '/privacy', via: 'public' },
  { route: '/terms', via: 'public' },
  { route: '/sign-in', via: 'public' },
  { route: '/sign-out', via: 'public' },
  { route: '/sign-up', via: 'public' },
  { route: '/forgot-password', via: 'public' },
  { route: '/reset-password', via: 'public' },
];

test('no page route is missing from the audit catalogue', () => {
  const known = new Set(SURFACES.map((s) => s.route));
  const missing = pageRoutes().filter((route) => !known.has(route));
  assert.deepEqual(missing, [], 'undocumented surfaces: ' + missing.join(', '));
});

test('every catalogue route is a real page', () => {
  const routes = pageRoutes();
  for (const { route } of SURFACES)
    assert.ok(resolves(route, routes), `${route} matches no page.tsx`);
});

test('primary and admin nav items all resolve to real pages', () => {
  const routes = pageRoutes();
  const navHrefs = [
    ...api.primaryNavItems.map((i) => i.href),
    ...api.adminNavItems.map((i) => i.href),
    api.staffConsoleNavItem.href,
  ];
  for (const href of navHrefs)
    assert.ok(resolves(href, routes), `nav links to ${href}, which is no page`);
  for (const { route, via } of SURFACES)
    if (via === 'primary' || via === 'admin-nav')
      assert.ok(navHrefs.includes(route), `${route} claims ${via} but no nav item points at it`);
});

test('every primary destination stays reachable on a phone', () => {
  const mobile = new Set([
    ...api.mobileNavTabs().map((i) => i.href),
    ...api.mobileNavOverflow().map((i) => i.href),
  ]);
  for (const { route, via } of SURFACES)
    if (via === 'primary')
      assert.ok(mobile.has(route), `${route} is in the desktop nav but lost on mobile`);
});

test('one-tap-deeper surfaces still have their links', () => {
  for (const { route, via, evidence } of SURFACES) {
    if (!evidence) continue;
    const [file, snippet] = evidence;
    assert.ok(
      read(file).includes(snippet),
      `${route} claims ${via} via ${file}, but the link is gone`,
    );
  }
});

test('moved routes keep a redirect entry pointing at a real page', () => {
  const routes = pageRoutes();
  const moved = SURFACES.filter((s) => s.via === 'redirect');
  assert.ok(moved.length >= 2, 'the audit must name the moved routes');
  for (const { route, target, movedFrom } of moved) {
    assert.ok(target, `${route} needs a redirect target`);
    assert.ok(movedFrom, `${route} must name its pre-change address`);
    assert.ok(resolves(target, routes), `${route} redirects to ${target}, which is no page`);
  }
});

test('every (app) route renders inside the one AppShell', () => {
  const layout = read('app/(app)/layout.tsx');
  assert.ok(layout.includes('<AppShell>'), 'the (app) group layout must render AppShell');
});

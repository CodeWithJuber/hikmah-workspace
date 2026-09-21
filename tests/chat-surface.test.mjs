/** The chat surface's own wiring: the theme it opens in, and the way out of it.
 *
 * The theme travels through a cookie because the preference itself lives in the
 * workspace blob, which the root layout cannot afford to read. That path has no
 * other test, and getting it wrong is invisible until someone with a dark
 * workspace opens /chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allStyles } from './stylesheet.mjs';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-chat-'));
await build({
  entryPoints: ['lib/theme.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { isTheme, themeCookie, THEME_COOKIE } = await import(pathToFileURL(join(dir, 'theme.mjs')));
test.after(async () => rm(dir, { recursive: true, force: true }));

const layout = await readFile('app/layout.tsx', 'utf8');
const context = await readFile('components/playground/context.tsx', 'utf8');
const shell = await readFile('components/chat/chat-shell.tsx', 'utf8');
// Every rule lives in a file globals.css imports; reading globals.css alone
// would find none of them and quietly pass.
const css = allStyles();

test('only the two real themes are accepted from the cookie', () => {
  assert.equal(isTheme('dark'), true);
  assert.equal(isTheme('light'), true);
  for (const value of ['DARK', '', 'system', null, undefined, 0, {}])
    assert.equal(isTheme(value), false, `accepted ${JSON.stringify(value)}`);
});

test('the theme cookie outlives the session and never leaves this site', () => {
  const cookie = themeCookie('dark');
  assert.match(cookie, new RegExp(`^${THEME_COOKIE}=dark;`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /SameSite=Lax/);
  // A theme is a preference, not a session: expiring it with the login would
  // put the flash back on the next sign-in.
  assert.match(cookie, /Max-Age=31536000/);
  // It is read by script on purpose — the workspace writes it — so it must not
  // claim to be HttpOnly, and it carries nothing worth protecting.
  assert.doesNotMatch(cookie, /HttpOnly/);
});

test('the layout paints the saved theme, and the workspace keeps it current', () => {
  assert.match(layout, /data-theme=\{theme\}/);
  assert.match(layout, /THEME_COOKIE/);
  assert.match(context, /document\.cookie = themeCookie\(preferences\.theme\);/);
});

test('the theme has a source that does not depend on the workspace mounting', () => {
  // The cookie is written in the browser by the workspace provider. Since the
  // chat became the default surface, an owner can sign in, land on /chat and
  // never mount it — so a saved dark theme painted light until they happened to
  // open /workspace. The cookie is the fast path, not the only one.
  assert.match(layout, /savedTheme\(\)/);
  assert.match(layout, /isTheme\(cookie\) \? cookie : await savedTheme\(\)/);
});

test('the chat surface has a way back to the rest of the workspace', () => {
  // Open the actual tool, rather than dropping the user into another home
  // screen whose duplicate navigation they must learn first.
  assert.match(shell, /href="\/workspace#\/terminal"/);
  assert.match(shell, /href="\/workspace#\/connections"/);
  assert.match(shell, /href="\/sign-out"/);
});

test('workspace destinations keep their names in the mobile navigation', () => {
  for (const [href, label] of [
    ['/workspace#/terminal', 'Terminal & SSH'],
    ['/workspace#/connections', 'Connected services'],
  ]) {
    const link = shell.slice(shell.indexOf(`href="${href}"`));
    assert.ok(link.slice(0, link.indexOf('</Link>')).includes(label), `${href} needs visible text`);
  }
  for (const [href, label] of [['/sign-out', 'Sign out']]) {
    const link = shell.slice(shell.indexOf(`href="${href}"`));
    const tag = link.slice(0, link.indexOf('>'));
    assert.match(tag, new RegExp(`aria-label="${label}"`), `${href} needs a name`);
    assert.match(tag, new RegExp(`title="${label}"`), `${href} needs a tooltip`);
  }
});

test('the root opens the durable chat and the workspace keeps its own route', async () => {
  const root = await readFile('app/page.tsx', 'utf8');
  const workspace = await readFile('app/workspace/page.tsx', 'utf8');
  // One place decides which conversation opens, so the two cannot disagree.
  assert.match(root, /redirect\('\/chat'\)/);
  assert.doesNotMatch(root, /Playground/);
  assert.match(workspace, /<Playground \/>/);
  // Both still need it: a redirect page that prerendered would call runService
  // at build time, and the shell reads the session.
  for (const source of [root, workspace])
    assert.match(source, /export const dynamic = 'force-dynamic'/);
});

test('the workspace shell links to the chat that now opens by default', async () => {
  const playground = await readFile('components/playground/shell.tsx', 'utf8');
  assert.match(playground, /<Link className="knowledge-nav" href="\/chat">/);
});

test('the side panels are drawers on a phone, not permanently open strips', () => {
  // They were capped at 33dvh and 40dvh and always open, which left the
  // conversation about a quarter of the screen.
  assert.ok(!css.includes('max-height: 33dvh'));
  assert.ok(!css.includes('max-height: 40dvh'));
  assert.match(css, /\.chat-drawer\.is-open/);
  assert.match(css, /\.chat-drawer-scrim/);
});

test('the width is read as external state, not written from an effect', () => {
  // An effect would paint the desktop layout once on every phone load.
  assert.match(shell, /useSyncExternalStore/);
});

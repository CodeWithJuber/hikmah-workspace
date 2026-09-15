// The seam between the app's URL builder and the workbench's upgrade handler.
//
// Both halves were tested and both passed, and the terminal still never
// connected on a real deployment. The app builds /ws/terminal because Caddy
// routes /ws/*; the workbench accepted only /terminal; Caddy's `handle` matches
// a prefix without stripping it. A browser reports every failed handshake as
// close code 1006 with no detail, so the whole thing surfaced as "The
// connection dropped."
//
// Nothing here mocks the seam: the URL the app would hand the browser is fed
// to the server the browser would reach.
// Run: node --test test/proxy-seam.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createWorkbench } from '../src/server.ts';
import { terminalUrl } from '../../lib/workbench/ticket.ts';
import { issueTicket } from '../src/ticket.ts';
import { SlotError, isUserKey } from '../src/slots.ts';

/** A terminal ticket names the account whose slot it opens. */
const USER = 'u'.repeat(32);

const TOKEN = 'w'.repeat(48);
const ORIGIN = 'http://127.0.0.1';

async function start(t) {
  const workbench = createWorkbench({
    token: TOKEN,
    // Set per test from the real port, since Origin must match exactly.
    appOrigin: undefined,
    workspace: '/tmp',
    // Slots without the uids: resolving a real one chowns, which needs root.
    // What the terminal tests are about is that a ticket names an account and
    // the shell starts in that account's directory; the kernel half is asserted
    // in the container by scripts/smoke-workbench.sh.
    slots: (userKey) => {
      // Only the chown is faked. The refusal is real, or this would be testing
      // a resolver that accepts anything — including a ticket naming nobody.
      if (!isUserKey(userKey))
        throw new SlotError('This request did not say which account it is for.');
      return {
        index: 1,
        name: 'hk01',
        uid: process.getuid(),
        gid: process.getgid(),
        home: `/tmp/u/${userKey.slice(0, 8)}`,
      };
    },
    createTerminal: () => ({ pid: 1, write: () => {}, resize: () => {}, kill: () => {} }),
  });
  const port = await workbench.listen(0);
  t.after(() => workbench.close());
  return port;
}

/** Resolve 'open', or the HTTP status the upgrade was refused with. */
function connect(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.on('open', () => {
      ws.terminate();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve(res.statusCode);
    });
    ws.on('error', (error) => {
      if (/Unexpected server response|socket hang up/.test(error.message)) return;
      reject(error);
    });
  });
}

test('the URL the app hands the browser is one the workbench accepts', async (t) => {
  const port = await start(t);
  const origin = `http://127.0.0.1:${port}`;
  // Exactly what components/workbench/terminal-panel.tsx receives from
  // /api/workbench/ticket and passes to `new WebSocket(...)`.
  const url = terminalUrl(origin, issueTicket({ scope: 'terminal', userKey: USER }, TOKEN));
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/terminal\?ticket=/, 'unchanged from the app');
  assert.equal(await connect(url, origin), 'open', 'and the workbench takes it');
});

test('the path a stripping proxy produces is accepted too', async (t) => {
  // deploy/Caddyfile now uses handle_path, which removes the /ws prefix, so the
  // workbench sees /terminal. Both spellings have to work or the fix depends on
  // which proxy is in front.
  const port = await start(t);
  const origin = `http://127.0.0.1:${port}`;
  const ticket = encodeURIComponent(issueTicket({ scope: 'terminal', userKey: USER }, TOKEN));
  assert.equal(
    await connect(`${origin.replace('http', 'ws')}/terminal?ticket=${ticket}`, origin),
    'open',
  );
});

test('an unrelated path is still refused', async (t) => {
  const port = await start(t);
  const origin = `http://127.0.0.1:${port}`;
  const ticket = encodeURIComponent(issueTicket({ scope: 'terminal', userKey: USER }, TOKEN));
  assert.equal(
    await connect(`${origin.replace('http', 'ws')}/ws/shell?ticket=${ticket}`, origin),
    404,
  );
  assert.equal(
    await connect(`${origin.replace('http', 'ws')}/ws/terminal/x?ticket=${ticket}`, origin),
    404,
  );
});

test('the Caddyfile routes the socket before the app, and strips the prefix', async () => {
  // The other half of the seam is configuration, so it is asserted as text.
  // handle would forward /ws/terminal unchanged; handle_path is what makes the
  // workbench see the path it documents.
  const { readFile } = await import('node:fs/promises');
  const caddy = await readFile(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.match(caddy, /handle_path \/ws\/\*/, 'the prefix is stripped');
  assert.ok(
    caddy.indexOf('/ws/*') < caddy.indexOf('reverse_proxy app:3000'),
    'and the socket route is matched before the catch-all',
  );
});

// The workbench is reachable from the browser, so these cover who gets in:
// the token on HTTP, and Origin + a single-use ticket on the upgrade.
// Run: node --test test/server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createWorkbench } from '../src/server.ts';
import { issueTicket } from '../src/ticket.ts';

const TOKEN = 'w'.repeat(48);
const ORIGIN = 'https://app.test';

/** A workbench on a free port with a fake shell, torn down with the test. */
async function start(t, overrides = {}) {
  const shells = [];
  const workbench = createWorkbench({
    token: TOKEN,
    appOrigin: ORIGIN,
    workspace: '/tmp',
    createTerminal: (options) => {
      const shell = { options, written: [], resized: [], killed: 0 };
      shells.push(shell);
      return {
        pid: 1,
        write: (d) => shell.written.push(d),
        resize: (c, r) => shell.resized.push([c, r]),
        kill: () => {
          shell.killed += 1;
        },
      };
    },
    ...overrides,
  });
  const port = await workbench.listen(0);
  t.after(() => workbench.close());
  return { workbench, port, shells };
}

const ticketUrl = (port, payload = { scope: 'terminal' }, secret = TOKEN) =>
  `ws://127.0.0.1:${port}/terminal?ticket=${encodeURIComponent(issueTicket(payload, secret))}`;

/** Resolve with 'open', or with the HTTP status the upgrade was refused with. */
function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: ORIGIN, ...options });
    ws.on('open', () => resolve({ outcome: 'open', ws }));
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve({ outcome: res.statusCode });
    });
    ws.on('error', (error) => {
      if (/Unexpected server response|socket hang up/.test(error.message)) return;
      reject(error);
    });
  });
}

const get = (port, path, headers) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

test('HTTP without the shared token is refused', async (t) => {
  const { port } = await start(t);
  assert.equal((await get(port, '/health')).status, 401);
  assert.equal((await get(port, '/health', { authorization: 'Bearer wrong' })).status, 401);
});

test('health reports the live session count to the app', async (t) => {
  const { port } = await start(t);
  const response = await get(port, '/health', { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(response.body, { status: 'ok', sessions: 0 });
});

test('an unknown HTTP path is a 404, not a 200', async (t) => {
  const { port } = await start(t);
  assert.equal((await get(port, '/runs', { authorization: `Bearer ${TOKEN}` })).status, 404);
});

test('a valid ticket opens a shell', async (t) => {
  const { port, shells, workbench } = await start(t);
  const { outcome, ws } = await connect(ticketUrl(port));
  assert.equal(outcome, 'open');
  assert.equal(shells.length, 1);
  assert.equal(shells[0].options.cwd, '/tmp', 'the shell starts in the workspace volume');
  assert.equal(workbench.sessionCount, 1);
  ws.close();
});

test('a page on another origin cannot open a shell', async (t) => {
  // Without this, any site the owner visits could open a terminal in their
  // browser and drive it with their cookies.
  const { port, shells } = await start(t);
  const { outcome } = await connect(ticketUrl(port), { origin: 'https://evil.test' });
  assert.equal(outcome, 403);
  assert.equal(shells.length, 0);
});

test('a forged ticket is refused', async (t) => {
  const { port } = await start(t);
  const { outcome } = await connect(ticketUrl(port, { scope: 'terminal' }, 'f'.repeat(48)));
  assert.equal(outcome, 401);
});

test('a missing ticket is refused', async (t) => {
  const { port } = await start(t);
  const { outcome } = await connect(`ws://127.0.0.1:${port}/terminal`);
  assert.equal(outcome, 401);
});

test('a ticket cannot be replayed', async (t) => {
  // Tickets travel in the URL, so they land in history and proxy logs.
  const { port } = await start(t);
  const url = ticketUrl(port);
  const first = await connect(url);
  assert.equal(first.outcome, 'open');
  assert.equal((await connect(url)).outcome, 401);
  first.ws.close();
});

test('an ssh ticket does not open a terminal', async (t) => {
  const { port } = await start(t);
  const { outcome } = await connect(ticketUrl(port, { scope: 'ssh', hostId: 'h1' }));
  assert.equal(outcome, 403);
});

test('another path is not a terminal', async (t) => {
  const { port } = await start(t);
  const url = ticketUrl(port).replace('/terminal?', '/anything?');
  assert.equal((await connect(url)).outcome, 404);
});

test('keystrokes reach the shell and a resize frame does not', async (t) => {
  const { port, shells } = await start(t);
  const { ws } = await connect(ticketUrl(port));
  ws.send('ls -la\r');
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(shells[0].written, ['ls -la\r'], 'a resize must not be typed into the shell');
  assert.deepEqual(shells[0].resized, [[120, 40]]);
  ws.close();
});

test('text that merely looks like JSON is still typed', async (t) => {
  const { port, shells } = await start(t);
  const { ws } = await connect(ticketUrl(port));
  ws.send('{not json');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(shells[0].written, ['{not json']);
  ws.close();
});

test('shell output reaches the browser', async (t) => {
  const { port, shells } = await start(t);
  const { ws } = await connect(ticketUrl(port));
  const message = new Promise((resolve) => ws.on('message', (d) => resolve(d.toString())));
  shells[0].options.onData('hello from the shell');
  assert.equal(await message, 'hello from the shell');
  ws.close();
});

test('a closed socket kills its shell rather than leaking a process', async (t) => {
  const { port, shells, workbench } = await start(t);
  const { ws } = await connect(ticketUrl(port));
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(shells[0].killed, 1);
  assert.equal(workbench.sessionCount, 0);
});

test('a shell that exits tells the browser why and closes', async (t) => {
  const { port, shells } = await start(t);
  const { ws } = await connect(ticketUrl(port));
  const done = new Promise((resolve) => {
    const seen = [];
    ws.on('message', (d) => seen.push(d.toString()));
    ws.on('close', () => resolve(seen.join('')));
  });
  shells[0].options.onExit(127);
  assert.match(await done, /exited with code 127/);
});

test('a dead socket is dropped instead of holding a shell open forever', async (t) => {
  const { port, shells } = await start(t, { heartbeatMs: 40 });
  // autoPong off makes this client look dead, which is what an unloaded tab
  // or a dropped mobile connection looks like to the server.
  const { ws } = await connect(ticketUrl(port), { autoPong: false });
  await new Promise((resolve) => ws.on('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shells[0].killed, 1);
});

test('closing the workbench kills every shell', async (t) => {
  const { port, shells, workbench } = await start(t);
  await connect(ticketUrl(port));
  await connect(ticketUrl(port));
  await workbench.close();
  assert.deepEqual(
    shells.map((s) => s.killed),
    [1, 1],
  );
});

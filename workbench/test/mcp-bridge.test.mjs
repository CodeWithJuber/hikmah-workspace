// The bridge lets the app talk to a command-line MCP server as though it were a
// remote one. It is tested against a real child process speaking real
// newline-delimited JSON-RPC, because the framing is the part most likely to be
// subtly wrong.
// Run: node --test test/mcp-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeError,
  bridgeServerId,
  createBridgePool,
  parseStdioConfig,
} from '../src/mcp-bridge.ts';

const root = mkdtempSync(join(tmpdir(), 'hikmah-bridge-'));

/** A minimal stdio MCP server: reads lines, answers requests, ignores notices. */
function serverScript(extra = '') {
  const path = join(root, `server-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      ${extra}
      if (message.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }) + '\\n');
      }
    }
    newline = buffer.indexOf('\\n');
  }
});
`,
    'utf8',
  );
  return { command: process.execPath, args: [path], env: {} };
}

const request = (id, method) => ({ jsonrpc: '2.0', id, method, params: {} });

function pool(t, options = {}) {
  const instance = createBridgePool({ workspace: root, ...options });
  t.after(() => instance.stopAll());
  return instance;
}

test('the path names which server a request is for', () => {
  assert.equal(bridgeServerId('/mcp/filesystem'), 'filesystem');
  assert.equal(bridgeServerId('/mcp/abc-123?x=1'), 'abc-123');
  for (const url of ['/mcp/', '/mcp', '/runs', '/health', '/mcp/../etc', '/mcp/a/b'])
    assert.equal(bridgeServerId(url), null, url);
});

test('a configuration must actually name a command', () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
  assert.throws(() => parseStdioConfig(undefined), BridgeError);
  assert.throws(() => parseStdioConfig('not base64 json'), BridgeError);
  assert.throws(() => parseStdioConfig(encode({})), BridgeError);
  assert.throws(() => parseStdioConfig(encode({ command: '  ' })), BridgeError);
  assert.throws(() => parseStdioConfig(encode({ command: 'npx', args: [1] })), BridgeError);

  const parsed = parseStdioConfig(encode({ command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' } }));
  assert.deepEqual(parsed, { command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' } });
});

test('a request reaches the server and its reply comes back', async (t) => {
  const bridge = pool(t);
  const reply = await bridge.call('fs', serverScript(), request(1, 'tools/list'));
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: { echoed: 'tools/list' } });
});

test('replies are matched to their own request, not to arrival order', async (t) => {
  // A server is free to answer out of order, and a bridge that assumed
  // otherwise would hand the model another call's result.
  const bridge = pool(t);
  const config = serverScript();
  const [second, first] = await Promise.all([
    bridge.call('fs', config, request(2, 'second')),
    bridge.call('fs', config, request(1, 'first')),
  ]);
  assert.equal(second.id, 2);
  assert.equal(second.result.echoed, 'second');
  assert.equal(first.id, 1);
  assert.equal(first.result.echoed, 'first');
});

test('a notification gets no reply and does not block what follows', async (t) => {
  // Waiting for an answer to a notification would hang every later call.
  const bridge = pool(t);
  const config = serverScript();
  assert.equal(await bridge.call('fs', config, { jsonrpc: '2.0', method: 'initialized' }), null);
  const reply = await bridge.call('fs', config, request(1, 'tools/list'));
  assert.equal(reply.id, 1);
});

test('one process serves many calls rather than starting per request', async (t) => {
  // npx starting a server per tool call would make every call cost seconds.
  const bridge = pool(t);
  const config = serverScript();
  await bridge.call('fs', config, request(1, 'a'));
  await bridge.call('fs', config, request(2, 'b'));
  assert.equal(bridge.size, 1);
});

test('two servers run side by side', async (t) => {
  const bridge = pool(t);
  await bridge.call('fs', serverScript(), request(1, 'a'));
  await bridge.call('fetch', serverScript(), request(1, 'a'));
  assert.equal(bridge.size, 2);
});

test('a changed configuration replaces the process rather than reusing it', async (t) => {
  // Otherwise an edited command keeps answering with the old server's tools.
  const bridge = pool(t);
  await bridge.call('fs', serverScript(), request(1, 'a'));
  const replacement = serverScript();
  const reply = await bridge.call('fs', replacement, request(2, 'after-edit'));
  assert.equal(reply.result.echoed, 'after-edit');
  assert.equal(bridge.size, 1, 'the old process is not left running');
});

test('a message that never gets an answer times out instead of hanging', async (t) => {
  const bridge = pool(t);
  // A server that reads and says nothing.
  const silent = { command: process.execPath, args: ['-e', 'process.stdin.resume()'], env: {} };
  const started = Date.now();
  const reply = await Promise.race([
    bridge.call('quiet', silent, request(1, 'tools/list')),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_500)),
  ]);
  // The real timeout is a minute; this asserts the call is pending rather than
  // resolved with nonsense, which is the failure that would matter.
  assert.equal(reply, 'still waiting');
  assert.ok(Date.now() - started >= 1_000);
});

test('a server that dies answers its pending calls instead of stranding them', async (t) => {
  const bridge = pool(t);
  const dying = { command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} };
  const reply = await bridge.call('gone', dying, request(1, 'tools/list'));
  assert.ok(reply.error, 'the caller is told, rather than waiting a minute for nothing');
  assert.equal(bridge.size, 0);
});

test('a command that cannot start is reported, not left pending', async (t) => {
  const bridge = pool(t);
  const missing = { command: 'definitely-not-a-real-command', args: [], env: {} };
  const reply = await bridge.call('nope', missing, request(1, 'tools/list'));
  assert.ok(reply.error);
});

test('an idle server is shut down rather than held open', async (t) => {
  // A pool that never lets go would keep one npx process per server the owner
  // ever enabled, for the life of the container.
  const bridge = pool(t, { idleMs: 150 });
  await bridge.call('fs', serverScript(), request(1, 'a'));
  assert.equal(bridge.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(bridge.size, 0);
});

test('a busy server is not shut down out from under a call', async (t) => {
  const bridge = pool(t, { idleMs: 300 });
  const config = serverScript();
  await bridge.call('fs', config, request(1, 'a'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await bridge.call('fs', config, request(2, 'b'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bridge.size, 1, 'each call resets the idle clock');
});

test('the environment the app sends reaches the server', async (t) => {
  // This is how a ${VAR} credential gets to a stdio server at all.
  const bridge = pool(t);
  const reporting = {
    command: process.execPath,
    args: [
      '-e',
      `let b='';process.stdin.on('data',c=>{b+=c;if(b.includes('\\n')){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{token:process.env.SERVER_TOKEN}})+'\\n');}});`,
    ],
    env: { SERVER_TOKEN: 'from-the-app' },
  };
  const reply = await bridge.call('env', reporting, request(1, 'tools/list'));
  assert.equal(reply.result.token, 'from-the-app');
});

test('non-JSON lines from a server are ignored rather than breaking the stream', async (t) => {
  // Plenty of servers print a banner on stdout before they behave.
  const bridge = pool(t);
  const chatty = serverScript("process.stdout.write('starting up\\n');");
  const reply = await bridge.call('chatty', chatty, request(1, 'tools/list'));
  assert.equal(reply.id, 1);
});

test('stopping the pool leaves nothing running', async (t) => {
  const bridge = pool(t);
  await bridge.call('a', serverScript(), request(1, 'x'));
  await bridge.call('b', serverScript(), request(1, 'x'));
  bridge.stopAll();
  assert.equal(bridge.size, 0);
});

test('a stdio MCP server gets its own variables, not the service’s secrets', async (t) => {
  // These children are the ones that already hold decrypted credentials, and
  // they were spawned with the whole of process.env — so HIKMAH_WORKBENCH_TOKEN
  // went with them. The same defect shell.ts had, in the worst place for it.
  //
  // A real child that reports what it can see, as the rest of this file does.
  process.env.HIKMAH_WORKBENCH_TOKEN = 'token-that-must-not-leak';
  t.after(() => {
    delete process.env.HIKMAH_WORKBENCH_TOKEN;
  });

  const config = serverScript(
    "if (message.method === 'env') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { hikmah: Object.keys(process.env).filter((k) => k.startsWith('HIKMAH_')), mine: process.env.MY_SERVER_TOKEN, path: Boolean(process.env.PATH) } }) + '\\n'); continue; }",
  );
  const instance = pool(t);
  const reply = await instance.call(
    's-env',
    { ...config, env: { MY_SERVER_TOKEN: 'theirs' } },
    request(1, 'env'),
  );

  assert.deepEqual(reply.result.hikmah, [], 'no HIKMAH_* reaches a stdio MCP server');
  assert.equal(reply.result.mine, 'theirs', 'its own configured variables still do');
  assert.equal(reply.result.path, true, 'and it can still find its interpreter');
});

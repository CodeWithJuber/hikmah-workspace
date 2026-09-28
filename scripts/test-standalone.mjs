import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
const root = resolve('.');
const directory = await mkdtemp(join(tmpdir(), 'hikmah-standalone-'));
let server,
  logs = '';
const environment = {
  ...process.env,
  NODE_ENV: 'production',
  HOSTNAME: '127.0.0.1',
  PORT: '3210',
  BETTER_AUTH_URL: 'http://127.0.0.1:3210',
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  // v10 seals run credentials at rest; without this the server refuses to
  // boot, and both smoke phases share this one environment so the key stays
  // stable across the restart the test exists to prove.
  HIKMAH_VAULT_KEY: randomBytes(32).toString('hex'),
  // The smoke assertions were written for the public surface (landing CTA and
  // a sign-up page that offers to make a workspace); v10 defaults a deployment
  // with an owner email to private. Both are deliberate, so the harness opts
  // this staged deployment into the public mode it exercises.
  HIKMAH_PUBLIC: '1',
  HIKMAH_DATA_DIR: join(directory, 'data'),
  HIKMAH_OWNER_EMAIL: 'owner@example.test',
  // A run is now refused up front when a hosted provider has no key, which is
  // the point of that check — but it made these smoke assertions test the
  // refusal instead of the run lifecycle they exist for.
  //
  // The key is not a real one, but the runs it admits do dial openrouter.ai and
  // wait for the 401. This comment used to claim nothing here reaches a
  // provider; that was false, and believing it cost a CI failure that read as a
  // primary-key error. smoke-http.mjs cancels every run it starts rather than
  // waiting for that round trip.
  HIKMAH_PROVIDER_KEY: 'smoke-provider-key',
  SMOKE_EMAIL: 'owner@example.test',
  SMOKE_PASSWORD: randomBytes(24).toString('base64url'),
  SMOKE_URL: 'http://127.0.0.1:3210',
  SMOKE_COOKIE_FILE: join(directory, 'cookie'),
};
const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env: environment, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(Error(`${cmd} exited ${code}`))));
  });
function start() {
  server = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: directory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const pipe of [server.stdout, server.stderr])
    pipe.on('data', (chunk) => {
      logs = (logs + chunk).slice(-5000);
    });
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const ended = once(server, 'exit');
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  try {
    await ended;
  } finally {
    clearTimeout(timer);
  }
}
try {
  // The messages index (drizzle/0015) is FTS5, and a build of SQLite without
  // it would throw at boot, on a read-only rootfs, after the release had
  // shipped. Ask this runtime before starting the server, so the failure is a
  // sentence here rather than a container that never comes up.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(x)');
    } catch (error) {
      throw Error('This SQLite has no FTS5; the messages index cannot be applied: ' + error);
    } finally {
      probe.close();
    }
  }
  await cp('.next/standalone', directory, { recursive: true, dereference: true });
  for (const folder of ['public', 'server', 'drizzle'])
    await cp(folder, join(directory, folder), { recursive: true, dereference: true });
  await cp('.next/static', join(directory, '.next/static'), { recursive: true, dereference: true });
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await cp('scripts/start.mjs', join(directory, 'scripts/start.mjs'));
  await mkdir(environment.HIKMAH_DATA_DIR, { mode: 0o700 });
  await writeFile(
    join(environment.HIKMAH_DATA_DIR, 'bootstrap-owner-password'),
    environment.SMOKE_PASSWORD,
    { mode: 0o600 },
  );
  start();
  await run(process.execPath, ['scripts/smoke-http.mjs', 'write']);
  await stop();
  start();
  await run(process.execPath, ['scripts/smoke-http.mjs', 'read']);
  console.info('Isolated standalone production server passed, including a real process restart.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}

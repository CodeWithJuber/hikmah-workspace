// Ops scripts: syntax, argument handling, and a full backup -> restore
// round-trip on a fake data dir. Run: node --test tests/ops-scripts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPTS = ['backup.sh', 'restore.sh', 'pre-migration-backup.sh'].map((s) =>
  join(ROOT, 'scripts', 'ops', s),
);

test('all ops scripts pass bash -n', () => {
  for (const s of SCRIPTS) {
    execFileSync('bash', ['-n', s], { stdio: 'pipe' });
  }
});

test('scripts reject unknown arguments', () => {
  for (const s of SCRIPTS) {
    assert.throws(
      () => execFileSync('bash', [s, '--bogus'], { stdio: 'pipe' }),
      /exit|Command failed/,
    );
  }
});

test('restore.sh requires --manifest and --target-dir', () => {
  assert.throws(() => execFileSync('bash', [SCRIPTS[1]], { stdio: 'pipe' }));
});

test('pre-migration-backup.sh requires --migration', () => {
  assert.throws(() => execFileSync('bash', [SCRIPTS[2]], { stdio: 'pipe' }));
});

test('backup.sh refuses when the database is missing', () => {
  const env = { ...process.env, HIKMAH_DATA_DIR: '/tmp/does-not-exist-hikmah' };
  assert.throws(() => execFileSync('bash', [SCRIPTS[0], '--app-stopped'], { env, stdio: 'pipe' }));
});

/** Builds a fake data dir with a sqlite db and an objects tree. */
async function fakeDataDir() {
  const tmp = await mkdtemp(join(tmpdir(), 'hikmah-ops-e2e-'));
  const data = join(tmp, 'data');
  await mkdir(join(data, 'objects', 'sub'), { recursive: true });
  await writeFile(join(data, 'objects', 'sub', 'file.txt'), 'hello');
  execFileSync('sqlite3', [
    join(data, 'workspace.sqlite'),
    'CREATE TABLE t(a); INSERT INTO t VALUES (42);',
  ]);
  return { tmp, data, backups: join(tmp, 'backups') };
}

test('backup -> manifest -> restore round-trip preserves data', async () => {
  const { data, backups } = await fakeDataDir();
  const env = {
    ...process.env,
    HIKMAH_DATA_DIR: data,
    HIKMAH_BACKUP_DIR: backups,
    HIKMAH_VAULT_KEY: 'x'.repeat(40),
  };
  execFileSync('bash', [SCRIPTS[0], '--app-stopped'], { env, stdio: 'pipe' });
  const snap = (await readdir(backups)).find((d) => d.startsWith('backup-'));
  assert.ok(snap, 'backup dir created');
  const manifest = join(backups, snap, 'MANIFEST.sha256');

  // Manifest verifies cleanly on its own (the off-host check).
  execFileSync('sha256sum', ['-c', 'MANIFEST.sha256'], { cwd: join(backups, snap), stdio: 'pipe' });

  const target = join(data, '..', 'restored');
  execFileSync('bash', [SCRIPTS[1], '--manifest', manifest, '--target-dir', target], {
    env,
    stdio: 'pipe',
  });
  const val = execFileSync('sqlite3', [join(target, 'workspace.sqlite'), 'SELECT a FROM t;'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(val, '42', 'restored database holds the row');
  const file = await readFile(join(target, 'objects', 'sub', 'file.txt'), 'utf8');
  assert.equal(file, 'hello', 'restored objects hold the file');
  const check = execFileSync(
    'sqlite3',
    [join(target, 'workspace.sqlite'), 'PRAGMA integrity_check;'],
    {
      encoding: 'utf8',
    },
  ).trim();
  assert.equal(check, 'ok');
});

test('restore.sh refuses to overwrite without --force, proceeds with it', async () => {
  const { data, backups } = await fakeDataDir();
  const env = {
    ...process.env,
    HIKMAH_DATA_DIR: data,
    HIKMAH_BACKUP_DIR: backups,
    HIKMAH_VAULT_KEY: 'x'.repeat(40),
  };
  execFileSync('bash', [SCRIPTS[0], '--app-stopped'], { env, stdio: 'pipe' });
  const snap = (await readdir(backups)).find((d) => d.startsWith('backup-'));
  const manifest = join(backups, snap, 'MANIFEST.sha256');
  const target = join(data, '..', 'restored2');
  execFileSync('bash', [SCRIPTS[1], '--manifest', manifest, '--target-dir', target], {
    env,
    stdio: 'pipe',
  });
  assert.throws(
    () =>
      execFileSync('bash', [SCRIPTS[1], '--manifest', manifest, '--target-dir', target], {
        env,
        stdio: 'pipe',
      }),
    'refuses to overwrite without --force',
  );
  execFileSync('bash', [SCRIPTS[1], '--manifest', manifest, '--target-dir', target, '--force'], {
    env,
    stdio: 'pipe',
  });
  assert.ok((await stat(join(target, 'workspace.sqlite'))).isFile(), 'force restore wrote the db');
});

test('pre-migration-backup.sh leaves a marker naming the migration', async () => {
  const { data, backups } = await fakeDataDir();
  const env = {
    ...process.env,
    HIKMAH_DATA_DIR: data,
    HIKMAH_BACKUP_DIR: backups,
    HIKMAH_VAULT_KEY: 'x'.repeat(40),
  };
  execFileSync('bash', [SCRIPTS[2], '--migration', '0037_ops'], { env, stdio: 'pipe' });
  const snap = (await readdir(backups)).find((d) => d.startsWith('pre-migration-0037_ops-'));
  assert.ok(snap, 'pre-migration snapshot dir created');
  const marker = await readFile(join(backups, snap, 'PRE_MIGRATION_MARKER.txt'), 'utf8');
  assert.ok(marker.includes('migration=0037_ops'), 'marker names the migration');
  assert.ok(marker.includes('taken_utc='), 'marker is timestamped');
});

test('backup.sh records vault-key presence without recording the key', async () => {
  const { data, backups } = await fakeDataDir();
  const env = {
    ...process.env,
    HIKMAH_DATA_DIR: data,
    HIKMAH_BACKUP_DIR: backups,
    HIKMAH_VAULT_KEY: 'super-secret-key-value-that-must-not-leak',
  };
  execFileSync('bash', [SCRIPTS[0], '--app-stopped'], { env, stdio: 'pipe' });
  const snap = (await readdir(backups)).find((d) => d.startsWith('backup-'));
  const prov = await readFile(join(backups, snap, 'PROVENANCE.txt'), 'utf8');
  assert.ok(prov.includes('vault_key_present=yes'));
  assert.ok(!prov.includes('super-secret-key-value'), 'the key value is never written to disk');
});

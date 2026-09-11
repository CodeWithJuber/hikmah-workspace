import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, unlink, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function openStorage(directory, migrations = resolve('drizzle')) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'workspace.sqlite'));
  chmodSync(join(root, 'workspace.sqlite'), 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS hikmah_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)',
  );
  const files = readdirSync(migrations)
    .filter((x) => /^\d+.*\.sql$/.test(x))
    .sort();
  for (const name of files) {
    const sql = readFileSync(join(migrations, name), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = db.prepare('SELECT sha256 FROM hikmah_migrations WHERE name = ?').get(name);
      if (applied && applied.sha256 !== hash) throw Error(`Applied migration changed: ${name}`);
      if (!applied) {
        db.exec(sql);
        db.prepare('INSERT INTO hikmah_migrations VALUES (?, ?)').run(name, hash);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  const DB = {
    prepare(sql) {
      const query = db.prepare(sql);
      const bound = (args = []) => ({
        bind: (...values) => bound(values),
        async first(column) {
          const row = query.get(...args);
          return column ? (row?.[column] ?? null) : (row ?? null);
        },
        async all() {
          return { results: query.all(...args), success: true, meta: {} };
        },
        async run() {
          const result = query.run(...args);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
          };
        },
      });
      return bound();
    },
  };
  const objectRoot = join(root, 'objects');
  mkdirSync(objectRoot, { recursive: true, mode: 0o700 });
  async function objectPath(key) {
    if (
      typeof key !== 'string' ||
      key.length > 512 ||
      !/^[a-zA-Z0-9_%./-]+$/.test(key) ||
      key.split('/').some((x) => !x || x === '.' || x === '..')
    )
      throw Error('Invalid object key');
    const parts = key.split('/');
    let path = objectRoot;
    for (const part of parts) {
      path = join(path, part);
      const info = await lstat(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info?.isSymbolicLink()) throw Error('Object path must not contain symbolic links');
    }
    return path;
  }
  const BUCKET = {
    async get(key) {
      const path = await objectPath(key);
      try {
        const text = await readFile(path, 'utf8');
        return { text: async () => text };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async put(key, body) {
      if (typeof body !== 'string' || Buffer.byteLength(body) > 24_000_000)
        throw Error('Object exceeds storage envelope');
      const path = await objectPath(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    async delete(key) {
      await unlink(await objectPath(key)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
  return { DB, BUCKET, raw: db, close: () => db.close() };
}

let storage;
export function getStorage() {
  return (storage ??= openStorage(
    process.env.HIKMAH_DATA_DIR || resolve('.data'),
    process.env.HIKMAH_MIGRATIONS_DIR || resolve('drizzle'),
  ));
}

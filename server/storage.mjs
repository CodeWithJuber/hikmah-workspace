import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, unlink, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrateRunCredentials } from './run-credentials.mjs';

export function openStorage(directory, migrations = resolve('drizzle')) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'workspace.sqlite'));
  chmodSync(join(root, 'workspace.sqlite'), 0o600);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;',
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS hikmah_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS hikmah_storage_maintenance (task TEXT PRIMARY KEY)`,
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
        // The cleanup obligation commits with the migration, so a blocked
        // checkpoint or a process crash cannot lose it on the next startup.
        db.exec("INSERT OR IGNORE INTO hikmah_storage_maintenance VALUES ('credential-scrub')");
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  try {
    migrateRunCredentials(db);
    // Rewrite secure-deleted pages into the main file and remove the old WAL.
    // This applies to the SQL migration's terminal-key scrub as well.
    if (
      db.prepare("SELECT task FROM hikmah_storage_maintenance WHERE task='credential-scrub'").get()
    ) {
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (Number(checkpoint?.busy ?? 0))
        throw Error(
          'Credential migration needs exclusive storage access. Stop other app instances and restart.',
        );
      db.exec("DELETE FROM hikmah_storage_maintenance WHERE task='credential-scrub'");
    }
  } catch (error) {
    db.close();
    throw error;
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
        const bytes = await readFile(path);
        // Both views of the same read: workspace state wants text, a generated
        // image wants the bytes, and neither should cost a second read.
        return { text: async () => bytes.toString('utf8'), bytes: async () => bytes };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async put(key, body) {
      // Binary as well as text, because generated images and speech are stored
      // here too and base64 in a text object would cost a third more disk and a
      // decode on every read.
      const binary = body instanceof Uint8Array;
      if ((typeof body !== 'string' && !binary) || Buffer.byteLength(body) > 24_000_000)
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

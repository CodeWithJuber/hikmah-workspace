/** Apply the real migrations to a test database.
 *
 * Each of these tests used to name the one or two migration files it thought it
 * needed, which meant a new migration silently left them testing a schema
 * production does not have — and the failure would show up as behaviour that
 * works in the suite and not on the box. Applying the whole directory in order,
 * the way `openStorage` does, removes that possibility.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORY = new URL('../drizzle/', import.meta.url).pathname;

/** Every migration, in the order the server applies them. */
export function migrations() {
  return readdirSync(DIRECTORY)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(join(DIRECTORY, name), 'utf8'));
}

/** Bring a fresh database up to the current schema. */
export function applySchema(db) {
  for (const sql of migrations()) db.exec(sql);
  return db;
}

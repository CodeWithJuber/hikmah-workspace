import { getStorage } from '../server/storage.mjs';
import { initializeAuth } from '../server/auth.mjs';
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
process.umask(0o077);
process.env.HIKMAH_DATA_DIR = resolve(process.env.HIKMAH_DATA_DIR || '.data');
getStorage();
await initializeAuth();
let entry = new URL('../server.js', import.meta.url);
if (!existsSync(entry)) {
  entry = new URL('../.next/standalone/server.js', import.meta.url);
  await cp(new URL('../public', import.meta.url), new URL('../.next/standalone/public', import.meta.url), { recursive: true });
  await cp(new URL('../.next/static', import.meta.url), new URL('../.next/standalone/.next/static', import.meta.url), { recursive: true });
}
await import(entry.href);

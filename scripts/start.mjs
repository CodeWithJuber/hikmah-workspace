import { getStorage } from '../server/storage.mjs';
import { initializeAuth } from '../server/auth.mjs';
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
process.umask(0o077);
process.env.HIKMAH_DATA_DIR = resolve(process.env.HIKMAH_DATA_DIR || '.data');
// v10: fail closed at boot, not lazily on first secret use. The vault key must
// never fall back to the auth secret (domain separation). Upgrades that relied
// on the old implicit default keep working by setting HIKMAH_VAULT_KEY to the
// existing BETTER_AUTH_SECRET value.
if (!process.env.HIKMAH_VAULT_KEY || process.env.HIKMAH_VAULT_KEY.length < 32) {
  console.error(
    'Refusing to start: HIKMAH_VAULT_KEY is not set (or shorter than 32 characters). ' +
      'Generate one with `openssl rand -hex 32`.',
  );
  process.exit(1);
}
getStorage();
await initializeAuth();
let entry = new URL('../server.js', import.meta.url);
if (!existsSync(entry)) {
  entry = new URL('../.next/standalone/server.js', import.meta.url);
  await cp(
    new URL('../public', import.meta.url),
    new URL('../.next/standalone/public', import.meta.url),
    { recursive: true },
  );
  await cp(
    new URL('../.next/static', import.meta.url),
    new URL('../.next/standalone/.next/static', import.meta.url),
    { recursive: true },
  );
}
await import(entry.href);

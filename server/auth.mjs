import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export function createAuth({ directory = process.env.HIKMAH_DATA_DIR || resolve('.data'), bootstrap = false } = {}) {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32) throw Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  if (!baseURL) throw Error('BETTER_AUTH_URL is required');
  const url = new URL(baseURL);
  if (url.origin !== baseURL || url.username || url.password || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('Set BETTER_AUTH_URL to your HTTPS origin (HTTP is allowed only on loopback for development)');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, 'auth.sqlite'));
  chmodSync(join(directory, 'auth.sqlite'), 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const options = {
    appName: 'Hikmah', secret, baseURL, database,
    trustedOrigins: [url.origin],
    emailAndPassword: { enabled: true, disableSignUp: !bootstrap, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 5 } } },
    advanced: { useSecureCookies: url.protocol === 'https:', ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    logger: { level: 'error' },
  };
  return { auth: betterAuth(options), options, database };
}

let instance;
export async function getAuth() {
  // Startup owns migrations; requests never modify the authentication schema.
  instance ??= createAuth();
  return instance.auth;
}

export async function initializeAuth() {
  const { auth, options, database } = createAuth({ bootstrap: true });
  try {
    await (await getMigrations(options)).runMigrations();
    const email = process.env.HIKMAH_OWNER_EMAIL?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Set a valid HIKMAH_OWNER_EMAIL');
    const existing = database.prepare('SELECT id FROM user WHERE email = ?').get(email);
    const passwordFile = join(process.env.HIKMAH_DATA_DIR || resolve('.data'), 'bootstrap-owner-password');
    if (!existing) {
      const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
      if (password.length < 12 || password.length > 128) throw Error('Owner password must have 12–128 characters');
      await auth.api.signUpEmail({ body: { email, password, name: 'Owner' } });
      console.info('Owner account created. Public registration remains disabled.');
    }
    await unlink(passwordFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } finally { database.close(); }
}

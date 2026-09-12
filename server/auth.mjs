import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { mailConfigured, resetMessage, sendMail, verifyMessage } from './email.mjs';

export function createAuth({
  directory = process.env.HIKMAH_DATA_DIR || resolve('.data'),
  bootstrap = false,
} = {}) {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32)
    throw Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  if (!baseURL) throw Error('BETTER_AUTH_URL is required');
  const url = new URL(baseURL);
  if (
    url.origin !== baseURL ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw Error(
      'Set BETTER_AUTH_URL to your HTTPS origin (HTTP is allowed only on loopback for development)',
    );
  const mail = mailConfigured();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, 'auth.sqlite'));
  chmodSync(join(directory, 'auth.sqlite'), 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const options = {
    appName: 'Hikmah',
    secret,
    baseURL,
    database,
    trustedOrigins: [url.origin],
    emailAndPassword: {
      enabled: true,
      // Open, unless the deployment says otherwise. It used to be closed to
      // everyone but the bootstrap owner, which is right for one person and
      // wrong for a product; HIKMAH_PRIVATE=1 puts it back for a deployment
      // that wants to stay private.
      disableSignUp: bootstrap ? false : privateDeployment(),
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // Only where mail can actually be sent. Requiring an address nobody can
      // confirm would lock every new account out of a deployment that has no
      // mail provider, including CI and the smoke tests.
      requireEmailVerification: mail,
      ...(mail
        ? {
            sendResetPassword: async ({ user, url }) =>
              void (await sendMail({ to: user.email, ...resetMessage(url) })),
          }
        : {}),
    },
    ...(mail
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url }) =>
              void (await sendMail({ to: user.email, ...verifyMessage(url) })),
          },
        }
      : {}),
    // Present only when the deployment has been given credentials, so a missing
    // one removes the button rather than producing one that fails on click.
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          socialProviders: {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          },
        }
      : {}),
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        // Creating accounts and asking for reset mail are both cheap for an
        // attacker and expensive for us: one fills the database, the other
        // spends the mail quota and lands in a stranger's inbox.
        '/sign-up/email': { window: 3600, max: 5 },
        '/forget-password': { window: 3600, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: url.protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    logger: { level: 'error' },
  };
  return { auth: betterAuth(options), options, database };
}

/** Whether this deployment keeps registration closed.
 *
 * The default is open, because the app is now something people sign up for. A
 * self-hosted single-owner install sets HIKMAH_PRIVATE=1 and gets the old
 * behaviour back.
 */
export function privateDeployment() {
  return /^(1|true|yes)$/i.test(process.env.HIKMAH_PRIVATE ?? '');
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
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw Error('Set a valid HIKMAH_OWNER_EMAIL');
    const existing = database.prepare('SELECT id FROM user WHERE email = ?').get(email);
    const passwordFile = join(
      process.env.HIKMAH_DATA_DIR || resolve('.data'),
      'bootstrap-owner-password',
    );
    if (!existing) {
      const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
      if (password.length < 12 || password.length > 128)
        throw Error('Owner password must have 12–128 characters');
      await auth.api.signUpEmail({ body: { email, password, name: 'Owner' } });
      console.info(
        privateDeployment()
          ? 'Owner account created. Registration is closed (HIKMAH_PRIVATE).'
          : 'Owner account created. Registration is open' +
              (mailConfigured() ? '.' : ', with no mail provider: addresses are not verified.'),
      );
    }
    await unlink(passwordFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  } finally {
    database.close();
  }
}

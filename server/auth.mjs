import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { mailConfigured, resetMessage, sendMail, verifyMessage } from './email.mjs';
import { billingConfigured, stripePlans } from './plans.mjs';
import { subscriptionHooks } from './billing-sync.mjs';

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
  const billing = stripePlugin();
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
      // v10: closed by default — a forgotten flag must never mean open signup
      // on a box holding the owner's provider keys. HIKMAH_PUBLIC=1 opens it.
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
        // PR-16: the OAuth code exchange and the provider token refresh are
        // single-attempt operations for a legitimate client — one
        // authorization code is redeemed once per login, and a provider token
        // is refreshed on its own schedule. Without an explicit rule these
        // fell through to the default 100/min bucket; anything past a
        // handful per minute is enumeration or brute force. JEV: five-per-min.
        '/callback/*': { window: 60, max: 5 },
        '/refresh-token': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: url.protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    logger: { level: 'error' },
    ...(billing ? { plugins: [billing] } : {}),
  };
  return { auth: betterAuth(options), options, database };
}

/** The Stripe plugin, or undefined on a deployment that takes no money.
 *
 * Loaded with require rather than a top-level import so an install with no
 * Stripe credentials — which is every development checkout, CI, and both smoke
 * harnesses — never pays for the module or its transitive tree, and so a
 * missing dependency can never break sign-in.
 *
 * Synchronous because createAuth is, and betterAuth wants its plugin list at
 * construction.
 */
function stripePlugin() {
  if (!billingConfigured()) return undefined;
  const plans = stripePlans();
  if (!plans.length) {
    console.warn('[hikmah] Stripe is configured but no plan has a price id; billing is off.');
    return undefined;
  }
  try {
    const require_ = createRequire(import.meta.url);
    const { stripe } = require_('@better-auth/stripe');
    const Stripe = require_('stripe').default ?? require_('stripe');
    return stripe({
      stripeClient: new Stripe(process.env.STRIPE_SECRET_KEY),
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      // So a person who signs up today can be charged tomorrow without a
      // separate "create your billing account" step they would not understand.
      createCustomerOnSignUp: true,
      subscription: { enabled: true, plans, ...subscriptionHooks },
    });
  } catch (error) {
    // A deployment that cannot load the plugin should still be able to sign in.
    console.error(
      '[hikmah] Stripe plugin not loaded:',
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/** Whether this deployment keeps registration closed.
 *
 * v10: closed by default. A self-hosted workspace holding the owner's provider
 * keys must not depend on the operator remembering a flag. Set HIKMAH_PUBLIC=1
 * to open registration. (HIKMAH_PRIVATE=1 still forces closed for explicitness;
 * HIKMAH_PRIVATE=0 forces open.)
 */
export function privateDeployment() {
  if (/^(1|true|yes)$/i.test(process.env.HIKMAH_PUBLIC ?? '')) return false;
  if (/^(0|false|no)$/i.test(process.env.HIKMAH_PRIVATE ?? '')) return false;
  return true;
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

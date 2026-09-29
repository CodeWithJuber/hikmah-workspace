import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getStorage } from './storage.mjs';

export class SecretError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const validName = (name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name);
/** Every hosted preset in lib/ai/providers.ts, as a key destination. */
export const PROVIDER_DESTINATIONS = new Set(
  [
    'openrouter',
    'ollama-cloud',
    'openai',
    'anthropic',
    'moonshot',
    'google',
    'deepseek',
    'groq',
    'mistral',
    'xai',
    'experiential',
  ].map((id) => 'provider:' + id),
);
export function validateDestination(destination) {
  if (
    [
      'search:brave',
      'runtime',
      'runtime:env',
      // A credential an MCP server's config refers to as ${NAME}. One
      // destination rather than one per server, because the same token is often
      // the same token: keying it per server would make the owner save it twice
      // and then wonder which copy is live.
      'mcp-env',
    ].includes(destination)
  )
    return destination;
  // A key for a provider preset, by the preset's id. This file cannot import
  // the preset table (it runs at boot, before anything is compiled), so the
  // ids are listed here and tests/one-key-panel.test.mjs checks the list
  // against the table: when it held two names and nothing checked it, every
  // provider added since was refused with "The key could not be saved", and
  // the run went out keyless. The binding is unchanged — the id is part of the
  // ciphertext's associated data, so a key saved for one provider cannot be
  // spent on another.
  if (PROVIDER_DESTINATIONS.has(destination)) return destination;
  // A saved SSH credential belongs to one host row and nothing else. Binding it
  // to the host id means a key cannot be reused against a different machine by
  // editing the host after the fact.
  if (typeof destination === 'string' && /^ssh:[A-Za-z0-9_-]{1,64}$/.test(destination))
    return destination;
  // A key for an endpoint this deployment has no preset for. Without it the
  // only way to use a custom provider was a field that kept the key in browser
  // memory until the tab reloaded, which is not somewhere a credential belongs.
  // Bound to the origin, so a key saved for one host cannot be spent on another
  // by editing the endpoint afterwards.
  if (typeof destination === 'string' && destination.startsWith('provider:https://')) {
    try {
      const url = new URL(destination.slice('provider:'.length));
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
        throw Error();
      return 'provider:' + url.origin;
    } catch {
      throw new SecretError('A custom provider needs a plain HTTPS endpoint.');
    }
  }
  try {
    if (
      typeof destination !== 'string' ||
      !destination.startsWith('mcp:') ||
      destination.length > 1000
    )
      throw Error();
    const url = new URL(destination.slice(4));
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port && url.port !== '443')
    )
      throw Error();
    return 'mcp:' + url.href;
  } catch {
    throw new SecretError(
      'Choose a service, a saved SSH host or a public HTTPS MCP endpoint without credentials, query or fragment.',
    );
  }
}
function key() {
  // v10: no fallback to the auth secret — one secret must not serve both
  // session signing and credential encryption. Fail closed instead.
  // Upgrading from the old default? Set HIKMAH_VAULT_KEY to your existing
  // BETTER_AUTH_SECRET value: derived keys stay identical, sealed secrets
  // keep working.
  const master = process.env.HIKMAH_VAULT_KEY;
  if (!master || master.length < 32)
    throw new SecretError(
      'HIKMAH_VAULT_KEY is not set (or shorter than 32 characters). ' +
        'Generate one with `openssl rand -hex 32`. If you are upgrading and ' +
        'previously relied on the implicit default, set HIKMAH_VAULT_KEY to ' +
        'your existing BETTER_AUTH_SECRET value to keep already-sealed secrets readable.',
      503,
    );
  return Buffer.from(hkdfSync('sha256', master, 'hikmah-workspace-vault-v1', 'aes-256-gcm', 32));
}
const aad = (userId, name, destination) =>
  Buffer.from(JSON.stringify(['v1', userId, name, destination]));
export function createSecretStore(db = getStorage().DB) {
  const list = async (userId) => {
    const rows = await db
      .prepare(
        'SELECT name,destination,updated_at FROM workspace_secrets WHERE user_id = ? ORDER BY name',
      )
      .bind(userId)
      .all();
    return rows.results.map((r) => ({
      name: r.name,
      destination: r.destination,
      updatedAt: r.updated_at,
    }));
  };
  return {
    list,
    async save(userId, input) {
      if (!validName(input?.name))
        throw new SecretError(
          'Use an uppercase variable name, such as OPENROUTER_API_KEY (up to 64 characters).',
        );
      const destination = validateDestination(input.destination);
      const { name, value } = input;
      if (
        typeof value !== 'string' ||
        !value ||
        Buffer.byteLength(value) > 8192 ||
        value.includes('\0')
      )
        throw new SecretError('Enter a secret value up to 8 KB without null characters.');
      // A private key is a multi-line PEM, so line breaks are part of the value
      // rather than a sign of a pasted header. Everything else still rejects
      // them, because a line break in a bearer token is a smuggled header.
      const controlCharacters = destination.startsWith('ssh:')
        ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/;
      if (destination !== 'runtime:env' && controlCharacters.test(value))
        throw new SecretError(
          'Connection credentials cannot contain line breaks or control characters.',
        );
      if (
        destination === 'runtime:env' &&
        /^(PATH|HOME|USER|SHELL|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|LD_.*|DYLD_.*|DOCKER_.*)$/.test(
          name,
        )
      )
        throw new SecretError('This environment name is reserved by the runtime.');
      const entries = await list(userId);
      if (entries.length >= 100 && !entries.some((r) => r.name === name))
        throw new SecretError('This workspace supports up to 100 secret variables.');
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key(), nonce);
      cipher.setAAD(aad(userId, name, destination));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const sealed = [
        'v1',
        nonce.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      ].join('.');
      await db
        .prepare(
          'INSERT INTO workspace_secrets (user_id,name,destination,sealed,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET destination=excluded.destination,sealed=excluded.sealed,updated_at=excluded.updated_at',
        )
        .bind(userId, name, destination, sealed, new Date().toISOString())
        .run();
    },
    async remove(userId, name) {
      if (!validName(name)) throw new SecretError('Invalid secret variable name.');
      await db
        .prepare('DELETE FROM workspace_secrets WHERE user_id = ? AND name = ?')
        .bind(userId, name)
        .run();
    },
    async resolve(userId, name, destination, optional = false) {
      if (!validName(name)) throw new SecretError('Invalid secret reference.');
      const row = await db
        .prepare('SELECT destination,sealed FROM workspace_secrets WHERE user_id = ? AND name = ?')
        .bind(userId, name)
        .first();
      if (!row && optional) return '';
      if (!row || row.destination !== destination)
        throw new SecretError(
          'Saved secret is missing or is assigned to a different service. Check Settings → Secrets.',
          409,
        );
      try {
        const [version, iv, tag, data] = row.sealed.split('.');
        if (version !== 'v1') throw Error();
        const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'), {
          authTagLength: 16,
        });
        decipher.setAAD(aad(userId, name, destination));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(data, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new SecretError(
          'Saved secret cannot be decrypted. Restore the vault encryption key or replace this variable.',
          503,
        );
      }
    },
  };
}

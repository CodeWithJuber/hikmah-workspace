import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Run snapshots use the vault's stable master, with a separate derived key.
 * A paused run must keep the exact credential it started with even if a vault
 * variable is later rotated; resolving a live reference would change that. */
function key() {
  const master = process.env.HIKMAH_VAULT_KEY || process.env.BETTER_AUTH_SECRET;
  if (!master || master.length < 32)
    throw Error(
      'Run encryption is unavailable. Restore a stable vault key or authentication secret of at least 32 characters.',
    );
  return Buffer.from(hkdfSync('sha256', master, 'hikmah-run-credential-v1', 'aes-256-gcm', 32));
}

function configObject(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw Error('The stored run configuration could not be read.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('The stored run configuration could not be read.');
  return { ...parsed };
}

const aad = (run, config) =>
  Buffer.from(
    JSON.stringify(['hikmah.run.credential.v1', run.id, run.user_id, String(config.baseUrl ?? '')]),
  );

/** New persistence boundary: no raw key is returned and caller-supplied
 * ciphertext is discarded. Associated data prevents moving a credential to
 * another run, owner or provider endpoint. */
export function sealRunConfig(value, run) {
  const config = configObject(value);
  const raw = config.apiKey;
  delete config.apiKey;
  delete config.providerCredential;
  if (raw === undefined || raw === '') return config;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8192 || /[\u0000-\u001f\u007f]/.test(raw))
    throw Error('The provider credential is invalid. Replace it in connection settings.');
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(aad(run, config));
  const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  config.providerCredential = [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
  return config;
}

/** Decrypt only for an executing request or its immediate redaction hook.
 * Stored configurations and database/API reads remain ciphertext-only. */
export function executionRunConfig(run) {
  const config = configObject(run.config);
  if (typeof config.apiKey === 'string' && config.apiKey)
    throw Error(
      'This run needs the credential storage upgrade. Restart the server before resuming it.',
    );
  delete config.apiKey;
  const sealed = config.providerCredential;
  delete config.providerCredential;
  if (sealed === undefined) return { ...config, apiKey: '' };
  try {
    if (typeof sealed !== 'string' || sealed.length > 12_000) throw Error();
    const pieces = sealed.split('.');
    if (
      pieces.length !== 4 ||
      pieces[0] !== 'v1' ||
      pieces.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw Error();
    const nonce = Buffer.from(pieces[1], 'base64url'),
      tag = Buffer.from(pieces[2], 'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', key(), nonce, { authTagLength: 16 });
    decipher.setAAD(aad(run, config));
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([
      decipher.update(Buffer.from(pieces[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return { ...config, apiKey: raw };
  } catch {
    throw Error(
      'The run credential cannot be decrypted. Restore the original vault key or start a new run after reconnecting the provider.',
    );
  }
}

/** Startup data migration, after SQL migrations and before the worker starts.
 * It is atomic and idempotent; a missing encryption key fails closed without
 * discarding a paused run's only usable credential. */
export function migrateRunCredentials(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").all().length)
    return 0;
  db.exec('PRAGMA secure_delete=ON');
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (;;) {
      const rows = db
        .prepare(
          `SELECT id,user_id,status,config FROM runs WHERE json_valid(config) AND (
        json_type(config,'$.apiKey') IS NOT NULL OR
        (status IN ('done','failed','cancelled') AND json_type(config,'$.providerCredential') IS NOT NULL)
      ) LIMIT 100`,
        )
        .all();
      if (!rows.length) break;
      for (const row of rows) {
        const original = configObject(row.config);
        let next;
        if (['done', 'failed', 'cancelled'].includes(row.status)) {
          next = original;
          delete next.apiKey;
          delete next.providerCredential;
        } else if (typeof original.apiKey === 'string' && original.apiKey)
          next = sealRunConfig(original, row);
        else {
          // Preserve an existing encrypted snapshot if a legacy row also has
          // an empty apiKey field; there is no plaintext credential to replace.
          next = original;
          delete next.apiKey;
        }
        db.prepare('UPDATE runs SET config = ? WHERE id = ?').run(JSON.stringify(next), row.id);
        changed++;
      }
    }
    if (changed)
      // Persist this in the same transaction as the rewrites. Encryption can
      // succeed while an older reader still pins plaintext pages in the WAL.
      // Storage startup must retry truncation even when there are no raw keys
      // left to migrate after a restart.
      db.exec(
        `CREATE TABLE IF NOT EXISTS hikmah_storage_maintenance (task TEXT PRIMARY KEY);
         INSERT OR IGNORE INTO hikmah_storage_maintenance VALUES ('credential-scrub')`,
      );
    db.exec('COMMIT');
    return changed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

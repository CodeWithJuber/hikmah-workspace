/** Saved SSH hosts.
 *
 * The whole point of a host row is that the model never gets to choose where a
 * connection goes. It may name a host id and a command; the hostname, port,
 * username and credential come from here. An instruction injected through a
 * fetched page or an MCP tool description can therefore name a host the owner
 * already trusts, but cannot invent a new one.
 */
import type { SqliteHandle } from '../runs/store.ts';

export type AuthKind = 'key' | 'password';

export type SshHostRow = {
  id: string;
  user_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_kind: AuthKind;
  fingerprint: string | null;
  auto_approve: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

export class SshHostError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SshHostError';
    this.status = status;
  }
}

/** The secret store destination that pins a credential to one host. */
export const credentialDestination = (hostId: string) => `ssh:${hostId}`;

/** A hostname or literal IP address: no scheme, port, path or credentials. */
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function validHost(value: string): boolean {
  if (IPV4.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  // An IPv6 literal is accepted only in its bracketed form, so it cannot be
  // confused with a host:port string.
  if (value.startsWith('[') && value.endsWith(']'))
    return /^[0-9A-Fa-f:.]+$/.test(value.slice(1, -1));
  return HOSTNAME.test(value);
}

export type HostInput = {
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  autoApprove: string[];
};

/**
 * Validate what the owner typed.
 *
 * Everything here is rejected rather than repaired: a hostname with a stray
 * character is a typo worth showing, and quietly fixing one is how a connection
 * ends up somewhere nobody intended.
 */
export function parseHostInput(raw: unknown): HostInput {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (field: string, max: number): string => {
    const found = value[field];
    if (typeof found !== 'string' || !found.trim() || found.length > max)
      throw new SshHostError(`Enter a ${field}.`);
    return found.trim();
  };

  const name = text('name', 64);
  const host = text('host', 253);
  if (!validHost(host))
    throw new SshHostError('Enter a hostname or IP address on its own, without a scheme or port.');

  // OpenSSH usernames: no spaces, no shell metacharacters, and no leading dash,
  // which ssh would read as an option.
  const username = text('username', 64);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(username))
    throw new SshHostError('Enter a plain SSH username.');

  const port = value.port === undefined || value.port === '' ? 22 : Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new SshHostError('Enter a port between 1 and 65535.');

  const authKind = value.authKind;
  if (authKind !== 'key' && authKind !== 'password')
    throw new SshHostError('Choose a private key or a password.');

  const autoApprove = value.autoApprove;
  if (autoApprove !== undefined && !Array.isArray(autoApprove))
    throw new SshHostError('Auto-approved commands must be a list.');
  const patterns = (autoApprove ?? []).map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 200)
      throw new SshHostError('Each auto-approved command must be a short pattern.');
    return entry.trim();
  });

  return { name, host, port, username, authKind, autoApprove: patterns };
}

export function createHostStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const columns =
    'id, user_id, name, host, port, username, auth_kind, fingerprint, auto_approve, created_at, updated_at, last_used_at';
  const statements = {
    list: db.prepare(`SELECT ${columns} FROM ssh_hosts WHERE user_id = ? ORDER BY name`),
    get: db.prepare(`SELECT ${columns} FROM ssh_hosts WHERE id = ? AND user_id = ?`),
    insert: db.prepare(
      `INSERT INTO ssh_hosts (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    ),
    pin: db.prepare(
      'UPDATE ssh_hosts SET fingerprint = ?, updated_at = ? WHERE id = ? AND user_id = ? AND fingerprint IS NULL',
    ),
    used: db.prepare('UPDATE ssh_hosts SET last_used_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM ssh_hosts WHERE id = ? AND user_id = ?'),
  };

  const store = {
    list: (userId: string) => statements.list.all(userId) as SshHostRow[],
    get(id: string, userId: string): SshHostRow | undefined {
      return (statements.get.get(id, userId) as SshHostRow | undefined) ?? undefined;
    },
    create(id: string, userId: string, input: HostInput): SshHostRow {
      const stamp = now();
      try {
        statements.insert.run(
          id,
          userId,
          input.name,
          input.host,
          input.port,
          input.username,
          input.authKind,
          input.autoApprove.length ? JSON.stringify(input.autoApprove) : null,
          stamp,
          stamp,
        );
      } catch (error) {
        if (String(error).includes('UNIQUE'))
          throw new SshHostError('A host with that name already exists.', 409);
        throw error;
      }
      return store.get(id, userId)!;
    },
    /**
     * Record the fingerprint seen on the first connection.
     *
     * Only ever fills a blank. Overwriting one would turn the pin into a
     * suggestion, which is the failure it exists to prevent: rotating a host key
     * means removing the host and adding it again, deliberately.
     */
    pinFingerprint(id: string, userId: string, fingerprint: string): boolean {
      const result = statements.pin.run(fingerprint, now(), id, userId) as { changes?: number };
      return Number(result?.changes ?? 0) > 0;
    },
    markUsed: (id: string) => statements.used.run(now(), id),
    remove: (id: string, userId: string) => statements.remove.run(id, userId),
  };
  return store;
}

/** Characters that turn one command into several, or redirect its output. */
const SEPARATORS = /[;&|`$><\n\r\\]/;

/**
 * May this command run without asking?
 *
 * A pattern matches the whole command, anchored, with `*` standing for a run of
 * ordinary characters. Prefix matching would let `df; rm -rf /` through on a
 * pattern of `df`, so a command containing a separator is never auto-approved
 * whatever the patterns say, and `*` never matches one either.
 */
export function isAutoApproved(command: string, patterns: string[] | null | undefined): boolean {
  if (!patterns?.length) return false;
  const trimmed = command.trim();
  if (!trimmed || SEPARATORS.test(trimmed)) return false;
  return patterns.some((pattern) => {
    const wildcard = '[^;&|`$><\\n\\r\\\\]*';
    const source = pattern
      .trim()
      .split('*')
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join(wildcard);
    return new RegExp(`^${source}$`).test(trimmed);
  });
}

export function parseAutoApprove(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

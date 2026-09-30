/** Connector manifest schema and validation (PR-26: curated catalog).
 *
 * A manifest is the signed claim a connector makes about itself: what it is,
 * what version it is, and what it wants permission to touch. Validation is
 * strict and total — a manifest that fails is refused with named errors, and
 * the route layer never persists an unvalidated manifest.
 *
 * Permission vocabulary: deliberately NOT lib/authz's Permission type. That
 * vocabulary names who may operate the deployment (users:manage,
 * billing:override, ...); a connector manifest needs capability grants — what
 * the connector may touch on the user's behalf (notes:read, files:read,
 * ...). Same `resource:verb` shape, different domain; reusing the operator
 * vocabulary would let a manifest request billing:override-shaped powers
 * (JEV decision, 2026-09-30: catalog-vocabulary, confidence 1.00).
 *
 * Pure over its inputs and importing nothing from Next, so tests drive it
 * directly — the same reason lib/authz/roles.ts is pure.
 */

/** The capabilities a connector may request, in `resource:verb` shape.
 *
 * The vocabulary is closed: `validateManifest` refuses any permission not on
 * this list, so adding a capability is a conscious, reviewed change — not a
 * string a manifest author invents.
 */
export const CATALOG_PERMISSIONS = [
  /** Read the user's workspace notes (search, list, snippets). */
  'notes:read',
  /** Create or edit the user's workspace notes. */
  'notes:write',
  /** Read files inside an explicitly allowed directory. */
  'files:read',
  /** Write files inside an explicitly allowed directory. */
  'files:write',
  /** Pure computation with no I/O (arithmetic, conversions). */
  'calc:compute',
  /** Read the clock / convert between timezones. No network. */
  'time:read',
  /** Outbound HTTPS fetch to a declared host. */
  'net:fetch',
  /** Read knowledge-base entries. */
  'kb:read',
] as const;

export type CatalogPermission = (typeof CATALOG_PERMISSIONS)[number];

/** Whether the string is a permission this catalog recognises. Unknown
 * permissions fail closed: the manifest is refused, not trimmed. */
export function isCatalogPermission(value: unknown): value is CatalogPermission {
  return typeof value === 'string' && (CATALOG_PERMISSIONS as readonly string[]).includes(value);
}

/** The unsigned claim a connector makes about itself. `signature` and
 * `signer` live on the stored row, not here — see lib/catalog/signing.ts. */
export interface ConnectorManifest {
  /** URL-safe slug, e.g. `notes-search`. Also the registry key. */
  name: string;
  /** Strict semver, e.g. `1.2.0`. */
  version: string;
  /** One or two honest sentences about what the connector does. */
  description: string;
  /** Capabilities requested, from the closed vocabulary above. */
  permissions: CatalogPermission[];
  /** Registry key of the implementation (curated connectors only). */
  entrypoint: string;
  /** Optional project page. */
  homepage?: string;
}

export type ManifestErrorCode =
  | 'not-an-object'
  | 'missing-field'
  | 'bad-type'
  | 'bad-name'
  | 'bad-semver'
  | 'unknown-permission'
  | 'duplicate-permission'
  | 'bad-entrypoint'
  | 'bad-homepage'
  | 'description-too-long';

export interface ManifestError {
  code: ManifestErrorCode;
  field: string;
  message: string;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Strict semver 2.0: no leading zeros, no `v` prefix. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MAX_DESCRIPTION = 500;

function err(code: ManifestErrorCode, field: string, message: string): ManifestError {
  return { code, field, message };
}

/** Validate an unknown value as a connector manifest. Returns the manifest on
 * success; on failure a list of named errors — every problem is reported, not
 * just the first, so a manifest author can fix the whole submission at once. */
export function validateManifest(
  value: unknown,
): { ok: true; manifest: ConnectorManifest } | { ok: false; errors: ManifestError[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, errors: [err('not-an-object', '', 'A manifest must be a JSON object.')] };
  const input = value as Record<string, unknown>;
  const errors: ManifestError[] = [];

  const need = (field: string): boolean => {
    if (!(field in input) || input[field] === undefined || input[field] === null) {
      errors.push(err('missing-field', field, `The manifest is missing its ${field}.`));
      return false;
    }
    return true;
  };

  let name = '';
  if (need('name')) {
    if (typeof input.name !== 'string')
      errors.push(err('bad-type', 'name', 'The name must be a string.'));
    else if (!NAME_RE.test(input.name))
      errors.push(
        err('bad-name', 'name', 'The name must be a lowercase slug: letters, digits and dashes.'),
      );
    else name = input.name;
  }

  let version = '';
  if (need('version')) {
    if (typeof input.version !== 'string')
      errors.push(err('bad-type', 'version', 'The version must be a string.'));
    else if (!SEMVER_RE.test(input.version))
      errors.push(
        err(
          'bad-semver',
          'version',
          'The version must be strict semver, e.g. 1.2.0 — no v prefix, no leading zeros.',
        ),
      );
    else version = input.version;
  }

  let description = '';
  if (need('description')) {
    if (typeof input.description !== 'string')
      errors.push(err('bad-type', 'description', 'The description must be a string.'));
    else if (input.description.trim().length === 0)
      errors.push(err('bad-type', 'description', 'The description must not be empty.'));
    else if (input.description.length > MAX_DESCRIPTION)
      errors.push(
        err(
          'description-too-long',
          'description',
          `The description must be ${MAX_DESCRIPTION} characters or fewer.`,
        ),
      );
    else description = input.description;
  }

  const permissions: CatalogPermission[] = [];
  if (need('permissions')) {
    if (!Array.isArray(input.permissions))
      errors.push(
        err(
          'bad-type',
          'permissions',
          'The permissions must be an array of resource:verb strings.',
        ),
      );
    else {
      const seen = new Set<string>();
      for (const permission of input.permissions) {
        if (!isCatalogPermission(permission)) {
          errors.push(
            err(
              'unknown-permission',
              'permissions',
              `Unknown permission ${JSON.stringify(permission)}: a manifest may only request the catalog's published vocabulary.`,
            ),
          );
        } else if (seen.has(permission)) {
          errors.push(
            err('duplicate-permission', 'permissions', `Duplicate permission ${permission}.`),
          );
        } else {
          seen.add(permission);
          permissions.push(permission);
        }
      }
    }
  }

  let entrypoint = '';
  if (need('entrypoint')) {
    if (typeof input.entrypoint !== 'string')
      errors.push(err('bad-type', 'entrypoint', 'The entrypoint must be a string.'));
    else if (!NAME_RE.test(input.entrypoint))
      errors.push(
        err(
          'bad-entrypoint',
          'entrypoint',
          'The entrypoint must be a registry key: a lowercase slug matching a curated connector.',
        ),
      );
    else entrypoint = input.entrypoint;
  }

  let homepage: string | undefined;
  if (input.homepage !== undefined && input.homepage !== null) {
    if (typeof input.homepage !== 'string')
      errors.push(err('bad-type', 'homepage', 'The homepage must be a string.'));
    else {
      try {
        const url = new URL(input.homepage);
        if (url.protocol !== 'https:')
          errors.push(err('bad-homepage', 'homepage', 'The homepage must be an https: URL.'));
        else homepage = input.homepage;
      } catch {
        errors.push(err('bad-homepage', 'homepage', 'The homepage must be a valid URL.'));
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: homepage
      ? { name, version, description, permissions, entrypoint, homepage }
      : { name, version, description, permissions, entrypoint },
  };
}

/** Compare two validated semver strings: -1, 0, 1. Build metadata is ignored
 * per semver 2.0 §10; a prerelease sorts below its release. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (version: string) => {
    const match = SEMVER_RE.exec(version);
    if (!match) throw new Error(`Not semver: ${version}`);
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] ? match[4].split('.') : null,
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
  }
  if (x.prerelease === null && y.prerelease === null) return 0;
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;
  const len = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < len; i++) {
    const xp = x.prerelease[i];
    const yp = y.prerelease[i];
    if (xp === undefined) return -1;
    if (yp === undefined) return 1;
    if (xp === yp) continue;
    const xn = /^\d+$/.test(xp) ? Number(xp) : null;
    const yn = /^\d+$/.test(yp) ? Number(yp) : null;
    if (xn !== null && yn !== null) return xn < yn ? -1 : 1;
    if (xn !== null) return -1;
    if (yn !== null) return 1;
    return xp < yp ? -1 : 1;
  }
  return 0;
}

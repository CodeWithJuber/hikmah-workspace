/** SQLite store for the connector catalog (PR-26).
 *
 * Thin over the raw DatabaseSync from getStorage(), following the
 * createMcpStore pattern: the route builds the store per request, the store
 * owns the SQL, and every refusal carries a code the route can map to an
 * honest status.
 *
 * Refusals are errors with `code`, never silent: installing a revoked
 * connector, granting a permission the manifest never requested, or an
 * update that widens permissions without re-grant all throw
 * CatalogStoreError. Revocation deactivates; it never deletes — there is no
 * delete path in this module at all.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  compareVersions,
  isCatalogPermission,
  validateManifest,
  type CatalogPermission,
  type ConnectorManifest,
} from './manifest.ts';
import {
  applyRevoke,
  checkUpdate,
  mayInstall,
  type ManifestStatus,
  type StoredManifest,
} from './updates.ts';
import { verifyManifest } from './signing.ts';

export class CatalogStoreError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'CatalogStoreError';
    this.code = code;
    this.detail = detail;
  }
}

export interface InstallRecord {
  userId: string;
  manifestId: string;
  grantedPermissions: CatalogPermission[];
  installedAt: string;
  updatedAt: string;
}

export interface InstallWithManifest extends InstallRecord {
  manifest: StoredManifest;
}

export interface UpdateInfo {
  name: string;
  installedVersion: string;
  installedManifestId: string;
  latestVersion: string;
  latestManifestId: string;
  permissionsAdded: CatalogPermission[];
  needsRegrant: boolean;
}

const now = () => new Date().toISOString();

function rowToStored(row: Record<string, string>): StoredManifest {
  let manifest: ConnectorManifest;
  try {
    const parsed: unknown = JSON.parse(row.manifest_json);
    const validated = validateManifest(parsed);
    if (!validated.ok) throw new Error('invalid');
    manifest = validated.manifest;
  } catch {
    throw new CatalogStoreError(
      'corrupt-manifest',
      `The stored manifest ${row.id} failed validation.`,
    );
  }
  if (!verifyManifest(manifest, row.signature, row.signer))
    throw new CatalogStoreError(
      'bad-signature',
      `The stored manifest ${row.id} does not verify against its signer.`,
    );
  return {
    id: row.id,
    manifest,
    signature: row.signature,
    signer: row.signer,
    status: row.status as ManifestStatus,
  };
}

export function createCatalogStore(db: DatabaseSync) {
  const getRow = (id: string): StoredManifest | null => {
    const row = db.prepare('SELECT * FROM connector_manifests WHERE id = ?').get(id) as
      Record<string, string> | undefined;
    return row ? rowToStored(row) : null;
  };

  const latestActive = (name: string): StoredManifest | null => {
    const rows = (
      db
        .prepare(
          "SELECT * FROM connector_manifests WHERE name = ? AND status IN ('active','deprecated')",
        )
        .all(name) as Record<string, string>[]
    ).map(rowToStored);
    rows.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    return rows[0] ?? null;
  };

  return {
    /** Every installable manifest: the latest active/deprecated version per
     * name. Revoked manifests are never listed here. */
    listActive(): StoredManifest[] {
      const names = (
        db.prepare('SELECT DISTINCT name FROM connector_manifests').all() as { name: string }[]
      ).map((r) => r.name);
      const out: StoredManifest[] = [];
      for (const name of names) {
        const row = latestActive(name);
        if (row) out.push(row);
      }
      out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
      return out;
    },

    get(name: string, version?: string): StoredManifest | null {
      if (version) return getRow(`${name}@${version}`);
      return latestActive(name);
    },

    versions(name: string): StoredManifest[] {
      const rows = (
        db.prepare('SELECT * FROM connector_manifests WHERE name = ?').all(name) as Record<
          string,
          string
        >[]
      ).map(rowToStored);
      rows.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
      return rows;
    },

    /** Record an install. The granted permissions must be a subset of what
     * the manifest requests — the user explicitly grants, and granting more
     * than the manifest asked for is refused. */
    install(userId: string, manifestId: string, grantedPermissions: string[]): InstallRecord {
      const row = getRow(manifestId);
      if (!row)
        throw new CatalogStoreError(
          'unknown-manifest',
          'That connector version is not in the catalog.',
        );
      const gate = mayInstall(row);
      if (!gate.ok)
        throw new CatalogStoreError(
          'manifest-revoked',
          'This connector version was revoked: new installs are refused.',
        );
      const requested = new Set<string>(row.manifest.permissions);
      for (const permission of grantedPermissions) {
        if (!isCatalogPermission(permission))
          throw new CatalogStoreError(
            'unknown-permission',
            `Unknown permission ${JSON.stringify(permission)}.`,
          );
        if (!requested.has(permission))
          throw new CatalogStoreError(
            'permission-not-requested',
            `The manifest never requested ${permission}: a grant cannot exceed what the connector asked for.`,
          );
      }
      const granted = [...new Set(grantedPermissions)] as CatalogPermission[];
      const timestamp = now();
      db.prepare(
        `INSERT INTO connector_installs (user_id, manifest_id, granted_permissions, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, manifest_id) DO UPDATE SET granted_permissions = excluded.granted_permissions, updated_at = excluded.updated_at`,
      ).run(userId, manifestId, JSON.stringify(granted), timestamp, timestamp);
      return {
        userId,
        manifestId,
        grantedPermissions: granted,
        installedAt: timestamp,
        updatedAt: timestamp,
      };
    },

    getInstall(userId: string, manifestId: string): InstallWithManifest | null {
      const row = db
        .prepare('SELECT * FROM connector_installs WHERE user_id = ? AND manifest_id = ?')
        .get(userId, manifestId) as Record<string, string> | undefined;
      if (!row) return null;
      const manifest = getRow(row.manifest_id);
      if (!manifest) return null;
      return {
        userId: row.user_id,
        manifestId: row.manifest_id,
        grantedPermissions: JSON.parse(row.granted_permissions) as CatalogPermission[],
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        manifest,
      };
    },

    installsFor(userId: string): InstallWithManifest[] {
      const rows = db
        .prepare('SELECT * FROM connector_installs WHERE user_id = ?')
        .all(userId) as Record<string, string>[];
      const out: InstallWithManifest[] = [];
      for (const row of rows) {
        const manifest = getRow(row.manifest_id);
        if (!manifest) continue;
        out.push({
          userId: row.user_id,
          manifestId: row.manifest_id,
          grantedPermissions: JSON.parse(row.granted_permissions) as CatalogPermission[],
          installedAt: row.installed_at,
          updatedAt: row.updated_at,
          manifest,
        });
      }
      return out;
    },

    /** For each install, the newest installable version of the same
     * connector, with the permission delta so the UI can demand re-grant
     * before a widening update. */
    updateCheck(userId: string): UpdateInfo[] {
      const out: UpdateInfo[] = [];
      for (const install of this.installsFor(userId)) {
        const latest = latestActive(install.manifest.manifest.name);
        if (!latest || latest.id === install.manifestId) continue;
        if (compareVersions(latest.manifest.version, install.manifest.manifest.version) <= 0)
          continue;
        const before = new Set(install.manifest.manifest.permissions);
        const added = latest.manifest.permissions.filter((p) => !before.has(p));
        out.push({
          name: latest.manifest.name,
          installedVersion: install.manifest.manifest.version,
          installedManifestId: install.manifestId,
          latestVersion: latest.manifest.version,
          latestManifestId: latest.id,
          permissionsAdded: added,
          needsRegrant: added.length > 0,
        });
      }
      return out;
    },

    /** Move an install to a newer version. Applies the update policy:
     * same key, version increase, and no silent permission widening — a
     * widening update needs the new permissions in `grantedPermissions`,
     * explicitly re-granted. */
    updateToVersion(
      userId: string,
      manifestId: string,
      grantedPermissions: string[],
    ): InstallRecord {
      const candidate = getRow(manifestId);
      if (!candidate)
        throw new CatalogStoreError(
          'unknown-manifest',
          'That connector version is not in the catalog.',
        );
      const gate = mayInstall(candidate);
      if (!gate.ok)
        throw new CatalogStoreError(
          'manifest-revoked',
          'This connector version was revoked: new installs are refused.',
        );
      const current = this.installsFor(userId).find(
        (i) => i.manifest.manifest.name === candidate.manifest.name,
      );
      if (!current)
        throw new CatalogStoreError('not-installed', 'Install the connector before updating it.');
      const check = checkUpdate(
        current.manifest,
        candidate.manifest,
        candidate.signature,
        candidate.signer,
      );
      if (!check.ok && check.code === 'permissions-widened') {
        const granted = new Set(grantedPermissions);
        const missing = (check.permissionsAdded ?? []).filter((p) => !granted.has(p));
        if (missing.length)
          throw new CatalogStoreError(
            'regrant-required',
            `Version ${candidate.manifest.version} requests new permissions (${missing.join(', ')}): grant them explicitly to update.`,
            { permissionsAdded: check.permissionsAdded },
          );
      } else if (!check.ok) {
        throw new CatalogStoreError(check.code, check.message);
      }
      // Replace the install row: one installed version per connector per user.
      db.prepare('DELETE FROM connector_installs WHERE user_id = ? AND manifest_id = ?').run(
        userId,
        current.manifestId,
      );
      return this.install(userId, manifestId, grantedPermissions);
    },

    /** Revoke a manifest version. Deactivates only: the row, its signature
     * and every install stay. Existing installs keep working; new installs
     * are refused by install(). */
    revoke(manifestId: string): StoredManifest {
      const row = getRow(manifestId);
      if (!row)
        throw new CatalogStoreError(
          'unknown-manifest',
          'That connector version is not in the catalog.',
        );
      const revoked = applyRevoke(row);
      db.prepare('UPDATE connector_manifests SET status = ?, updated_at = ? WHERE id = ?').run(
        revoked.status,
        now(),
        manifestId,
      );
      const stored = getRow(manifestId);
      if (!stored)
        throw new CatalogStoreError(
          'unknown-manifest',
          'That connector version is not in the catalog.',
        );
      return stored;
    },
  };
}

export type CatalogStore = ReturnType<typeof createCatalogStore>;

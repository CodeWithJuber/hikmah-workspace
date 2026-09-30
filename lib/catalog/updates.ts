/** Update and revocation policy (PR-26: curated catalog).
 *
 * The policy is pure: it decides, the store applies. Three invariants:
 *
 * 1. Same key — a new version must be signed by the SAME key that signed the
 *    version it replaces. A key change is a new connector, not an update.
 * 2. Version increase — the candidate version must be strictly newer semver.
 * 3. No silent permission widening — if the new version requests permissions
 *    the installed version did not, the update is refused until the user
 *    re-grants explicitly. Narrowing or unchanged permissions update freely.
 *
 * Revocation never deletes: it flips the manifest row to `revoked`. Existing
 * installs keep working (the code they run is unchanged), new installs are
 * refused, and the UI shows the revoked state honestly.
 *
 * Pure over its inputs and importing nothing from Next, so tests drive it
 * directly.
 */
import { compareVersions, type CatalogPermission, type ConnectorManifest } from './manifest.ts';
import { verifyManifest } from './signing.ts';

export type ManifestStatus = 'active' | 'deprecated' | 'revoked';

/** What the store persists per manifest version. */
export interface StoredManifest {
  id: string;
  manifest: ConnectorManifest;
  signature: string;
  signer: string;
  status: ManifestStatus;
}

export type UpdateCheck =
  | { ok: true; permissionsAdded: CatalogPermission[]; permissionsRemoved: CatalogPermission[] }
  | {
      ok: false;
      code:
        | 'bad-signature'
        | 'signer-changed'
        | 'version-not-increased'
        | 'manifest-revoked'
        | 'name-mismatch'
        | 'permissions-widened';
      message: string;
      permissionsAdded?: CatalogPermission[];
    };

type UpdateFailure = Extract<UpdateCheck, { ok: false }>;

const fail = (
  code: UpdateFailure['code'],
  message: string,
  permissionsAdded?: CatalogPermission[],
): UpdateCheck => ({ ok: false, code, message, permissionsAdded });

/** Whether a manifest row may be freshly installed. Revoked never; deprecated
 * still installs but the caller should show the deprecation notice. */
export function mayInstall(row: Pick<StoredManifest, 'status'>): { ok: boolean; notice?: string } {
  if (row.status === 'revoked') return { ok: false };
  if (row.status === 'deprecated')
    return {
      ok: true,
      notice: 'This version is deprecated: it still works, but a newer one is recommended.',
    };
  return { ok: true };
}

/** The update policy: decide whether `candidate` may replace `current`.
 *
 * `candidateSignature`/`candidateSigner` are the candidate's own signature
 * and signer key; the signature is verified against `current.signer` — the
 * key the catalog already trusts for this connector — which enforces the
 * same-key rule without a key directory.
 */
export function checkUpdate(
  current: StoredManifest,
  candidate: ConnectorManifest,
  candidateSignature: string,
  candidateSigner: string,
): UpdateCheck {
  if (candidate.name !== current.manifest.name)
    return fail('name-mismatch', 'An update must carry the same connector name.');
  if (current.status === 'revoked')
    return fail('manifest-revoked', 'This version was revoked: updates from it are refused.');
  if (candidateSigner !== current.signer)
    return fail(
      'signer-changed',
      'The update is signed by a different key than the installed version. A key change is a new connector, not an update.',
    );
  if (!verifyManifest(candidate, candidateSignature, current.signer))
    return fail(
      'bad-signature',
      'The update signature does not verify against the installed signing key.',
    );
  if (compareVersions(candidate.version, current.manifest.version) <= 0)
    return fail(
      'version-not-increased',
      `Version ${candidate.version} is not newer than installed ${current.manifest.version}.`,
    );
  const before = new Set(current.manifest.permissions);
  const after = new Set(candidate.permissions);
  const permissionsAdded = candidate.permissions.filter((p) => !before.has(p));
  const permissionsRemoved = current.manifest.permissions.filter((p) => !after.has(p));
  if (permissionsAdded.length)
    return fail(
      'permissions-widened',
      `Version ${candidate.version} requests new permissions (${permissionsAdded.join(', ')}). Re-grant explicitly to update.`,
      permissionsAdded,
    );
  return { ok: true, permissionsAdded: [], permissionsRemoved };
}

/** Revocation: mark the row revoked. Nothing is deleted — the manifest row,
 * its signature, and every install stay, so the audit trail and the
 * "existing installs keep working" guarantee both hold. */
export function applyRevoke(row: StoredManifest): StoredManifest {
  return { ...row, status: 'revoked' };
}

/** Whether an installed connector may still run: revocation stops new
 * installs, not existing ones. */
export function mayRunInstall(row: Pick<StoredManifest, 'status'>): boolean {
  return row.status === 'active' || row.status === 'deprecated' || row.status === 'revoked';
}

/** Shared connector surface (PR-26: curated catalog).
 *
 * A connector is a pure-ish module: `run` takes a JSON input and a context and
 * returns a JSON result. It never touches the network or the process
 * environment on its own — everything it may use (which notes directory,
 * which file directory, which permissions the install granted) arrives in
 * `ConnectorContext`, which the run route builds per install.
 *
 * Execution model (JEV decision, 2026-09-30: curated-registry-only,
 * confidence 0.91): v1 executes only the curated connectors shipped in this
 * repo, resolved through the static registry in lib/catalog/registry.ts. A
 * signed manifest for a third-party connector verifies and installs like any
 * other, but there is no code path that executes it — loading arbitrary
 * signed code without a sandbox is a remote-code-execution primitive, and the
 * sandbox is marketplace-phase work, honestly out of scope here.
 */
import type { CatalogPermission } from './manifest.ts';

/** What the run route hands a connector. The connector declares
 * `requiredPermissions`; the route refuses the run unless the install
 * granted every one of them. */
export interface ConnectorContext {
  /** Permissions the user's install granted to this connector. */
  grantedPermissions: CatalogPermission[];
  /** Directory notes-search reads. Scoped by the deployment, not the caller. */
  notesDir: string;
  /** Directory local-file-reader may read inside. Nothing outside. */
  allowedDir: string;
}

export type ConnectorResult =
  { ok: true; data: unknown } | { ok: false; code: string; error: string };

export interface ConnectorDefinition {
  /** Registry key; must equal the manifest's entrypoint. */
  name: string;
  /** Permissions the connector needs. The run route enforces these against
   * the install's granted permissions before calling run. */
  requiredPermissions: CatalogPermission[];
  run(input: unknown, ctx: ConnectorContext): ConnectorResult | Promise<ConnectorResult>;
}

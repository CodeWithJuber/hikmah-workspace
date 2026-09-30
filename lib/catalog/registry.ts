/** The curated connector registry (PR-26).
 *
 * The static map from a manifest's `entrypoint` to the reviewed
 * implementation shipped in this repo. Static on purpose: there is no code
 * path that resolves an entrypoint to an arbitrary module, URL or file, so a
 * signed manifest can never smuggle in unreviewed code. Third-party manifests
 * verify and install like any other, but nothing here will execute them —
 * that is the honest boundary between a curated catalog and a marketplace
 * (JEV decision, 2026-09-30: curated-registry-only, confidence 0.91).
 */
import type { ConnectorDefinition } from './connector.ts';
import { definition as calculator } from '../../connectors/calculator/index.ts';
import { definition as notesSearch } from '../../connectors/notes-search/index.ts';
import { definition as timezoneConverter } from '../../connectors/timezone-converter/index.ts';
import { definition as localFileReader } from '../../connectors/local-file-reader/index.ts';

const ENTRIES: ConnectorDefinition[] = [
  calculator,
  notesSearch,
  timezoneConverter,
  localFileReader,
];

const REGISTRY: Record<string, ConnectorDefinition> = Object.fromEntries(
  ENTRIES.map((entry) => [entry.name, entry]),
);

/** The curated implementation for an entrypoint, or null when the catalog
 * has no reviewed code for it. A manifest whose entrypoint is not here can
 * be listed, installed and revoked — it just cannot run. */
export function connectorFor(entrypoint: string): ConnectorDefinition | null {
  return REGISTRY[entrypoint] ?? null;
}

/** Registry keys, for the manifest validator's honest error messages. */
export function registryKeys(): string[] {
  return Object.keys(REGISTRY);
}

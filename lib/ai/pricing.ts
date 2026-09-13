/** A price for a model the provider listed without one.
 *
 * OpenAI, Anthropic, Kimi and the rest answer `GET /models` with ids and no
 * prices. OpenRouter lists the same models, under a vendor prefix, at the
 * vendors' own per-token rates — so a model the person picked directly can be
 * shown OpenRouter's public price for the same model, marked as an estimate
 * (`source: 'route_estimate'`) rather than as the provider's word. The match
 * is by id after the usual differences in spelling: dots for dashes in a
 * version, a `-latest` or a date on the end.
 *
 * Pure, so the matching can be tested against a fixed catalogue.
 */
import type { ModelInfo } from '../playground/model-catalog.ts';

const fold = (id: string) => id.trim().toLowerCase();

/** The forms an id might take on the other side. In order of preference. */
function idVariants(id: string): string[] {
  const base = fold(id);
  const out = new Set<string>([base]);
  const stripped = base
    .replace(/-latest$/, '')
    .replace(/[-_]\d{8}$/, '')
    .replace(/[-_]\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-preview$/, '');
  out.add(stripped);
  for (const form of [base, stripped]) {
    // claude-sonnet-4-5 ↔ claude-sonnet-4.5; gpt-4.1 ↔ gpt-4-1
    out.add(form.replace(/(\d)-(\d)/g, '$1.$2'));
    out.add(form.replace(/(\d)\.(\d)/g, '$1-$2'));
  }
  return [...out];
}

/** The OpenRouter row for a vendor's model id, if the catalogue has it. */
export function routeListingFor(
  vendor: string,
  id: string,
  catalogue: readonly ModelInfo[],
): ModelInfo | undefined {
  const byId = new Map<string, ModelInfo>();
  for (const row of catalogue) byId.set(fold(row.id), row);
  const prefix = fold(vendor) + '/';
  for (const variant of idVariants(id)) {
    const hit = byId.get(prefix + variant);
    if (hit) return hit;
  }
  return undefined;
}

/** The provider's own rows, each carrying OpenRouter's price for the same
 * model where one is listed. Rows already priced are left as they are. */
export function withRoutePrices(
  models: readonly ModelInfo[],
  vendor: string,
  catalogue: readonly ModelInfo[],
): ModelInfo[] {
  return models.map((model) => {
    if (model.pricing) return model;
    const listing = routeListingFor(vendor, model.id, catalogue);
    if (!listing?.pricing) return model;
    return {
      ...model,
      pricing: { ...listing.pricing, source: 'route_estimate' },
      context_length: model.context_length ?? listing.context_length,
      max_output_tokens: model.max_output_tokens ?? listing.max_output_tokens,
      tools: model.tools ?? listing.tools,
      reasoning: model.reasoning ?? listing.reasoning,
      name: model.name ?? listing.name,
      metadata_source: 'openrouter',
    };
  });
}

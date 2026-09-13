export type ReasoningEffort =
  'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface ModelPricing {
  basis: 'per_million';
  currency: 'USD';
  input?: number;
  output?: number;
  inputMax?: number;
  outputMax?: number;
  request?: number;
  source: 'catalog' | 'route_estimate';
}
export interface ModelInfo {
  id: string;
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
  pricing?: ModelPricing;
  supported_parameters?: string[];
  tools?: boolean;
  reasoning?: boolean;
  /** Takes images as input. */
  vision?: boolean;
  reasoning_efforts?: string[];
  metadata_source?: string;
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (x: unknown) => {
  if (x === null || x === undefined || x === '') return undefined;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const positive = (x: unknown) => {
  const n = finite(x);
  return n && Number.isSafeInteger(n) ? n : undefined;
};
const strings = (x: unknown) =>
  Array.isArray(x)
    ? x.filter((v): v is string => typeof v === 'string' && v.length <= 80).slice(0, 50)
    : undefined;
const validEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export function normalizeModel(raw: unknown): ModelInfo | null {
  if (
    !record(raw) ||
    typeof raw.id !== 'string' ||
    !raw.id ||
    raw.id.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(raw.id)
  )
    return null;
  const m: ModelInfo = { id: raw.id };
  const name = typeof raw.name === 'string' ? raw.name : raw.display_name;
  if (typeof name === 'string' && name.length <= 512) m.name = name;
  const context = positive(raw.context_length ?? raw.context_window);
  if (context) m.context_length = context;
  const top = record(raw.top_provider) ? raw.top_provider : {};
  const max = positive(raw.max_output_tokens ?? top.max_completion_tokens);
  if (max) m.max_output_tokens = max;
  if (record(raw.pricing)) {
    const p = raw.pricing;
    const normalized = p.basis === 'per_million';
    const input = finite(normalized ? p.input : p.prompt),
      output = finite(normalized ? p.output : p.completion);
    const request = finite(p.request);
    if (input !== undefined || output !== undefined || request !== undefined) {
      m.pricing = {
        basis: 'per_million',
        currency: 'USD',
        source: p.source === 'route_estimate' ? 'route_estimate' : 'catalog',
      };
      if (input !== undefined) m.pricing.input = input * (normalized ? 1 : 1_000_000);
      if (output !== undefined) m.pricing.output = output * (normalized ? 1 : 1_000_000);
      if (normalized && finite(p.inputMax) !== undefined) m.pricing.inputMax = finite(p.inputMax);
      if (normalized && finite(p.outputMax) !== undefined)
        m.pricing.outputMax = finite(p.outputMax);
      if (request !== undefined) m.pricing.request = request;
    }
  }
  const params = strings(raw.supported_parameters);
  if (params) m.supported_parameters = params;
  if (typeof raw.tools === 'boolean') m.tools = raw.tools;
  else if (params) m.tools = params.includes('tools');
  if (typeof raw.vision === 'boolean') m.vision = raw.vision;
  else if (
    record(raw.architecture) &&
    strings(raw.architecture.input_modalities)?.includes('image')
  )
    m.vision = true;
  const reasoning = record(raw.reasoning) ? raw.reasoning : {};
  if (typeof raw.reasoning === 'boolean') m.reasoning = raw.reasoning;
  else if (
    Object.keys(reasoning).length ||
    params?.some((p) => p === 'reasoning' || p === 'reasoning_effort')
  )
    m.reasoning = true;
  const efforts = strings(raw.reasoning_efforts ?? reasoning.supported_efforts)?.filter((e) =>
    validEfforts.has(e),
  );
  if (efforts?.length) m.reasoning_efforts = efforts;
  if (typeof raw.metadata_source === 'string' && raw.metadata_source.length <= 60)
    m.metadata_source = raw.metadata_source;
  return m;
}
export function enrichExperientialModels(models: ModelInfo[], envelope: unknown): ModelInfo[] {
  if (!record(envelope) || !Array.isArray(envelope.models)) return models;
  const lookup = new Map<string, Record<string, unknown>>();
  for (const row of envelope.models)
    if (record(row) && record(row.model) && typeof row.model.slug === 'string')
      lookup.set(row.model.slug, row);
  return models.map((item) => {
    const row = lookup.get(item.id);
    if (!row || !record(row.model)) return item;
    const base = row.model;
    const merged: ModelInfo = { ...item, metadata_source: 'Experiential public catalog' };
    if (typeof base.display_name === 'string' && base.display_name.length <= 512)
      merged.name = base.display_name;
    if (positive(base.context_window)) merged.context_length = positive(base.context_window);
    if (positive(base.max_output_tokens))
      merged.max_output_tokens = positive(base.max_output_tokens);
    const all = Array.isArray(row.providers)
      ? row.providers.filter(record).filter((p) => p.routable === true && p.status === 'active')
      : [];
    const defaults = strings(row.default_provider_ids);
    const selected = defaults?.length ? all.filter((p) => defaults.includes(String(p.id))) : all;
    const routes = selected.length ? selected : all;
    const inputs = routes
      .map((p) => finite(p.input_micro_usd_per_million))
      .filter((x): x is number => x !== undefined)
      .map((x) => x / 1_000_000);
    const outputs = routes
      .map((p) => finite(p.output_micro_usd_per_million))
      .filter((x): x is number => x !== undefined)
      .map((x) => x / 1_000_000);
    if (
      routes.every((p) => p.billing_source === 'host_managed') &&
      inputs.length &&
      outputs.length &&
      inputs.length === routes.length &&
      outputs.length === routes.length
    )
      merged.pricing = {
        basis: 'per_million',
        currency: 'USD',
        input: Math.min(...inputs),
        inputMax: Math.max(...inputs),
        output: Math.min(...outputs),
        outputMax: Math.max(...outputs),
        source: 'route_estimate',
      };
    const caps = routes.map((p) => (record(p.capabilities) ? p.capabilities : {}));
    const params = record(base.supported_params) ? base.supported_params : {};
    if (typeof params.tools === 'boolean') merged.tools = params.tools;
    else if (caps.length && caps.every((c) => typeof c.supports_tools === 'boolean'))
      merged.tools = caps.every((c) => c.supports_tools === true);
    if (typeof params.reasoning === 'boolean') merged.reasoning = params.reasoning;
    else if (caps.some((c) => c.supports_reasoning === true)) merged.reasoning = true;
    const effortLists = caps.map((c) => strings(c.supported_reasoning_efforts));
    if (effortLists.length && effortLists.every((x) => x?.length)) {
      const shared = effortLists[0]!.filter(
        (e) => validEfforts.has(e) && effortLists.every((list) => list!.includes(e)),
      );
      if (shared.length) merged.reasoning_efforts = shared;
    }
    return merged;
  });
}
export function priceKind(model: ModelInfo): 'free' | 'paid' | 'unknown' {
  const p = model.pricing;
  if (!p) return 'unknown';
  if (
    (p.inputMax ?? p.input ?? 0) > 0 ||
    (p.outputMax ?? p.output ?? 0) > 0 ||
    (p.request ?? 0) > 0
  )
    return 'paid';
  return p.input === 0 && p.output === 0 && p.source !== 'route_estimate' ? 'free' : 'unknown';
}
export function formatPrice(value: number | undefined): string {
  return value === undefined
    ? 'Not listed'
    : '$' +
        value.toLocaleString('en-US', { maximumFractionDigits: value > 0 && value < 0.01 ? 5 : 3 });
}
export function rateLabel(model: ModelInfo, side: 'input' | 'output'): string {
  const p = model.pricing;
  if (!p) return 'Not listed';
  const min = p[side],
    max = p[side === 'input' ? 'inputMax' : 'outputMax'];
  return formatPrice(min) + (max !== undefined && min !== max ? '–' + formatPrice(max) : '');
}
export function contextLabel(count?: number): string {
  return !count
    ? 'Not listed'
    : count >= 1_000_000
      ? (count / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M'
      : count >= 1000
        ? (count / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'K'
        : String(count);
}
/** What an answer cost at the listed rates, in dollars. An OpenRouter listing
 * used as an estimate for a direct provider counts too: the figure is marked
 * approximate where it is shown, and no figure at all was the alternative. */
export function estimatedCost(
  model: ModelInfo | undefined,
  input: number,
  output: number,
): number | undefined {
  const p = model?.pricing;
  return p?.input === undefined || p.output === undefined
    ? undefined
    : (input * p.input + output * p.output) / 1_000_000;
}

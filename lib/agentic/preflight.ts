/**
 * A small, deterministic assumption gate inspired by ForgeKit's preflight
 * research. It is advisory by design: ordinary chat is never blocked.
 */
export type PreflightRisk = 'low' | 'medium' | 'high';
export type PreflightDimension = 'input' | 'output' | 'scope' | 'success' | 'constraints';
export type PreflightResult = {
  score: number;
  risk: PreflightRisk;
  shouldAsk: boolean;
  dimensions: Record<PreflightDimension, boolean>;
  missing: PreflightDimension[];
  ambiguities: string[];
  entities: string[];
  questions: string[];
};

const DIMENSIONS: Record<PreflightDimension, RegExp[]> = {
  input: [/\b(from|using|with|given|based on|attached|repo|file|data)\b/i],
  output: [/\b(create|write|build|return|give|show|deliver|implement|fix|explain)\b/i],
  scope: [/\b(in|within|across|component|page|api|service|workspace|module)\b/i],
  success: [/\b(so that|success|acceptance|should|must|works|pass|correct)\b/i],
  constraints: [/\b(avoid|without|only|must not|limit|budget|deadline|compatible|keep)\b/i],
};

const AMBIGUITY =
  /\b(it|this|that|something|anything|better|good|proper|soon|large|small|easy|complex|best)\b/gi;
const ENTITY = /(?:^|\s)([A-Za-z][\w./-]{2,})(?=\s|$|[,:;!?])/g;

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

export function assessTask(text: string, options: { askThreshold?: number } = {}): PreflightResult {
  const source = text.trim().replace(/\s+/g, ' ');
  const words = source ? source.split(' ').length : 0;
  const dimensions = Object.fromEntries(
    Object.entries(DIMENSIONS).map(([key, patterns]) => [
      key,
      patterns.some((pattern) => pattern.test(source)),
    ]),
  ) as Record<PreflightDimension, boolean>;
  const missing = (Object.keys(dimensions) as PreflightDimension[]).filter(
    (key) => !dimensions[key],
  );
  const ambiguities = [...source.matchAll(AMBIGUITY)]
    .map((match) => match[0].toLowerCase())
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 5);
  const entities = [...source.matchAll(ENTITY)]
    .map((match) => match[1])
    .filter((value) => !/^(the|and|for|with|please|make|help|want|need)$/i.test(value))
    .slice(0, 12);
  const concreteness = (5 - missing.length) / 5;
  const specifics = Math.min(1, entities.length / 4);
  const vagueness = Math.min(1, ambiguities.length / 3);
  const length = Math.tanh((words - 12) / 12);
  const score = sigmoid(
    -0.858 + 1.44 * concreteness + 0.5 * specifics - 1.3 * vagueness + 0.6 * length,
  );
  const hardUnderspecified = words < 5 || missing.length >= 4;
  const shouldAsk = hardUnderspecified || score < (options.askThreshold ?? 0.42);
  const risk: PreflightRisk = score < 0.45 ? 'high' : score < 0.7 ? 'medium' : 'low';
  const questions: string[] = [];
  if (!dimensions.output) questions.push('What should the finished result look like?');
  if (!dimensions.scope) questions.push('Where should this change apply?');
  if (!dimensions.success) questions.push('How will we know it is working?');
  if (!dimensions.input) questions.push('What files, data, or examples should I use?');
  return {
    score: Number(score.toFixed(3)),
    risk,
    shouldAsk,
    dimensions,
    missing,
    ambiguities,
    entities,
    questions: questions.slice(0, 3),
  };
}

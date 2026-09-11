/**
 * A bounded supervised lexical / surface-template induction engine.
 * Browser-pure: no model API, network, Node import, embedding, or pretrained parser.
 * This supplied six-field schema is intentionally NOT a general meaning language.
 */
import { CASEFOLD, CASEFOLD_UNICODE_VERSION } from './casefold.ts';

export type Language = string;
export type Role = 'agent' | 'action' | 'patient';
export type Frame = {
  agent: string;
  action: string;
  patient: string;
  polarity: boolean;
  tense: 'past' | 'present' | 'future';
  modality: 'assertion' | 'question' | 'hypothesis';
};
export type Row = {
  id: string;
  family: string;
  split: 'train' | 'development' | 'final_test';
  language: Language;
  category: string;
  text: string;
  gold: Frame | null;
  annotation_note?: string;
};
export type TrainingRow = Row & { gold: Frame; split: 'train' };
export type PatternPart = ['slot', Role] | ['literal', string];
export type Rule = {
  language: string;
  pattern: PatternPart[];
  constants: Pick<Frame, 'polarity' | 'tense' | 'modality'>;
  observations: number;
};
export type LexicalEntry = { language: string; token: string; symbol: string };
export type AlignmentIssue = {
  id: string;
  reason: 'ambiguous_roles' | 'missing_role_alignment';
  missing_roles: Role[];
};
export type Model = {
  schema_version: 'hikmah.single-event.v1';
  algorithm_version: 'intersection-template.v1';
  tokenizer_version: string;
  scope_id: string;
  model_id: string;
  parent_model_id: string | null;
  training_hash: string;
  training_ids: string[];
  training_families: string[];
  training_utterance_hashes: string[];
  lexicon: LexicalEntry[];
  rules: Rule[];
  unaligned_training_ids: string[];
  alignment_issues: AlignmentIssue[];
  lexical_diagnostics: {
    language: string;
    token: string;
    candidates: string[];
    observations: number;
  }[];
};
export type Evidence = { rule_index: number; observations: number };
export type Prediction = {
  status: 'predicted' | 'abstained';
  reason?: 'ambiguous_parse' | 'no_supported_parse';
  frame: Frame | null;
  candidate_count: number;
  alternatives: Frame[];
  rule_evidence: Evidence[];
  diagnostics: { tokens: string[]; unknown_tokens: string[]; applicable_rules: number };
};
export type ScoredPrediction = Row & Prediction & { expected: Frame | null; correct: boolean };
export type Evaluation = {
  examples: number;
  frame_scored_examples: number;
  correct_frames: number;
  exact_match_including_abstentions: number | null;
  emitted_frames: number;
  abstentions: number;
  coverage: number | null;
  selective_accuracy: number | null;
  schema_boundary_examples: number;
  schema_boundary_abstentions: number;
  predictions: ScoredPrediction[];
};
export type CandidateReceipt = {
  approved: boolean;
  new_correct_frames: number;
  regressions: string[];
  wrong_emitted_frames: string[];
  active_hash_before: string;
  active_hash_after: string;
  candidate_hash: string;
  selected_model_id: string;
  scope_id: string;
  counterexample: ScoredPrediction | null;
  reason:
    'improved_without_observed_regression' | 'regression' | 'wrong_emission' | 'no_measured_gain';
  evaluated_on: 'development';
};

export const LIMITS = Object.freeze({
  rows: 1000,
  textCharacters: 512,
  tokens: 64,
  tokenCharacters: 96,
  jsonBytes: 500_000,
  symbolCharacters: 128,
});
const ROLES: readonly Role[] = ['agent', 'action', 'patient'];
const FRAME_KEYS = ['agent', 'action', 'patient', 'polarity', 'tense', 'modality'];
const ROW_KEYS = [
  'id',
  'family',
  'split',
  'language',
  'category',
  'text',
  'gold',
  'annotation_note',
];
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const schemaVersion = 'hikmah.single-event.v1' as const;

export class InputError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}
function reject(code: string, message: string): never {
  throw new InputError(code, message);
}
function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    reject('INVALID_SHAPE', `${label} must be an object.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    reject('INVALID_PROTOTYPE', `${label} must be a plain data object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (POISON_KEYS.has(key)) reject('UNSAFE_KEY', `${label} contains a reserved property name.`);
    if (descriptor.get || descriptor.set)
      reject('ACCESSOR_NOT_ALLOWED', `${label} must contain plain values.`);
  }
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    reject('INVALID_STRING', `${label} must contain 1–${max} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    reject('CONTROL_CHARACTER', `${label} contains unsupported control characters.`);
  return value;
}
function languageValue(value: unknown): string {
  const language = boundedString(value, 'language', 24);
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u.test(language))
    reject('INVALID_LANGUAGE', 'Use a lowercase language code such as en, ar, hi, or en-gb.');
  return language;
}
function exactKeys(record: Record<string, unknown>, keys: string[], label: string) {
  const supplied = Object.keys(record);
  if (supplied.length !== keys.length || supplied.some((key) => !keys.includes(key)))
    reject('INVALID_SCHEMA', `${label} fields must be exactly: ${keys.join(', ')}.`);
}
export function validateFrame(value: unknown): Frame {
  const frame = plain(value, 'gold');
  exactKeys(frame, FRAME_KEYS, 'gold');
  for (const role of ROLES) {
    const symbol = boundedString(frame[role], `gold.${role}`, LIMITS.symbolCharacters);
    const prefix = role === 'action' ? 'action:' : 'person:';
    if (!symbol.startsWith(prefix) || symbol.length === prefix.length || /\s/u.test(symbol))
      reject(
        'INVALID_SYMBOL',
        `gold.${role} must use a non-empty ${prefix} symbol without spaces.`,
      );
  }
  if (typeof frame.polarity !== 'boolean')
    reject('INVALID_POLARITY', 'gold.polarity must be true or false.');
  if (!['past', 'present', 'future'].includes(frame.tense as string))
    reject('INVALID_TENSE', 'gold.tense must be past, present, or future.');
  if (!['assertion', 'question', 'hypothesis'].includes(frame.modality as string))
    reject('INVALID_MODALITY', 'gold.modality must be assertion, question, or hypothesis.');
  return {
    agent: frame.agent as string,
    action: frame.action as string,
    patient: frame.patient as string,
    polarity: frame.polarity,
    tense: frame.tense as Frame['tense'],
    modality: frame.modality as Frame['modality'],
  };
}

/** Supplied segmentation and normalization; these are not learned. */
export function tokenize(text: string): string[] {
  boundedString(text, 'text', LIMITS.textCharacters);
  let folded = '';
  for (const point of text.normalize('NFC')) folded += CASEFOLD.get(point) ?? point;
  const normalized = folded.trim().replace(/[.!?؟।]+$/u, '');
  const tokens = normalized.trim() ? normalized.trim().split(/\s+/u) : [];
  if (
    tokens.length > LIMITS.tokens ||
    tokens.some((token) => token.length > LIMITS.tokenCharacters)
  )
    reject(
      'TEXT_TOO_COMPLEX',
      `Use at most ${LIMITS.tokens} whitespace tokens, each at most ${LIMITS.tokenCharacters} characters.`,
    );
  return tokens;
}

/** JSON/form rows may omit family, category and split; defaults describe user training. */
export function validateRows(
  input: unknown,
  mode: 'train' | 'evaluation' | 'development' = 'train',
): Row[] {
  if (!Array.isArray(input)) reject('INVALID_ROWS', 'Supply an array of example rows.');
  if (input.length > LIMITS.rows)
    reject('TOO_MANY_ROWS', `At most ${LIMITS.rows} rows are allowed.`);
  const ids = new Set<string>();
  return input.map((value, index) => {
    const row = plain(value, `row ${index + 1}`);
    if (Object.keys(row).some((key) => !ROW_KEYS.includes(key)))
      reject('UNKNOWN_FIELD', `Row ${index + 1} contains an unsupported field.`);
    const id = boundedString(row.id, `row ${index + 1}.id`, 96);
    if (ids.has(id)) reject('DUPLICATE_ID', `Example ID ${id} appears more than once.`);
    ids.add(id);
    const language = languageValue(row.language);
    const text = boundedString(row.text, 'text', LIMITS.textCharacters);
    if (tokenize(text).length === 0)
      reject('EMPTY_UTTERANCE', 'An utterance must contain at least one token.');
    const split = row.split ?? (mode === 'development' ? 'development' : 'train');
    if (!['train', 'development', 'final_test'].includes(split as string))
      reject('INVALID_SPLIT', 'split must be train, development, or final_test.');
    if (mode === 'train' && split !== 'train')
      reject('TRAINING_SPLIT_ONLY', 'Training accepts train rows only.');
    if (mode === 'development' && split !== 'development')
      reject('DEVELOPMENT_SPLIT_ONLY', 'Promotion accepts development rows only.');
    const gold = row.gold === null && mode !== 'train' ? null : validateFrame(row.gold);
    return {
      id,
      family: boundedString(row.family ?? `user/${id}`, 'family', 180),
      split: split as Row['split'],
      language,
      category: boundedString(row.category ?? 'user_taught', 'category', 96),
      text,
      gold,
      ...(row.annotation_note === undefined
        ? {}
        : { annotation_note: boundedString(row.annotation_note, 'annotation_note', 512) }),
    };
  });
}
export function parseRowsJson(
  json: string,
  mode: 'train' | 'evaluation' | 'development' = 'train',
): Row[] {
  if (
    typeof json !== 'string' ||
    json.length > LIMITS.jsonBytes ||
    new TextEncoder().encode(json).length > LIMITS.jsonBytes
  )
    reject('JSON_TOO_LARGE', `JSON must be at most ${LIMITS.jsonBytes} UTF-8 bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return reject('INVALID_JSON', 'The example JSON is not valid.');
  }
  return validateRows(value, mode);
}

/** Canonical string for this JSON-only schema. No reliance on object insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = plain(value, 'canonical value');
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]))
      .join(',') +
    '}'
  );
}

/** SHA-256 content identity; hashes do not authenticate user-supplied supervision. */
export function sha256(text: string): string {
  const input = new TextEncoder().encode(text);
  const size = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(size);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(size - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(size - 4, (input.length * 8) >>> 0);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotr = (n: number, by: number) => (n >>> by) | (n << (32 - by));
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[i - 7] +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((value, i) => {
      h[i] = (h[i] + value) >>> 0;
    });
  }
  return h.map((n) => n.toString(16).padStart(8, '0')).join('');
}
function stableHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
function lexicalKey(language: string, token: string): string {
  return canonicalJson([language, token]);
}
function utteranceHash(row: Pick<Row, 'language' | 'text'>): string {
  return stableHash([row.language, tokenize(row.text)]);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function stringCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function train(
  input: unknown,
  options: { scopeId?: string; parentModelId?: string } = {},
): Model {
  const rows = validateRows(input, 'train') as TrainingRow[];
  const scopeId = boundedString(options.scopeId ?? 'local-playground', 'scopeId', 96);
  const parentModelId = options.parentModelId
    ? boundedString(options.parentModelId, 'parentModelId', 80)
    : null;
  const intersections = new Map<
    string,
    { language: string; token: string; values: Set<string>; observations: number }
  >();
  const seen = new Map<string, string>();
  for (const row of rows) {
    const words = tokenize(row.text),
      key = canonicalJson([row.language, words]),
      label = canonicalJson(row.gold);
    if (seen.has(key) && seen.get(key) !== label)
      reject('CONFLICTING_SUPERVISION', 'Conflicting labels for the same normalized utterance.');
    seen.set(key, label);
    const atoms = new Set(ROLES.map((role) => row.gold[role]));
    for (const token of new Set(words)) {
      const tkey = lexicalKey(row.language, token),
        current = intersections.get(tkey);
      if (current) {
        current.values = new Set([...current.values].filter((value) => atoms.has(value)));
        current.observations++;
      } else
        intersections.set(tkey, {
          language: row.language,
          token,
          values: new Set(atoms),
          observations: 1,
        });
    }
  }
  const lexicon: LexicalEntry[] = [...intersections.values()]
    .filter((entry) => entry.values.size === 1)
    .map((entry) => ({
      language: entry.language,
      token: entry.token,
      symbol: [...entry.values][0],
    }))
    .sort((a, b) => stringCompare(a.language, b.language) || stringCompare(a.token, b.token));
  const dictionary = new Map(
    lexicon.map((entry) => [lexicalKey(entry.language, entry.token), entry.symbol]),
  );
  const counts = new Map<string, Rule>();
  const alignmentIssues: AlignmentIssue[] = [];
  for (const row of rows) {
    const pattern: PatternPart[] = [],
      covered = new Set<Role>();
    let ambiguous = false;
    for (const token of tokenize(row.text)) {
      const value = dictionary.get(lexicalKey(row.language, token));
      const roles = ROLES.filter((role) => row.gold[role] === value);
      if (roles.length > 1) {
        ambiguous = true;
        break;
      }
      if (roles.length) {
        pattern.push(['slot', roles[0]]);
        covered.add(roles[0]);
      } else pattern.push(['literal', token]);
    }
    if (ambiguous || covered.size !== ROLES.length) {
      alignmentIssues.push({
        id: row.id,
        reason: ambiguous ? 'ambiguous_roles' : 'missing_role_alignment',
        missing_roles: ROLES.filter((role) => !covered.has(role)),
      });
      continue;
    }
    const constants = {
      polarity: row.gold.polarity,
      tense: row.gold.tense,
      modality: row.gold.modality,
    };
    const key = canonicalJson([row.language, pattern, constants]);
    const current = counts.get(key);
    if (current) current.observations++;
    else counts.set(key, { language: row.language, pattern, constants, observations: 1 });
  }
  // Stable ordering makes rule receipts reproducible within this implementation.
  const rules = [...counts.entries()]
    .sort((a, b) => stringCompare(a[0], b[0]))
    .map(([, rule]) => rule);
  const trainingHash = stableHash(rows);
  const identity = {
    schema_version: schemaVersion,
    algorithm_version: 'intersection-template.v1' as const,
    tokenizer_version: `NFC-python-casefold-${CASEFOLD_UNICODE_VERSION}-whitespace.v1`,
    scope_id: scopeId,
    parent_model_id: parentModelId,
    training_hash: trainingHash,
  };
  return deepFreeze({
    ...identity,
    model_id: 'model:' + stableHash(identity),
    training_ids: rows.map((row) => row.id),
    training_families: [...new Set(rows.map((row) => row.family))].sort(),
    training_utterance_hashes: [...new Set(rows.map(utteranceHash))].sort(),
    lexicon,
    rules,
    unaligned_training_ids: alignmentIssues.map((issue) => issue.id),
    alignment_issues: alignmentIssues,
    lexical_diagnostics: [...intersections.values()].map((entry) => ({
      language: entry.language,
      token: entry.token,
      candidates: [...entry.values].sort(),
      observations: entry.observations,
    })),
  });
}

export function summarize(model: Model) {
  return {
    training_rows: model.training_ids.length,
    training_hash: model.training_hash,
    learned_lexical_entries: model.lexicon.length,
    learned_surface_rules: model.rules.length,
    unaligned_training_rows: model.unaligned_training_ids.length,
    model_id: model.model_id,
    scope_id: model.scope_id,
  };
}
function checkModel(model: Model) {
  // Model JSON is exportable, but model import is deliberately not a UI boundary.
  if (
    !model ||
    model.schema_version !== schemaVersion ||
    model.algorithm_version !== 'intersection-template.v1' ||
    !Array.isArray(model.rules) ||
    model.rules.length > LIMITS.rows ||
    !Array.isArray(model.lexicon) ||
    model.lexicon.length > LIMITS.rows * LIMITS.tokens
  )
    reject('INVALID_MODEL', 'Use a model produced by this engine version.');
}
function predictValidated(
  model: Model,
  language: string,
  text: string,
  dictionary?: Map<string, string>,
): Prediction {
  const words = tokenize(text),
    lexicon =
      dictionary ??
      new Map(
        model.lexicon.map((entry) => [lexicalKey(entry.language, entry.token), entry.symbol]),
      );
  const candidates = new Map<string, Frame>(),
    evidence: Evidence[] = [];
  let applicableRules = 0;
  for (let index = 0; index < model.rules.length; index++) {
    const rule = model.rules[index];
    if (rule.language !== language || words.length !== rule.pattern.length) continue;
    applicableRules++;
    const bindings = new Map<Role, string>();
    let matched = true;
    for (let i = 0; i < words.length; i++) {
      const [kind, value] = rule.pattern[i];
      if (kind === 'literal') {
        if (words[i] !== value) {
          matched = false;
          break;
        }
      } else {
        const atom = lexicon.get(lexicalKey(language, words[i]));
        if (
          !atom ||
          !atom.startsWith(value === 'action' ? 'action:' : 'person:') ||
          (bindings.has(value) && bindings.get(value) !== atom)
        ) {
          matched = false;
          break;
        }
        bindings.set(value, atom);
      }
    }
    if (matched && ROLES.every((role) => bindings.has(role))) {
      const frame: Frame = {
        agent: bindings.get('agent')!,
        action: bindings.get('action')!,
        patient: bindings.get('patient')!,
        ...rule.constants,
      };
      candidates.set(canonicalJson(frame), frame);
      evidence.push({ rule_index: index, observations: rule.observations });
    }
  }
  const alternatives = [...candidates.values()];
  const knownLiterals = new Set(
    model.rules
      .filter((rule) => rule.language === language)
      .flatMap((rule) =>
        rule.pattern.filter((part) => part[0] === 'literal').map((part) => part[1]),
      ),
  );
  const common = {
    candidate_count: alternatives.length,
    alternatives,
    rule_evidence: evidence,
    diagnostics: {
      tokens: words,
      unknown_tokens: [
        ...new Set(
          words.filter(
            (word) => !lexicon.has(lexicalKey(language, word)) && !knownLiterals.has(word),
          ),
        ),
      ],
      applicable_rules: applicableRules,
    },
  };
  if (alternatives.length === 1) return { status: 'predicted', frame: alternatives[0], ...common };
  return {
    status: 'abstained',
    reason: alternatives.length ? 'ambiguous_parse' : 'no_supported_parse',
    frame: null,
    ...common,
  };
}
export function predict(model: Model, language: string, text: string): Prediction {
  checkModel(model);
  return predictValidated(model, languageValue(language), text);
}
export function evaluate(model: Model, input: unknown): Evaluation {
  checkModel(model);
  const rows = validateRows(input, 'evaluation');
  const dictionary = new Map(
    model.lexicon.map((entry) => [lexicalKey(entry.language, entry.token), entry.symbol]),
  );
  const predictions: ScoredPrediction[] = rows.map((row) => {
    const result = predictValidated(model, row.language, row.text, dictionary);
    return {
      ...row,
      expected: row.gold,
      ...result,
      correct:
        row.gold !== null &&
        result.frame !== null &&
        canonicalJson(row.gold) === canonicalJson(result.frame),
    };
  });
  const count = rows.length,
    scored = rows.filter((row) => row.gold !== null).length,
    emitted = predictions.filter((row) => row.status === 'predicted').length,
    correct = predictions.filter((row) => row.correct).length;
  const boundaries = predictions.filter((row) => row.expected === null);
  return {
    examples: count,
    frame_scored_examples: scored,
    correct_frames: correct,
    exact_match_including_abstentions: scored ? correct / scored : null,
    emitted_frames: emitted,
    abstentions: count - emitted,
    coverage: count ? emitted / count : null,
    selective_accuracy: emitted ? correct / emitted : null,
    schema_boundary_examples: boundaries.length,
    schema_boundary_abstentions: boundaries.filter((row) => row.status === 'abstained').length,
    predictions,
  };
}

/** Pure gate: never changes either snapshot; caller explicitly adopts selectedModel. */
export function compareCandidates(
  active: Model,
  candidate: Model,
  input: unknown,
): {
  selectedModel: Model;
  receipt: CandidateReceipt;
  activeEvaluation: Evaluation;
  candidateEvaluation: Evaluation;
} {
  checkModel(active);
  checkModel(candidate);
  if (active.scope_id !== candidate.scope_id)
    reject('SCOPE_MISMATCH', 'Candidate and active model must belong to the same workspace scope.');
  if (candidate.parent_model_id && candidate.parent_model_id !== active.model_id)
    reject('STALE_PARENT', 'Candidate was proposed against a different active snapshot.');
  const rows = validateRows(input, 'development');
  if (!rows.length)
    reject('EMPTY_DEVELOPMENT', 'Supply held-out development rows to evaluate a candidate.');
  for (const model of [active, candidate]) {
    const ids = new Set(model.training_ids),
      families = new Set(model.training_families),
      utterances = new Set(model.training_utterance_hashes);
    if (
      rows.some(
        (row) => ids.has(row.id) || families.has(row.family) || utterances.has(utteranceHash(row)),
      )
    )
      reject(
        'DEVELOPMENT_LEAKAGE',
        'Development IDs, semantic families and normalized utterances must remain outside training.',
      );
  }
  const before = evaluate(active, rows),
    after = evaluate(candidate, rows);
  const regressions = after.predictions
    .filter((row, index) => before.predictions[index].correct && !row.correct)
    .map((row) => row.id);
  const wrong = after.predictions.filter((row) => row.status === 'predicted' && !row.correct);
  const gain = after.correct_frames - before.correct_frames;
  const approved = regressions.length === 0 && wrong.length === 0 && gain > 0;
  const selectedModel = approved ? candidate : active;
  return {
    selectedModel,
    activeEvaluation: before,
    candidateEvaluation: after,
    receipt: {
      approved,
      new_correct_frames: gain,
      regressions,
      wrong_emitted_frames: wrong.map((row) => row.id),
      active_hash_before: active.training_hash,
      active_hash_after: selectedModel.training_hash,
      candidate_hash: candidate.training_hash,
      selected_model_id: selectedModel.model_id,
      scope_id: active.scope_id,
      counterexample: wrong[0] ?? null,
      reason: approved
        ? 'improved_without_observed_regression'
        : regressions.length
          ? 'regression'
          : wrong.length
            ? 'wrong_emission'
            : 'no_measured_gain',
      evaluated_on: 'development',
    },
  };
}

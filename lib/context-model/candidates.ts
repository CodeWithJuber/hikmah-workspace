/** Which sentences from your own chats the co-model should be shown next.
 *
 * The co-model is a dependency parser fitted on gold annotations, not a
 * language model, so it cannot learn from an answer a provider wrote: a chat
 * reply carries no grammar to learn from. Training it on its own parses instead
 * teaches it to agree with itself, which is why the studio has always said
 * "automatic chat collection and unreviewed provider answers are not ground
 * truth".
 *
 * What every chat *can* do automatically is say which sentences the model found
 * hardest. That is active learning, and it is the standard answer: the run
 * already parses the owner's recent turns to build its context notes, so the
 * uncertainty is measured and thrown away. Keeping it costs nothing and turns
 * every conversation into a queue of the sentences worth annotating — which the
 * owner then corrects, in bulk, through the upload.
 *
 * Pure: no database, no request, so the ranking and the conversion can be
 * tested without either.
 */
import type { ContextGraph } from './discourse.ts';
import type { Parse } from './field-model.ts';

/** The 17 tags the trainer accepts. Anything else is dropped rather than
 * guessed at: a row the validator will refuse helps nobody. */
const UPOS = new Set([
  'ADJ',
  'ADP',
  'ADV',
  'AUX',
  'CCONJ',
  'DET',
  'INTJ',
  'NOUN',
  'NUM',
  'PART',
  'PRON',
  'PROPN',
  'PUNCT',
  'SCONJ',
  'SYM',
  'VERB',
  'X',
]);

/** Below this a "sentence" is a greeting or a fragment, and annotating it
 * teaches the parser nothing it does not already know. */
export const MIN_TOKENS = 4;
/** The trainer's own ceiling; a longer one could never be submitted. Not
 * exported: `toAnnotation` below is the only thing that needs to know, and a
 * second copy of the trainer's limit is a second place for it to drift. */
const MAX_TOKENS = 96;

export type Candidate = {
  language: string;
  text: string;
  /** For dedupe: the same question asked twice is one sentence to review. */
  fingerprint: string;
  /** Share of tokens whose form the model has seen before, 0–1. */
  coverage: number;
  /** Mean arc score per token. Lower means the tree it chose was a close call. */
  score: number;
  tokens: number;
  /** The model's own parse, in the shape the trainer accepts, so the owner
   * corrects an answer rather than annotating from nothing. */
  annotation: Annotation;
};

export type Annotation = {
  id: string;
  groupId: string;
  split: 'train';
  text: string;
  tokens: {
    id: number;
    form: string;
    lemma: string;
    upos: string;
    head: number;
    deprel: string;
    feats: Record<string, string>;
  }[];
};

/** Same sentence, however it was spaced or cased. */
export const fingerprint = (text: string) =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * How unsure the model was, 0 (confident) to 1 (lost).
 *
 * Unseen vocabulary dominates, because that is the thing an owner's own
 * annotations actually fix: a word the model has never met is one it can only
 * guess at. The arc score breaks ties — a tree assembled from weak evidence is
 * worth a second look even when every word was familiar.
 */
export function uncertainty(candidate: Pick<Candidate, 'coverage' | 'score'>): number {
  const unseen = 1 - Math.min(1, Math.max(0, candidate.coverage));
  // Arc scores are unbounded below and roughly zero-centred, so this maps "very
  // negative" to 1 and "comfortably positive" to 0 without pretending to be a
  // probability.
  const weak = 1 / (1 + Math.exp(candidate.score));
  return unseen * 0.75 + weak * 0.25;
}

/** A relation the trainer will accept, or '' when it will not. */
function deprel(relation: unknown): string {
  const value = typeof relation === 'string' ? relation.toLowerCase() : '';
  return /^[a-z][a-z_:]{0,40}$/.test(value) ? value : '';
}

/**
 * One parse as a row the trainer accepts, or null.
 *
 * Null rather than a best effort: every rule below is one `validateTeaching`
 * enforces, and handing the owner a row that will be refused on submit wastes
 * the review rather than saving it. The parser can produce a relation it does
 * not like, a tag outside the 17, more than one root or none at all — all of
 * which are honest outputs of a parser and none of which is a valid training
 * row.
 */
export function toAnnotation(
  parse: Parse,
  options: { id: string; groupId: string; text: string },
): Annotation | null {
  const source = parse.tokens ?? [];
  if (source.length < MIN_TOKENS || source.length > MAX_TOKENS) return null;

  const tokens: Annotation['tokens'] = [];
  let roots = 0;
  for (const [index, token] of source.entries()) {
    // Positions must run 1, 2, 3… The parser is 1-based already; anything else
    // is a shape this cannot repair.
    if (token.id !== index + 1) return null;
    const relation = deprel(token.relation);
    if (!relation) return null;
    if (!token.form || typeof token.form !== 'string') return null;
    if (!UPOS.has(token.upos)) return null;
    if (!Number.isInteger(token.head) || token.head < 0 || token.head > source.length) return null;
    if (token.head === token.id) return null;
    // The trainer requires these to agree, and a parser that has labelled a
    // non-root arc `root` has told us something is wrong with this sentence.
    if ((token.head === 0) !== (relation === 'root')) return null;
    if (token.head === 0) roots++;
    tokens.push({
      id: token.id,
      form: token.form,
      lemma: token.lemma || token.form,
      upos: token.upos,
      head: token.head,
      deprel: relation,
      feats: sanitiseFeats(token.morphology),
    });
  }
  if (roots !== 1) return null;
  if (hasCycle(tokens)) return null;
  return { id: options.id, groupId: options.groupId, split: 'train', text: options.text, tokens };
}

/** Feature values the trainer accepts: short strings, keyed short. */
function sanitiseFeats(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const feats: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>))
    if (key.length <= 60 && typeof entry === 'string' && entry.length <= 100) feats[key] = entry;
  return feats;
}

/** The trainer walks heads to the root and refuses a loop; so does this, for
 * the same reason and before the owner's time is spent on it. */
function hasCycle(tokens: Annotation['tokens']): boolean {
  for (const token of tokens) {
    const seen = new Set<number>();
    let id = token.id;
    while (id) {
      if (seen.has(id)) return true;
      seen.add(id);
      const next = tokens[id - 1];
      if (!next) return true;
      id = next.head;
    }
  }
  return false;
}

/**
 * The reviewable sentences in one turn's parse, hardest first.
 *
 * Everything the parser could not turn into a valid row is dropped silently:
 * this runs on the request path behind a chat message, and a sentence that
 * cannot be annotated is not a failure of the conversation.
 */
export function candidatesFrom(graph: ContextGraph, groupId = 'owner/chat'): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const sentence of graph.sentences ?? []) {
    const parse = sentence.parse;
    if (!parse?.tokens?.length) continue;
    const text = sentence.text?.trim() ?? '';
    // A "sentence" with no letters is punctuation or a number, and there is no
    // grammar in it to learn.
    if (!text || !/[\p{L}]/u.test(text)) continue;
    const key = fingerprint(text);
    if (!key || seen.has(key)) continue;

    const annotation = toAnnotation(parse, {
      id: key.slice(0, 100),
      groupId,
      text: text.slice(0, 12000),
    });
    if (!annotation) continue;

    seen.add(key);
    out.push({
      language: sentence.language,
      text: annotation.text,
      fingerprint: key,
      coverage: typeof parse.lexicalCoverage === 'number' ? parse.lexicalCoverage : 0,
      score: parse.tokens.length ? (parse.score ?? 0) / parse.tokens.length : 0,
      tokens: annotation.tokens.length,
      annotation,
    });
  }
  return out.sort((a, b) => uncertainty(b) - uncertainty(a));
}

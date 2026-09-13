/** The co-model's block for one run.
 *
 * This is the piece that was missing. `analyzeContext` in `client.ts` was
 * called from exactly one place — the browser chat's run loop — and when that
 * was retired the whole feature went with it silently: the studio still trains
 * checkpoints, the owner can still activate one, and no run has read a field
 * model since. "Not working at all" was the accurate description.
 *
 * Composed here, on the server, from the recent user turns, and written onto
 * the run row with the rest of its instructions. That last part matters for a
 * resume: a run paused on an approval carries the brief it started with, so
 * the model does not see the conversation re-described halfway through.
 */

import { compileContext, detectLanguage, documentSentences } from './discourse.ts';
import { contextBrief, type ContextBrief } from './brief.ts';
import type { FieldModel } from './field-model.ts';
import { isSupported } from './server.ts';

/** How many of the owner's own turns the notes look back over. The turn being
 * sent, and enough before it to carry a pronoun's referent. */
export const BRIEF_USER_TURNS = 3;
/**
 * Ceilings on the parse, not on the conversation.
 *
 * `compileContext` is synchronous CPU on the request path. Measured at 24
 * sentences across three languages it is ~50 ms warm and ~136 ms cold; at 12
 * it is roughly half that, which is a cost worth paying once per turn. The
 * character cap is the guard against a single pasted document arriving as one
 * enormous sentence.
 */
export const BRIEF_MAX_SENTENCES = 12;
export const BRIEF_MAX_CHARACTERS = 4_000;
/** At most two grammars per turn, matching what stays resident. A message that
 * touches five languages gets the two it uses most recently. */
export const BRIEF_MAX_LANGUAGES = 2;
/** Reading a checkpoint off disk is ~70–170 ms cold. Past this the turn goes
 * without notes rather than waiting on them. */
export const BRIEF_LOAD_TIMEOUT_MS = 2_000;

type TextPart = { type?: string; text?: unknown };
type Turn = { role?: string; parts?: TextPart[] };

/** The owner's own recent words, which is all the compiler is pointed at.
 *
 * Deliberately not the assistant's: annotating our own output back to
 * ourselves adds nothing, and it would double the parse cost per turn.
 */
export function recentUserText(messages: readonly Turn[], turns = BRIEF_USER_TURNS): string {
  return messages
    .filter((message) => message?.role === 'user')
    .slice(-turns)
    .map((message) =>
      (message.parts ?? [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n'),
    )
    .filter((text) => text.trim())
    .join('\n');
}

/** The tail of the text, bounded both ways, as sentences. */
export function briefSentences(text: string): string[] {
  return documentSentences(text.slice(-BRIEF_MAX_CHARACTERS)).slice(-BRIEF_MAX_SENTENCES);
}

export type BriefOutcome = {
  /** '' when there is nothing worth saying, or nothing could be loaded. */
  block: string;
  /** Why the block is empty, for the run receipt and the operator log. */
  reason: 'ok' | 'empty' | 'no-model' | 'failed' | 'off';
  brief?: ContextBrief;
};

const NOTHING = (reason: BriefOutcome['reason']): BriefOutcome => ({ block: '', reason });

/**
 * Build the block, or return nothing and say why.
 *
 * Never throws. A grammar that will not load, a sentence the parser rejects, a
 * language with no checkpoint — none of those is a reason for the person's
 * message not to be sent. The old browser version substituted a sentence
 * saying the local model was unavailable; that told the model something about
 * our infrastructure and nothing about the conversation, so this omits the
 * block instead.
 */
export async function buildContextBrief(options: {
  messages: readonly Turn[];
  loadField: (language: string) => Promise<FieldModel>;
  timeoutMs?: number;
}): Promise<BriefOutcome> {
  const sentences = briefSentences(recentUserText(options.messages));
  if (!sentences.length) return NOTHING('empty');

  // Most recent first, so a bilingual turn keeps the grammar of what was just
  // said rather than of what was said three turns ago.
  const languages: string[] = [];
  for (const sentence of [...sentences].reverse()) {
    const language = detectLanguage(sentence);
    if (isSupported(language) && !languages.includes(language)) languages.push(language);
    if (languages.length >= BRIEF_MAX_LANGUAGES) break;
  }
  if (!languages.length) return NOTHING('no-model');

  const models: Record<string, FieldModel> = {};
  try {
    const loaded = await withTimeout(
      Promise.all(
        languages.map(async (language) => [language, await options.loadField(language)] as const),
      ),
      options.timeoutMs ?? BRIEF_LOAD_TIMEOUT_MS,
    );
    for (const [language, model] of loaded) models[language] = model;
  } catch {
    return NOTHING('failed');
  }

  try {
    const brief = contextBrief(compileContext(sentences.join(' '), models, 'auto'));
    return brief.block
      ? { block: brief.block, reason: 'ok', brief }
      : { ...NOTHING('empty'), brief };
  } catch {
    return NOTHING('failed');
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('Context checkpoint load timed out.')), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

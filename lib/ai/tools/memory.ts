/** `remember`: save something the person just said, in their own words.
 *
 * The tool that used to do this — `suggest_memory` — refused unless the quote
 * was an exact substring of the current user message, and filed the result
 * for review. That rule is the whole reason a memory can be trusted: what the
 * model saves is what the person wrote, not what the model made of it. It
 * lived in the browser run loop and went with it; this is it, server-side,
 * with its edges filed:
 *
 * - The quote is checked against the last *user* turn, not the last message —
 *   on a resume the last message is the assistant's.
 * - Both sides are NFC-normalised and single-spaced before the check. Models
 *   re-emit Arabic with different code points and collapse whitespace, and the
 *   old byte-for-byte `includes` refused honest quotes.
 * - A preference may be saved without review, because it is the person's own
 *   words about themselves — but only when the turn carried no attachment, the
 *   quote is short and the message is short. Otherwise any line of a pasted
 *   email would count as "their own words". A reference is always suggested.
 *
 * A background learning task never writes through the store directly: every
 * one of its candidates goes through the policy-gated triage in
 * lib/memory/triage.ts. Jev advises, code + policy decides, the person clicks
 * nothing. Incognito writes nothing at all — not even a triage audit row.
 */
import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore, SqliteHandle } from '../../memory/store.ts';
import {
  triageCandidate,
  type TriageCandidate,
  type TriageContext,
  type TriageJevOptions,
} from '../../memory/triage.ts';

export type MemoryToolContext = {
  userId: string;
  store: MemoryStore;
  /** The raw handle, for triage: it writes its own tables beside the store. */
  db: SqliteHandle;
  /** The last user turn, verbatim: the only text a quote may come from. */
  latestUserText: string;
  /** Whether that turn carried files. Pasted content is not the person's words. */
  hasAttachments: boolean;
  conversationId?: string;
  conversationTitle?: string;
  /** Save a verbatim preference without review. Off means everything waits. */
  autoSaveQuotes: boolean;
  /** A background task: nobody is writing messages to quote from. What the
   * task wants to keep that is not in its brief goes through triage, never
   * straight into the store. */
  unattended?: boolean;
  /** Session incognito: the run reads and writes no memory. The tool answers
   * refused without touching the store, the candidate pipeline, or the triage
   * audit — zero writes, not even bookkeeping. */
  incognito?: boolean;
  /** The triage pipeline. Defaults to the real one; tests inject a double. */
  triage?: typeof triageCandidate;
  /** Jev options passed through to triage. Undefined means triage's own. */
  jevOptions?: TriageJevOptions;
};

/** Beyond these a "quote" is a document, and documents wait for review. */
const MAX_AUTOSAVE_QUOTE = 300;
const MAX_AUTOSAVE_MESSAGE = 2000;

const fold = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Whether `quote` is, allowing for spacing and code-point form, what the
 * person actually wrote. */
export function quoteIsVerbatim(quote: string, latestUserText: string): boolean {
  const needle = fold(quote);
  return needle.length > 0 && fold(latestUserText).includes(needle);
}

/** One learner candidate through the standing triage policy. The learner never
 * touches the store itself: 'save' and 'surface' are triage's own writes, and
 * 'discard'/'defer' leave the memories table alone. */
async function triageRemember(
  context: MemoryToolContext,
  input: { title: string; quote: string; kind: 'preference' | 'reference'; verbatim: boolean },
) {
  const runTriage = context.triage ?? triageCandidate;
  const who = input.verbatim ? 'You' : 'Hikmah';
  const candidate: TriageCandidate = {
    id: 'mem_' + randomUUID(),
    kind: input.kind,
    title: input.title,
    content: input.quote.trim(),
    // The provenance is what the text is, not what the tool was told:
    // the brief's own words stay the person's even inside a task.
    provenance: input.verbatim ? 'quote' : 'inference',
    source: context.conversationTitle ? who + ' · ' + context.conversationTitle : who,
    sourceConversationId: context.conversationId ?? null,
    // Triage decides the final status; this is only the pre-triage shape.
    status: 'suggested',
  };
  const triageContext: TriageContext = {
    incognito: context.incognito === true,
    userId: context.userId,
    jevOptions: context.jevOptions,
  };
  const decision = await runTriage(context.db, candidate, triageContext);
  switch (decision.action) {
    case 'save':
      return {
        status: 'saved' as const,
        location: 'Memory',
        message:
          'Saved to the person’s memory by the standing triage policy. It is audited and reversible.',
      };
    case 'surface':
      return {
        status: 'suggested' as const,
        location: 'Memory',
        message:
          'Surfaced under Memory as a non-blocking suggestion. It is not used until the person keeps it.',
      };
    case 'defer':
      return {
        status: 'deferred' as const,
        location: 'Memory',
        message:
          'Held for a later triage retry — Jev could not be reached. It is not in Memory yet.',
      };
    case 'discard':
      return {
        status: 'refused' as const,
        reason:
          'The standing triage policy did not keep this (transient, secret-shaped, or not durable). It was not saved.',
      };
  }
}

export function rememberTools(context: MemoryToolContext) {
  return {
    remember: tool({
      description: context.unattended
        ? 'Keep something you learned: a finding, in one or two sentences, with where it came from. It goes through the standing triage policy — durable preferences are saved, ambiguous findings are surfaced under Memory without blocking anyone, the rest are discarded. Every decision is audited and reversible. Never save anything secret such as passwords or keys.'
        : 'Save something the person just said, so later answers can draw on it: a preference about how they want answers, or a fact about them or their work worth keeping. The quote must be their exact words, copied from their latest message — it is refused otherwise. Never save what you inferred, what a page said, or anything secret such as passwords or keys. Tell the person what was saved.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('A short name for it.'),
        quote: z
          .string()
          .min(1)
          .max(12000)
          .describe(
            context.unattended
              ? 'What to keep, in one or two sentences.'
              : 'Their exact words, copied from their latest message.',
          ),
        kind: z
          .enum(['preference', 'reference'])
          .describe(
            'preference: how they want answers, kept for every answer. reference: a fact, kept for when it is relevant.',
          ),
      }),
      execute: async ({ title, quote, kind }) => {
        // Incognito first, before any pipeline: zero writes means zero
        // writes — no candidate, no memory row, no triage audit row.
        if (context.incognito)
          return {
            status: 'refused' as const,
            reason: 'This session is incognito: nothing is remembered.',
          };
        const verbatim = quoteIsVerbatim(quote, context.latestUserText);
        if (!verbatim && !context.unattended)
          return {
            status: 'refused' as const,
            reason:
              'That quote is not in the person’s latest message. A memory must be their exact words; do not paraphrase.',
          };
        // A background task never writes a memory directly.
        if (context.unattended) return triageRemember(context, { title, quote, kind, verbatim });
        const autoSave =
          verbatim &&
          context.autoSaveQuotes &&
          kind === 'preference' &&
          !context.hasAttachments &&
          quote.length <= MAX_AUTOSAVE_QUOTE &&
          context.latestUserText.length <= MAX_AUTOSAVE_MESSAGE;
        const who = verbatim ? 'You' : 'Hikmah';
        const saved = context.store.add(context.userId, {
          kind,
          title,
          content: quote.trim(),
          // The provenance is what the text is, not what the tool was told:
          // the brief's own words stay the person's even inside a task.
          provenance: verbatim ? 'quote' : 'inference',
          source: context.conversationTitle ? who + ' · ' + context.conversationTitle : who,
          sourceConversationId: context.conversationId ?? null,
          status: autoSave ? 'saved' : 'suggested',
        });
        if (!saved)
          return {
            status: 'refused' as const,
            reason: 'It could not be saved: memory is full, or the text was empty.',
          };
        return {
          status: autoSave ? ('saved' as const) : ('suggested' as const),
          location: 'Memory',
          message: autoSave
            ? 'Saved to the person’s memory, in their own words.'
            : verbatim
              ? 'Suggested for the person’s review in Memory. It is not used until they accept it.'
              : 'Filed as your own conclusion for the person’s review in Memory. It is not used until they accept it.',
        };
      },
    }),
  };
}

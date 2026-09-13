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
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../../memory/store.ts';

export type MemoryToolContext = {
  userId: string;
  store: MemoryStore;
  /** The last user turn, verbatim: the only text a quote may come from. */
  latestUserText: string;
  /** Whether that turn carried files. Pasted content is not the person's words. */
  hasAttachments: boolean;
  conversationId?: string;
  conversationTitle?: string;
  /** Save a verbatim preference without review. Off means everything waits. */
  autoSaveQuotes: boolean;
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

export function rememberTools(context: MemoryToolContext) {
  return {
    remember: tool({
      description:
        'Save something the person just said, so later answers can draw on it: a preference about how they want answers, or a fact about them or their work worth keeping. The quote must be their exact words, copied from their latest message — it is refused otherwise. Never save what you inferred, what a page said, or anything secret such as passwords or keys. Tell the person what was saved.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('A short name for it.'),
        quote: z
          .string()
          .min(1)
          .max(12000)
          .describe('Their exact words, copied from their latest message.'),
        kind: z
          .enum(['preference', 'reference'])
          .describe(
            'preference: how they want answers, kept for every answer. reference: a fact, kept for when it is relevant.',
          ),
      }),
      execute: async ({ title, quote, kind }) => {
        if (!quoteIsVerbatim(quote, context.latestUserText))
          return {
            status: 'refused' as const,
            reason:
              'That quote is not in the person’s latest message. A memory must be their exact words; do not paraphrase.',
          };
        const autoSave =
          context.autoSaveQuotes &&
          kind === 'preference' &&
          !context.hasAttachments &&
          quote.length <= MAX_AUTOSAVE_QUOTE &&
          context.latestUserText.length <= MAX_AUTOSAVE_MESSAGE;
        const saved = context.store.add(context.userId, {
          kind,
          title,
          content: quote.trim(),
          provenance: 'quote',
          source: context.conversationTitle ? 'You · ' + context.conversationTitle : 'You',
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
            : 'Suggested for the person’s review in Memory. It is not used until they accept it.',
        };
      },
    }),
  };
}

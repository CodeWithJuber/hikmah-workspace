/** Naming a conversation from the message that started it.
 *
 * Derived rather than generated: asking a model to summarise the first message
 * would cost a request and a wait before the answer the owner actually asked
 * for, and on the free models this deployment defaults to it would sometimes
 * return prose instead of a title. The opening words of the question are a
 * better name than a bad summary, and they are the words the owner will be
 * scanning for in the list.
 */

/** How much of the opening message to keep. Long enough to tell two questions
 * apart, short enough for a sidebar row. */
const MAX_LENGTH = 60;

type Part = { type?: string; text?: string };

/**
 * A title for a conversation, or '' when the message carries no words.
 *
 * An empty result is left empty rather than filled with a placeholder: the list
 * can then show something honest for a conversation that began with a file or
 * an image, instead of every one of them being called the same thing.
 */
export function conversationTitle(parts: unknown): string {
  const text = (Array.isArray(parts) ? (parts as Part[]) : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ')
    // Newlines and runs of spaces would render as a ragged row, and a pasted
    // block would otherwise contribute its indentation to the name.
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= MAX_LENGTH) return text;

  // Cut on a word boundary when there is one near the end, so a title does not
  // stop mid-word; fall back to a hard cut for text with no spaces at all.
  const clipped = text.slice(0, MAX_LENGTH);
  const space = clipped.lastIndexOf(' ');
  return (space > MAX_LENGTH * 0.6 ? clipped.slice(0, space) : clipped).trimEnd() + '…';
}

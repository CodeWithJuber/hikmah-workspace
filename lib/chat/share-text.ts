/** The prose of a stored message, for read-only surfaces like share links.
 *
 * Tool calls and other structured parts are not prose: they stay out rather
 * than being dumped raw, because a shared reader has no execution context in
 * which they mean anything.
 */
export function sharedMessageText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim())
      texts.push(typed.text);
  }
  return texts.join('\n\n');
}

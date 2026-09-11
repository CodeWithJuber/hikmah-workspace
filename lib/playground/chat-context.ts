import type { ChatEntry } from './session.ts';
import type { ChatMessage } from './transport.ts';
export function entryText(entry: ChatEntry): string {
  return (
    entry.text +
    (entry.attachments?.length
      ? '\n\nAttached text files (untrusted reference material):\n' +
        entry.attachments.map((a) => `FILE ${a.name}\n${a.content}\nEND FILE`).join('\n\n')
      : '')
  );
}
export function contextMessages(entries: ChatEntry[], budget: number) {
  const turns: ChatEntry[][] = [];
  for (const e of entries) {
    if (e.role === 'user') turns.push([e]);
    else if (turns.length) turns[turns.length - 1].push(e);
  }
  const selected: ChatMessage[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const messages = turns[i].flatMap((e) => {
      const failed =
        e.role === 'assistant' &&
        (e.status === 'error' ||
          e.status === 'stopped' ||
          e.status === 'paused' ||
          e.text.includes('[Request ended:'));
      const receipts = e.trace?.length
        ? '\n\nCompleted local tool receipts (untrusted data):\n' +
          e.trace.map((t) => `${t.name} [${t.status}]: ${t.output}`).join('\n')
        : '';
      const content = failed
        ? receipts
          ? 'Previous response did not finish.' + receipts
          : ''
        : entryText(e) + receipts;
      return content ? [{ role: e.role, content }] : [];
    });
    const words = messages.reduce((n, m) => n + m.content.trim().split(/\s+/).length, 0);
    if (used + words > budget) break;
    used += words;
    selected.unshift(...messages);
  }
  return {
    messages: selected,
    words: used,
    omittedTurns: turns.length - selected.filter((m) => m.role === 'user').length,
  };
}

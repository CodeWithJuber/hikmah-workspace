import type { UIMessage } from 'ai';
import { partToolName, toolProvenance } from '../../lib/chat/working.ts';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const DRAFT_LIMIT = 64_000;
const DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const conversationDraftKey = (id: string) => `hikmah:chat-draft:v1:${encodeURIComponent(id)}`;

/** Session storage keeps unsent text across reloads without sending it to the server. */
export function readConversationDraft(storage: DraftStorage, id: string, now = Date.now()): string {
  try {
    const value: unknown = JSON.parse(storage.getItem(conversationDraftKey(id)) ?? 'null');
    if (!value || typeof value !== 'object') return '';
    const draft = value as { text?: unknown; savedAt?: unknown };
    if (
      typeof draft.text !== 'string' ||
      draft.text.length > DRAFT_LIMIT ||
      typeof draft.savedAt !== 'number' ||
      !Number.isFinite(draft.savedAt) ||
      now - draft.savedAt > DRAFT_MAX_AGE ||
      draft.savedAt > now + 60_000
    ) {
      storage.removeItem(conversationDraftKey(id));
      return '';
    }
    return draft.text;
  } catch {
    return '';
  }
}

export function writeConversationDraft(
  storage: DraftStorage,
  id: string,
  text: string,
  now = Date.now(),
): boolean {
  try {
    if (!text) storage.removeItem(conversationDraftKey(id));
    else if (text.length > DRAFT_LIMIT) {
      storage.removeItem(conversationDraftKey(id));
      return false;
    } else storage.setItem(conversationDraftKey(id), JSON.stringify({ text, savedAt: now }));
    return true;
  } catch {
    // Blocked storage or a full quota must never stop somebody typing.
    return false;
  }
}

export function transcriptMarkdown(messages: readonly UIMessage[]): string {
  const turns = messages.map((message) => {
    const label =
      message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Hikmah' : 'System';
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n')
      .trim();
    const attachments = message.parts
      .filter((part) => part.type === 'file')
      .map((part) => `Attachment: ${part.filename ?? part.mediaType ?? 'File'}`);
    const sources = message.parts
      .filter((part) => part.type === 'source-url')
      .filter((part) => /^https?:\/\//i.test(part.url))
      .map((part) => `- ${part.title ?? 'Source'}: ${part.url}`);
    const comparison = message.parts
      .filter((part) => part.type === 'data-compare')
      .flatMap((part) => {
        const data = ('data' in part ? part.data : undefined) as { text?: unknown } | undefined;
        return typeof data?.text === 'string' && data.text.trim()
          ? [`### Comparison without tools\n\n${data.text.trim()}`]
          : [];
      });
    return [
      `## ${label}`,
      text || '(No text response)',
      ...attachments,
      ...comparison,
      ...(sources.length ? ['### Sources', sources.join('\n')] : []),
    ].join('\n\n');
  });
  // Never export tool inputs, secret references, reasoning, or inline file data.
  return '# Hikmah conversation\n\n' + turns.join('\n\n---\n\n') + '\n';
}

export type FailureAction = 'configure' | 'reload' | 'reconnect' | 'retry';

export function failureAction(message: string): FailureAction {
  if (
    /No API key|API key.*(?:invalid|missing)|(?:invalid|missing).*API key|Missing Authentication header|authentication.*(?:required|missing|failed)|unauthorized/i.test(
      message,
    )
  )
    return 'configure';
  // The model is blocked by the "Free models only" setting — retrying won't
  // help. The fix is in Settings (turn it off or pick a free model).
  if (/Free models only/i.test(message)) return 'configure';
  if (/waiting for you|waiting for your answer|Reload the conversation/i.test(message))
    return 'reload';
  if (
    /Failed to fetch|NetworkError|network (?:error|request)|fetch failed|connection (?:lost|closed)|could not be read/i.test(
      message,
    )
  )
    return 'reconnect';
  return 'retry';
}

const ACTIVE_LABELS: Record<string, string> = {
  search_web: 'Searching the web',
  read_webpage: 'Reading a source',
  deep_research: 'Researching in parallel',
  read_file: 'Reading a file',
  write_file: 'Writing a file',
  run_javascript: 'Running JavaScript',
  sandbox_run: 'Running code',
  bash: 'Running a command',
  research_quran: 'Checking the Qur’an index',
};

/** Progress comes only from received run parts; no timers or invented percentages. */
export function currentRunActivity(message?: UIMessage): { label: string; completed: number } {
  const tools = (message?.role === 'assistant' ? message.parts : []).filter(
    (part) => part.type.startsWith('tool-') || part.type === 'dynamic-tool',
  );
  const completed = tools.filter(
    (part) => 'state' in part && part.state === 'output-available',
  ).length;
  if (tools.some((part) => 'state' in part && part.state === 'approval-requested'))
    return { label: 'Waiting for your approval', completed };
  const active = tools.findLast(
    (part) =>
      'state' in part && (part.state === 'input-available' || part.state === 'input-streaming'),
  );
  if (active) {
    const { server, tool } = toolProvenance(partToolName(active));
    return {
      label:
        tool === 'ask_user'
          ? 'Waiting for your answer'
          : server
            ? `Using ${server} · ${tool.replace(/_/g, ' ')}`
            : (ACTIVE_LABELS[tool] ?? `Running ${tool.replace(/_/g, ' ')}`),
      completed,
    };
  }
  const writing =
    message?.role === 'assistant' &&
    message.parts.some((part) => part.type === 'text' && part.text.trim());
  return { label: writing ? 'Writing response' : 'Waiting for the model', completed };
}

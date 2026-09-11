'use client';
/** The chat surface, driven by the server run at /api/chat.
 *
 * The browser no longer owns the agent loop: it sends a message and renders the
 * stream. useChat owns the optimistic insert, the streaming reassembly, the
 * status machine and abort, all of which this app previously hand-rolled.
 */
import { useCallback, useMemo } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { MessageParts } from './message-parts';

export type ChatViewProps = {
  /** Stable id so a reload re-attaches to the same conversation. */
  id: string;
  /** Everything the server needs to pick a model; the key never comes from here. */
  run: {
    baseUrl: string;
    model: string;
    freeOnly: boolean;
    apiKeySecret?: string;
    instructions: string;
    maxSteps?: number;
    disabledTools?: string[];
  };
  /** Shown when the conversation is empty. */
  empty?: React.ReactNode;
};

export function ChatView({ id, run, empty }: ChatViewProps) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        // Only the run configuration travels with each turn. The conversation
        // itself is already in `messages`, and the provider key is resolved
        // server-side from a saved secret name.
        prepareSendMessagesRequest: ({ messages }) => ({ body: { ...run, messages } }),
      }),
    [run],
  );

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    id,
    transport,
  });

  const busy = status === 'submitted' || status === 'streaming';

  const submit = useCallback(
    ({ text }: { text?: string }) => {
      const trimmed = (text ?? '').trim();
      if (!trimmed || busy) return;
      void sendMessage({ text: trimmed });
    },
    [busy, sendMessage],
  );

  return (
    <div className="chat-view">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 && empty}
          {messages.map((message) => (
            <MessageParts key={message.id} message={message} status={status} />
          ))}
          {/* The answer region is announced while a run is in progress, so a
              screen reader learns that work is happening and when it lands. */}
          <div aria-live="polite" className="sr-only">
            {busy ? 'Working on your request.' : ''}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {error && (
        <div className="chat-error" role="alert">
          <p>{error.message}</p>
          <button type="button" onClick={() => void regenerate()}>
            Try again
          </button>
        </div>
      )}

      <PromptInput onSubmit={submit}>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask anything, or describe what to build." />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools />
          {/* Doubles as Stop while a run is in flight. */}
          <PromptInputSubmit status={status} onClick={busy ? () => void stop() : undefined} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

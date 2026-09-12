'use client';
/** The chat surface, driven by a run that belongs to the server.
 *
 * The browser owns neither the agent loop nor the run: it posts a message and
 * tails a replayable log. useChat owns the optimistic insert, the streaming
 * reassembly, the status machine and abort, all of which this app previously
 * hand-rolled; the durable transport owns queueing, resuming and cancelling.
 *
 * What that buys, and what the old surface could not do: close the tab
 * mid-answer, come back, and the answer is still being written.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { cancelRun, createDurableChatTransport } from '@/lib/chat/durable-transport';
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
    /** An agent's allowlist over the built-in tools. */
    enabledTools?: string[];
  };
  /** The stored transcript, loaded before this mounts. useChat captures it when
   * the conversation is created, so it cannot be supplied later. */
  initialMessages?: UIMessage[];
  /** Called when a run settles, so a conversation list can catch up. */
  onSettled?: () => void;
  /** Shown when the conversation is empty. */
  empty?: React.ReactNode;
  /** Offered on an empty conversation. Sent as written rather than dropped in
   * the composer: a starter is a question someone already decided to ask. */
  starters?: string[];
  /** The models the provider offers. Empty while the catalog is loading, or
   * when the provider does not publish one. */
  models?: { id: string; label: string }[];
  /** Applies from the next turn, which is why it is not part of `run`: an
   * answer already written was written by the model that wrote it. */
  onModel?: (model: string) => void;
};

export function ChatView({
  id,
  run,
  initialMessages,
  onSettled,
  empty,
  starters,
  models,
  onModel,
}: ChatViewProps) {
  // A lazy initial state rather than useMemo: this must be created exactly
  // once, and useMemo is a cache React is free to discard, not a guarantee.
  //
  // The transport holds the live configuration and the run in flight, rather
  // than this component holding them: useChat captures the transport into its
  // Chat instance on first render and only replaces it when the conversation id
  // changes, so anything the view kept would never reach the instance actually
  // sending the requests.
  const [transport] = useState(() => createDurableChatTransport({ config: run }));
  const { messages, sendMessage, status, stop, error, regenerate, addToolApprovalResponse } =
    useChat({
      id,
      transport,
      messages: initialMessages,
      // Rejoin an answer that was still being written when this tab last left.
      resume: true,
      // A tool that needs the owner's say-so pauses the run mid-step. Once every
      // pending request on the last message has an answer, the turn is sent back
      // automatically; without this the owner would answer the card and then
      // have to nudge the conversation by hand for anything to happen.
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });

  // Compare answers the same question a second time with no tools, to show what
  // the agent's machinery is actually buying. Held here rather than in the run
  // configuration because it is a per-turn choice, not a setting.
  const [compare, setCompare] = useState(false);
  useEffect(() => {
    transport.setConfig({ ...run, compare: compare ? {} : undefined });
  }, [transport, run, compare]);

  const busy = status === 'submitted' || status === 'streaming';

  // Report the edge, not the state: firing on every render while idle would
  // refetch the conversation list forever.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) onSettled?.();
    wasBusy.current = busy;
  }, [busy, onSettled]);

  // Two halves, and both are needed: stop() ends this tab's stream, and the
  // cancel aborts the provider call the worker is still driving. Without the
  // second, the run would finish into the log with nobody watching.
  const halt = useCallback(() => {
    const runId = transport.activeRun();
    void stop();
    if (runId) void cancelRun(runId);
  }, [transport, stop]);

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
          {messages.length === 0 && (
            <div className="chat-welcome">
              {empty}
              {!!starters?.length && (
                <div className="chat-starters">
                  {starters.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => submit({ text: prompt })}>
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((message, index) => (
            <MessageParts
              key={message.id}
              message={message}
              status={status}
              onApproval={addToolApprovalResponse}
              // Only the last answer, and only once the run has settled:
              // regenerating anything earlier would discard what came after it.
              onRegenerate={
                !busy && message.role === 'assistant' && index === messages.length - 1
                  ? () => void regenerate()
                  : undefined
              }
            />
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
          <PromptInputTools>
            {!!models?.length && (
              <PromptInputSelect value={run.model} onValueChange={onModel}>
                <PromptInputSelectTrigger className="chat-model-select">
                  <PromptInputSelectValue placeholder={run.model} />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {models.map((model) => (
                    <PromptInputSelectItem key={model.id} value={model.id}>
                      {model.label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
            <label className="chat-compare-toggle">
              <input
                type="checkbox"
                checked={compare}
                onChange={(event) => setCompare(event.target.checked)}
              />
              Compare without tools
            </label>
          </PromptInputTools>
          {/* Doubles as Stop while a run is in flight. */}
          <PromptInputSubmit status={status} onClick={busy ? halt : undefined} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

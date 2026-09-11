'use client';
/** Renders one assistant or user message as its ordered parts.
 *
 * AI SDK 7 models a message as a list of typed parts rather than a string, so
 * tool calls, reasoning and sources interleave with the text in the order they
 * actually happened. The switch below is deliberately exhaustive and ends in a
 * `default` branch: the SDK adds part types between minor versions, and an
 * unhandled one must degrade to something visible rather than vanish.
 */
import { isToolUIPart, type UIMessage } from 'ai';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/** Sources are collected across the message so citations render as one list. */
function sourceParts(message: UIMessage) {
  return message.parts.filter(
    (part) => part.type === 'source-url' || part.type === 'source-document',
  );
}

export function MessageParts({ message, status }: { message: UIMessage; status: ChatStatus }) {
  const streaming = status === 'streaming';
  const sources = sourceParts(message);

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => {
          const key = message.id + '-' + index;

          if (part.type === 'text')
            return (
              <MessageResponse key={key} isAnimating={streaming} dir="auto">
                {part.text}
              </MessageResponse>
            );

          if (part.type === 'reasoning')
            return (
              <Reasoning key={key} isStreaming={part.state === 'streaming'}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );

          // isToolUIPart covers both declared tools and dynamic ones, so the
          // two share a branch; only the header needs to distinguish them.
          if (isToolUIPart(part))
            return (
              <Tool key={key}>
                {part.type === 'dynamic-tool' ? (
                  <ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} />
                ) : (
                  <ToolHeader type={part.type} state={part.state} />
                )}
                <ToolContent>
                  <ToolInput input={part.input} />
                  {/* errorText and output are mutually exclusive; the component
                      shows whichever is present, so a failed tool stays visible
                      in the transcript rather than silently missing. */}
                  <ToolOutput output={part.output} errorText={part.errorText} />
                </ToolContent>
              </Tool>
            );

          // Rendered once, after the parts loop, so repeated citations of the
          // same source do not each open their own list.
          if (part.type === 'source-url' || part.type === 'source-document') return null;

          if (part.type === 'file')
            return (
              <p key={key} className="chat-attachment-note">
                Attached: {part.filename ?? part.mediaType}
              </p>
            );

          // A step boundary in a multi-step run. It carries no content of its
          // own; the tool cards around it already show what happened.
          if (part.type === 'step-start') return null;

          return (
            <details key={key} className="chat-unknown-part">
              <summary>Unrecognised content ({part.type})</summary>
              <pre>{JSON.stringify(part, null, 2)}</pre>
            </details>
          );
        })}

        {sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((part, index) => (
                <a
                  key={message.id + '-source-' + index}
                  href={part.type === 'source-url' ? part.url : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {part.title ?? (part.type === 'source-url' ? part.url : 'Source')}
                </a>
              ))}
            </SourcesContent>
          </Sources>
        )}
      </MessageContent>
    </Message>
  );
}

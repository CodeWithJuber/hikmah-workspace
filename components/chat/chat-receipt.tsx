'use client';
/** What the run actually did, in figures it actually recorded.
 *
 * Not a port of `components/playground/hikmah-receipt.tsx`. That one reports
 * six things and four of them — saved memory, the local context model, a
 * provider review pass, an agent contribution score — are produced by the
 * browser run loop and have no server equivalent at all. Carrying it across
 * would have meant inventing the data, which is the opposite of what a receipt
 * is for.
 *
 * This reports the four the worker writes down: the model, what it cost, how
 * many tools ran, and how many of them failed.
 */
import type { UIMessage } from 'ai';
import { isToolUIPart } from 'ai';
import type { LanguageModelUsage } from 'ai';

type AnswerMetadata = { model?: string; usage?: LanguageModelUsage };

const count = (value: number) => new Intl.NumberFormat('en-US').format(value);

export function ChatReceipt({ message }: { message: UIMessage }) {
  const meta = (message.metadata as AnswerMetadata | undefined) ?? {};
  const tools = message.parts.filter(isToolUIPart);
  const failed = tools.filter(
    (part) => part.state === 'output-error' || part.state === 'output-denied',
  ).length;

  // Nothing recorded and nothing run means nothing worth a line of chrome.
  if (!meta.model && !meta.usage && !tools.length) return null;

  return (
    <p className="chat-receipt" title="Recorded actions, not a measure of quality.">
      {meta.model && <span className="chat-receipt-model">{meta.model}</span>}
      {meta.usage?.totalTokens !== undefined && <span>{count(meta.usage.totalTokens)} tokens</span>}
      {!!tools.length && (
        <span>
          {count(tools.length)} tool call{tools.length === 1 ? '' : 's'}
          {failed > 0 && `, ${count(failed)} unsuccessful`}
        </span>
      )}
      {/* The caveat is still true and still worth saying — these are recorded
          actions, not a measure of whether the answer is any good — but saying
          it under every single answer turned an honest note into furniture.
          It reads once, on hover, where someone wondering what the figures
          mean will look. */}
    </p>
  );
}

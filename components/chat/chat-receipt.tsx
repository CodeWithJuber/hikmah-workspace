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
  // What the prompt carried from the person's memory. The Memory screen has
  // promised "each answer shows which items were used" since before there was
  // a server to make it true; this is where it becomes true.
  const memories = message.parts.find((part) => part.type === 'data-memories') as
    { data?: { used?: unknown[]; conversations?: unknown[] } } | undefined;
  const used = memories?.data?.used?.length ?? 0;
  const recalled = memories?.data?.conversations?.length ?? 0;
  // What the run saved from this turn, in the person's words — or filed for
  // their review. Read from the tool's own result, so the count is what the
  // store actually did rather than what was attempted.
  const remembered = tools.filter(
    (part) =>
      part.type === 'tool-remember' &&
      part.state === 'output-available' &&
      ['saved', 'suggested'].includes(
        String((part.output as { status?: string } | undefined)?.status),
      ),
  ).length;

  // Nothing recorded and nothing run means nothing worth a line of chrome.
  if (!meta.model && !meta.usage && !tools.length && !used && !recalled) return null;

  return (
    <p className="chat-receipt" title="Recorded actions, not a measure of quality.">
      {meta.model && <span className="chat-receipt-model">{meta.model}</span>}
      {meta.usage?.totalTokens !== undefined && <span>{count(meta.usage.totalTokens)} tokens</span>}
      {/* The count of tool calls lives on the working block's header now, which
          also names which sources answered. Two lines counting the same thing
          in different units — "3 steps" here and "2 tool calls" there — was
          exactly the confusion this receipt was supposed to remove. What is
          kept is what the header cannot say: that something did not work. */}
      {used > 0 && (
        <span className="chat-receipt-memories">
          used {count(used)} {used === 1 ? 'memory' : 'memories'}
        </span>
      )}
      {recalled > 0 && (
        <span className="chat-receipt-memories">
          recalled {count(recalled)} earlier {recalled === 1 ? 'conversation' : 'conversations'}
        </span>
      )}
      {remembered > 0 && (
        <span className="chat-receipt-memories">remembered {count(remembered)} — see Memory</span>
      )}
      {failed > 0 && (
        <span className="chat-receipt-failed">
          {count(failed)} tool call{failed === 1 ? '' : 's'} did not succeed
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

import { redactLearningText } from './privacy.ts';
import { MAX_PROMPT_CHARACTERS, MAX_RESPONSE_CHARACTERS } from './types.ts';
import type { CapturedExchange } from './store.ts';

type Part = { type?: string; text?: unknown; state?: string };
type Message = { role?: string; parts?: Part[]; metadata?: { finishReason?: unknown } };

/** Only completed provider text is eligible. Reasoning, tool inputs/outputs,
 * attachments, system prompts and intermediate step prose never enter it. */
export function completedExchange(input: {
  messages: readonly unknown[];
  message: unknown;
  model: string;
  baseUrl: string;
  secrets?: readonly string[];
}): CapturedExchange | null {
  const assistant = input.message as Message | undefined;
  if (
    assistant?.role !== 'assistant' ||
    assistant.metadata?.finishReason !== 'stop' ||
    !Array.isArray(assistant.parts)
  )
    return null;
  if (
    assistant.parts.some(
      (part) =>
        part?.state === 'approval-requested' ||
        (part?.type === 'tool-ask_user' && part.state === 'input-available'),
    )
  )
    return null;
  // A later request can still refer to a file attached several turns ago.
  // Without source-dependency tracking, conservatively exclude that history.
  if (
    input.messages.some(
      (message) =>
        message &&
        typeof message === 'object' &&
        Array.isArray((message as Message).parts) &&
        (message as Message).parts!.some((part) => part?.type === 'file'),
    )
  )
    return null;
  const user = [...input.messages]
    .reverse()
    .find(
      (message) => message && typeof message === 'object' && (message as Message).role === 'user',
    ) as Message | undefined;
  if (!Array.isArray(user?.parts)) return null;
  const text = (parts: Part[]) =>
    parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
      .trim();
  const prompt = text(user.parts);
  const lastStep = assistant.parts.findLastIndex((part) => part?.type === 'step-start');
  const response = text(assistant.parts.slice(lastStep < 0 ? 0 : lastStep + 1));
  if (
    !prompt ||
    !response ||
    prompt.length > MAX_PROMPT_CHARACTERS ||
    response.length > MAX_RESPONSE_CHARACTERS
  )
    return null;
  let provider: string;
  try {
    provider = new URL(input.baseUrl).origin;
  } catch {
    return null;
  }
  const cleanPrompt = redactLearningText(prompt, input.secrets);
  const cleanResponse = redactLearningText(response, input.secrets);
  const cleanModel = redactLearningText(input.model.slice(0, 200), input.secrets);
  return {
    model: cleanModel.text,
    provider,
    prompt: cleanPrompt.text,
    response: cleanResponse.text,
    redactions: [
      ...new Set([
        ...cleanPrompt.redactions,
        ...cleanResponse.redactions,
        ...cleanModel.redactions,
      ]),
    ],
  };
}

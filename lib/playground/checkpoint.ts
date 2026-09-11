import { normalizeReasoningDetails } from './reasoning.ts';
import type { RunCheckpoint } from './agent-runner.ts';
import type { ChatMessage, ToolCall } from './transport.ts';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const count = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1000000;
export function parseCheckpoint(value: unknown): RunCheckpoint | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.messages) ||
    value.messages.length > 256 ||
    !text(value.output, 2000000) ||
    !count(value.requests) ||
    !count(value.toolCount) ||
    !count(value.compactions) ||
    !['ready', 'tools', 'complete'].includes(String(value.phase))
  )
    throw Error('Invalid run checkpoint.');
  let characters = 0;
  const messages: ChatMessage[] = value.messages.map((raw) => {
    if (
      !object(raw) ||
      !['system', 'user', 'assistant', 'tool'].includes(String(raw.role)) ||
      !(raw.content === null || text(raw.content, 2000000))
    )
      throw Error('Invalid checkpoint message.');
    characters += (raw.content as string | null)?.length ?? 0;
    const m: ChatMessage = {
      role: raw.role as ChatMessage['role'],
      content: raw.content as string | null,
    };
    if (raw.role === 'assistant') {
      if (raw.reasoning !== undefined) {
        if (!text(raw.reasoning, 200000)) throw Error('Invalid checkpoint explanation.');
        m.reasoning = raw.reasoning;
        characters += raw.reasoning.length;
      }
      m.reasoning_details = normalizeReasoningDetails(raw.reasoning_details);
      characters += JSON.stringify(m.reasoning_details ?? []).length;
    }
    if (raw.role === 'tool') {
      if (!text(raw.tool_call_id, 65536)) throw Error('Invalid checkpoint tool result.');
      m.tool_call_id = raw.tool_call_id;
    }
    if (text(raw.name, 128)) m.name = raw.name;
    if (raw.tool_calls !== undefined) {
      if (raw.role !== 'assistant' || !Array.isArray(raw.tool_calls) || raw.tool_calls.length > 64)
        throw Error('Invalid checkpoint tool calls.');
      m.tool_calls = raw.tool_calls.map((c) => {
        if (
          !object(c) ||
          c.type !== 'function' ||
          !text(c.id, 65536) ||
          !object(c.function) ||
          !text(c.function.name, 128) ||
          !text(c.function.arguments, 200000)
        )
          throw Error('Invalid checkpoint tool call.');
        characters += c.function.arguments.length;
        return {
          id: c.id,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        };
      });
    }
    return m;
  });
  if (characters > 5000000) throw Error('Run checkpoint is too large.');
  if (
    !Array.isArray(value.pendingCalls) ||
    value.pendingCalls.length > 64 ||
    !count(value.pendingIndex) ||
    (value.pendingIndex as number) > value.pendingCalls.length
  )
    throw Error('Invalid pending run actions.');
  const pendingCalls: ToolCall[] = value.pendingCalls.map((c) => {
    if (!object(c) || !text(c.id, 65536) || !text(c.name, 128) || !text(c.arguments, 200000))
      throw Error('Invalid pending action.');
    return { id: c.id, name: c.name, arguments: c.arguments };
  });
  const recentSignatures = Array.isArray(value.recentSignatures)
    ? value.recentSignatures.filter((s): s is string => text(s, 200000)).slice(-3)
    : [];
  const goal =
    object(value.goal) && value.goal.role === 'user' && text(value.goal.content, 200000)
      ? { role: 'user' as const, content: value.goal.content }
      : (messages.findLast((m) => m.role === 'user') ?? {
          role: 'user' as const,
          content: 'Continue the task.',
        });
  return {
    version: 1,
    messages,
    goal,
    output: value.output,
    requests: value.requests as number,
    toolCount: value.toolCount as number,
    compactions: value.compactions as number,
    pendingCalls,
    pendingIndex: value.pendingIndex as number,
    recentSignatures,
    phase: value.phase as RunCheckpoint['phase'],
  };
}

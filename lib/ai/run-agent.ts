/** Assembles the agent for one run.
 *
 * Shared deliberately: the request-scoped chat route uses it now, and the
 * durable worker will use the same function later, so a run behaves identically
 * whether it is driven by an open tab or resumed by the server.
 */
import { ToolLoopAgent, isStepCount, type LanguageModel } from 'ai';
import { DEFAULT_CONTEXT_CHARACTERS, reduceMessages } from './context.ts';
import { createLanguageModel, type ModelRequest } from './models.ts';
import { deterministicTools, type PlanStep } from './tools/deterministic.ts';
import { researchTools } from './tools/research.ts';
import type { Model } from '../engines/meaning-engine.ts';

/** Ceiling on tool-calling rounds, so a loop cannot run forever unattended. */
export const DEFAULT_MAX_STEPS = 12;

export type RunAgentOptions = {
  provider: ModelRequest;
  instructions: string;
  maxSteps?: number;
  contextCharacters?: number;
  /** Local symbolic model backing interpret_meaning. */
  meaningModel: Model;
  savedSearchKey?: () => Promise<string>;
  onPlan?: (steps: PlanStep[]) => void;
  signal: AbortSignal;
  /** Tool names the owner has switched off for this run. */
  disabledTools?: readonly string[];
  model?: LanguageModel;
};

export function buildRunAgent(options: RunAgentOptions) {
  const disabled = new Set(options.disabledTools ?? []);
  const all = {
    ...researchTools({ savedSearchKey: options.savedSearchKey, signal: options.signal }),
    ...deterministicTools({ model: options.meaningModel, onPlan: options.onPlan }),
  };
  const tools = Object.fromEntries(Object.entries(all).filter(([name]) => !disabled.has(name)));
  const limit = options.contextCharacters ?? DEFAULT_CONTEXT_CHARACTERS;

  return new ToolLoopAgent({
    model: options.model ?? createLanguageModel(options.provider),
    instructions: options.instructions,
    tools,
    stopWhen: isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS),
    prepareStep: ({ messages }) => ({ messages: reduceMessages(messages, limit) }),
  });
}

/** Deterministic tools: arithmetic, planning, the local meaning engine.
 *
 * These never touch the network or the filesystem, so they move to the server
 * unchanged. They call the same engine functions the browser build used; only
 * the argument validation is replaced, because an AI SDK tool validates through
 * its schema rather than through hand-written argument coercion.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createPreset, executePlan, plan, transitionEstimate } from '../../engines/agent-math.ts';
import { predict, type Model } from '../../engines/meaning-engine.ts';
import { arithmetic } from '../../playground/workspace-tools.ts';

export type PlanStep = { step: string; status: 'pending' | 'in_progress' | 'completed' };

export function deterministicTools(options: {
  model: Model;
  onPlan?: (steps: PlanStep[]) => void;
}) {
  return {
    calculate: tool({
      description:
        'Evaluate an arithmetic expression exactly. Use this instead of doing arithmetic in your head whenever a number matters.',
      inputSchema: z.object({ expression: z.string().min(1).max(256) }),
      execute: async ({ expression }) => ({
        expression,
        result: arithmetic(expression),
        method: 'bounded arithmetic parser',
      }),
    }),

    update_plan: tool({
      description:
        'Publish or update the visible task plan. Use it for multi-step work so the reader can see what you are doing. At most one step may be in_progress.',
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              step: z.string().min(1).max(300),
              status: z.enum(['pending', 'in_progress', 'completed']),
            }),
          )
          .min(1)
          .max(20),
      }),
      execute: async ({ steps }) => {
        if (steps.filter((s) => s.status === 'in_progress').length > 1)
          throw Error('At most one step may be in_progress.');
        options.onPlan?.(steps);
        return { steps, visibility: 'public_task_plan' };
      },
    }),

    transition_estimate: tool({
      description:
        'Beta posterior estimate of a success rate from observed successes and failures. Use it rather than asserting a probability.',
      inputSchema: z.object({
        successes: z.number().int().min(0).max(10000),
        failures: z.number().int().min(0).max(10000),
      }),
      execute: async ({ successes, failures }) => transitionEstimate({ successes, failures }),
    }),

    simulate_plan: tool({
      description:
        'Run a local planning simulation for a fixed scenario. This is a simulation only: it performs no external operations and its result is not evidence about the real world.',
      inputSchema: z.object({
        scenario: z.enum(['hosting', 'research', 'document']),
        budget: z.number().min(0).max(30).optional(),
        failAction: z.string().max(80).optional(),
      }),
      execute: async ({ scenario, budget, failAction }) => {
        const preset = createPreset(scenario);
        const problem = { ...preset, budget: budget ?? preset.budget, maxExpansions: 1000 };
        const result = plan(problem);
        const execution =
          result.status === 'found'
            ? executePlan(problem, result.actionIds, {
                outcomes: failAction ? { [failAction]: 'failure' as const } : {},
              })
            : null;
        return { mode: 'local_simulation', externalOperations: 0, plan: result, execution };
      },
    }),

    interpret_meaning: tool({
      description:
        "Parse a sentence with this project's local symbolic meaning model. A controlled parser, not a language model: unknown constructions return no match, and that is a real answer.",
      inputSchema: z.object({
        text: z.string().min(1).max(512),
        language: z.string().min(1).max(24),
      }),
      execute: async ({ text, language }) => predict(options.model, language, text),
    }),
  };
}

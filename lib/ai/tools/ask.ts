/** A run that stops and asks, rather than guessing.
 *
 * Deliberately a tool with **no `execute`**. That is the whole design: the
 * answer comes from a person, and by the time `execute` would run there is
 * nobody listening — the request that started the run has long since returned.
 * With no body, the SDK leaves the call in `input-available` and the stream
 * ends there. The worker records `waiting_client`, the browser renders the
 * question, and the answer arrives as the tool's output through the same route
 * that resumes an approval.
 *
 * The alternative — expressing this as an approval — was tried and does not
 * work: `ToolExecutionOptions` hands `execute` the call and nothing else, so
 * there is no way for what the owner typed to reach the tool. An approval can
 * carry yes or no. A question needs the answer.
 */
import { tool } from 'ai';
import { z } from 'zod';

export function askTools() {
  return {
    ask_user: tool({
      description:
        'Ask the person a question and wait for their answer before going on. Use it when a choice would change the work and guessing would waste it — which file they meant, which of two approaches, a value only they know. Do not use it for anything you can look up or work out. Offer options when the choice is between a few known answers; they can always write their own instead.',
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .max(500)
          .describe('One question, in plain words. Say why you are asking if it is not obvious.'),
        options: z
          .array(z.string().min(1).max(120))
          // Two or more, or none at all. A single option is not a choice — it is
          // a yes/no dressed as one, and the card would offer one button beside
          // a free-text box. The kernel's own question schema enforced this
          // before it was retired.
          .min(2)
          .max(6)
          .optional()
          .describe('Answers to offer. Leave it out when the answer is open-ended.'),
      }),
      // No execute. See the note above: the person is the implementation.
    }),
  };
}

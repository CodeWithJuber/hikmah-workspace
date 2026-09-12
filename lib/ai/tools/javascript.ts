/** JavaScript in an isolated interpreter, in this process.
 *
 * Distinct from `sandbox_run`, and both are worth having. That one runs in the
 * workbench container: a real machine with a filesystem and a network, which is
 * what you want for installing something or reaching an API, and which is why
 * it asks before running. This one is QuickJS compiled to WebAssembly with no
 * host bindings at all — no filesystem, no network, no clock beyond Date — so
 * there is nothing to approve and it works on a deployment with no workbench.
 *
 * It is the same interpreter the workspace surface uses, through the same
 * module and the same limits, so a program behaves identically on both. The
 * compiled module is cached by `quickJsModule`, which matters here: the worker
 * is long-lived, and booting WebAssembly per call would spend the program's own
 * time budget before it ran.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { evaluateJavascript } from '../../playground/sandbox-core.ts';

export function javascriptTools() {
  return {
    run_javascript: tool({
      description:
        'Run JavaScript and get back what it printed and what it evaluated to. Isolated: no network, no filesystem, no access to this machine. Use it for calculation, parsing, generating or checking data — anything where running the code is more reliable than reasoning about it. Print with console.log. Limits: 40,000 characters of source, 3 seconds, 24,000 characters of output.',
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .max(40000)
          .describe('The program. Use console.log to show your working.'),
      }),
      // Returned rather than thrown, like the media tools: a program that
      // throws is a result the model can read and correct, not a reason to end
      // the run. Only a failure of the interpreter itself reaches the catch.
      execute: async ({ code }) => {
        try {
          return await evaluateJavascript(code);
        } catch (error) {
          return {
            runtime: 'QuickJS · isolated JavaScript',
            stdout: '',
            result: '',
            error: error instanceof Error ? error.message : 'The interpreter could not start.',
          };
        }
      },
    }),
  };
}

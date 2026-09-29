/** One deny-by-default dispatch for every tool call a run can make.
 *
 * The agent used to pass the AI SDK a *record* of per-tool approval policies.
 * A tool with no entry fell back to the SDK's `not-applicable` and ran with no
 * policy decision at all — allow by omission: a tool added to the set without
 * a gate entry silently ran. This module is the single choke point instead:
 * the SDK's function form of `toolApproval` is invoked for *every* tool call,
 * and the default here is denial. A tool runs only through an explicit rule:
 * a per-tool gate, or membership in the explicitly allowed safe set.
 *
 * The safe set is not a second omission. It is the policy's explicit,
 * auditable answer for tools that neither run code on a machine nor call a
 * server: they were already ungated by deliberate per-tool decisions, and the
 * decider makes that decision visible in one place rather than scattered
 * across "no entry".
 */

export type ToolGate = 'approved' | 'user-approval' | 'denied';

/** What the policy decided, and why — the reason travels with denials and
 * approval requests so the model (and the approver) sees it. */
export type PolicyDecision = {
  gate: ToolGate;
  reason?: string;
};

/** One tool's rule, evaluated per call with the call's input. */
export type PolicyFn = (input: unknown) => PolicyDecision | Promise<PolicyDecision>;

/** The decider: every tool call a run makes goes through this. */
export type ToolDecider = (toolName: string, input: unknown) => Promise<PolicyDecision>;

export function createToolPolicy(options: {
  /** Per-tool rules for tools that reach a machine or a server. */
  gates: Record<string, PolicyFn>;
  /** Tools explicitly allowed without asking, by policy rather than omission. */
  safeTools: Iterable<string>;
  /** Why the safe set is safe, attached to its approvals. */
  safeReason: string;
}): ToolDecider {
  const safe = new Set(options.safeTools);
  return async (toolName, input) => {
    const gate = options.gates[toolName];
    if (gate) {
      try {
        return await gate(input);
      } catch {
        // A gate that cannot answer — a store read that failed, a list that
        // could not load — fails closed to denial, never to a silent yes.
        // The failure itself stays out of the reason: it goes to the model.
        return {
          gate: 'denied',
          reason: `The permission check for "${toolName}" failed, so it was not run.`,
        };
      }
    }
    if (safe.has(toolName)) return { gate: 'approved', reason: options.safeReason };
    // Deny by default: a tool with no explicit rule never runs.
    return {
      gate: 'denied',
      reason: `No permission rule covers "${toolName}", so it was not run.`,
    };
  };
}

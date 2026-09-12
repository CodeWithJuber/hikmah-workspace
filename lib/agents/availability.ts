/** Which built-in tools this deployment can actually offer.
 *
 * A menu that lists `bash` on a box with no workbench is a lie: switching it on
 * changes nothing, and the model is never given the tool. The run builder
 * already makes these decisions (`lib/ai/run-agent.ts` omits whole tool
 * families when their context is absent) — this states the same rules in one
 * pure place so the UI can say why something is greyed out.
 */

import { BUILT_IN_TOOLS } from './templates.ts';

/** What the deployment has, as the run builder sees it. */
export type Capabilities = {
  /** The workbench sidecar, which hosts the shell and reaches SSH hosts. */
  workbench: boolean;
};

/** Tools that exist only when the workbench does. */
const WORKBENCH_TOOLS = new Set(['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts']);

const WORKBENCH_REASON = 'Needs the workbench container, which this deployment is not running.';

export type ToolAvailability = { name: string; available: boolean; reason?: string };

/**
 * Every built-in tool, and whether it can run here.
 *
 * Media generation is deliberately not gated. Its key is resolved per run —
 * from the provider when the endpoint is one that carries it, from the
 * environment otherwise — so no answer given here would be true for every run,
 * and the tool reports its own missing key in terms the person can act on.
 */
export function toolAvailability(capabilities: Capabilities): ToolAvailability[] {
  return BUILT_IN_TOOLS.map((name) =>
    WORKBENCH_TOOLS.has(name) && !capabilities.workbench
      ? { name, available: false, reason: WORKBENCH_REASON }
      : { name, available: true },
  );
}

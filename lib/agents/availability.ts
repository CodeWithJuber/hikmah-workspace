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
  /** Whether this person's plan includes generating pictures and speech.
   * Absent means yes, which is what every caller written before the media
   * entitlement existed meant. */
  media?: boolean;
  /** Whether this person's plan lets a run reach a machine. Absent means the
   * deployment decides alone, as it did before tiers. */
  execution?: boolean;
};

/** Tools that exist only when the workbench does. */
const WORKBENCH_TOOLS = new Set(['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts']);

const WORKBENCH_REASON = 'Needs the workbench container, which this deployment is not running.';

/** Tools the paid plan includes and the free one does not. */
const MEDIA_TOOLS = new Set(['generate_image', 'generate_speech']);
const MEDIA_REASON =
  'Included with Pro. Generating pictures and speech runs on the hosted account.';
/** The shell and SSH are the operator's until execution is per-tenant: the
 * workbench is one container with one /workspace volume shared by everyone. */
const EXECUTION_REASON = 'Runs on the workspace machine, which is the operator’s alone for now.';

export type ToolAvailability = { name: string; available: boolean; reason?: string };

/**
 * Every built-in tool, and whether it can run here.
 *
 * Two different kinds of "no", and the difference is the whole point of saying
 * anything: the deployment cannot do this (no workbench), or your plan does not
 * include it. A switch greyed out with no reason reads as a fault; one that
 * names the plan reads as a price. The deployment's own limits are checked
 * first, because a tool the box cannot run is not a thing to sell.
 */
export function toolAvailability(capabilities: Capabilities): ToolAvailability[] {
  return BUILT_IN_TOOLS.map((name) => {
    if (WORKBENCH_TOOLS.has(name)) {
      if (!capabilities.workbench) return { name, available: false, reason: WORKBENCH_REASON };
      if (capabilities.execution === false)
        return { name, available: false, reason: EXECUTION_REASON };
    }
    if (MEDIA_TOOLS.has(name) && capabilities.media === false)
      return { name, available: false, reason: MEDIA_REASON };
    return { name, available: true };
  });
}

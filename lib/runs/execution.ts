/** Whether a run may reach a machine.
 *
 * Its own file for the same reason `media.ts` is: `service.ts` reaches the
 * storage handle, the MCP manager and the agent builder, so it cannot be
 * imported by a test — and this decision is the one that separates "answers
 * questions" from "runs commands on the deployment", which is worth being able
 * to call directly.
 */

/** The one field of a run's config this reads. */
export type ExecutionConfig = {
  /** Whether this run may reach a machine: the workbench shell and SSH.
   *
   * Decided at creation rather than per step, so a plan change mid-run cannot
   * widen a run already in flight. */
  execution?: boolean;
};

/**
 * May this run reach a machine?
 *
 * **Absent means no**, which is the one place this deliberately differs from
 * `media.ts`, where absent means yes. The two are not the same kind of
 * question: the cost of wrongly granting media is a bill, and the cost of
 * wrongly granting execution is a shell on the deployment. The old reading was
 * `config.execution !== false`, so a config that simply did not carry the key —
 * a malformed write, a row from before tiers existed, anything that lost the
 * field on its way through — was granted a shell.
 *
 * Every route that creates a run sets the field explicitly
 * (`app/api/conversations/[id]/runs`, `.../tasks`, `app/api/agents`), so in
 * practice this only changes rows written before the field existed, and it
 * changes them in the safe direction: they lose execution rather than keep it.
 */
export function executionAllowed(config: ExecutionConfig): boolean {
  return config.execution === true;
}

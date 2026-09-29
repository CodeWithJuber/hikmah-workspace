/** The picker's and the panel's shared agent categories.
 *
 * Agents carry no category field, so both surfaces derive one from the name
 * and description with the same keyword rules. One module, so the picker's
 * chips and the panel's rows can never disagree about what an agent is.
 */
export const CATEGORY_ORDER = ['Code', 'Research', 'Ops', 'Writing', 'General', 'Custom'] as const;
export type AgentCategory = (typeof CATEGORY_ORDER)[number];

const CATEGORY_RULES: { label: AgentCategory; re: RegExp }[] = [
  { label: 'Code', re: /code|dev|engineer|build|program/i },
  { label: 'Research', re: /research|search|analy|study|investigat/i },
  { label: 'Ops', re: /ops|server|deploy|operation|infra/i },
  { label: 'Writing', re: /writ|content|copy|blog|draft/i },
];

/** The first matching rule wins; the fallback splits built-ins from customs. */
export function agentCategory(agent: {
  name: string;
  description?: string | null;
  builtIn: boolean;
}): AgentCategory {
  const hay = `${agent.name} ${agent.description ?? ''}`;
  for (const rule of CATEGORY_RULES) if (rule.re.test(hay)) return rule.label;
  return agent.builtIn ? 'General' : 'Custom';
}

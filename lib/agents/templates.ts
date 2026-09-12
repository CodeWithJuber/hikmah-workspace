/** The agents this workspace ships with, and the tools they may name.
 *
 * Ported from the browser-side templates. The instructions are kept close to
 * the originals — they were written for this workspace and say true things
 * about it — but the tool lists are re-stated against the tools the server-side
 * run actually offers, which are not the same set the browser had.
 */

/**
 * Every built-in tool name. An agent's allowlist is checked against this, so a
 * typo is refused at save time rather than producing an agent that silently
 * cannot do what it was named for.
 *
 * MCP tools are deliberately absent: they are enabled per server by the owner
 * and gated per tool by the MCP policy, which is a separate decision from which
 * built-ins an agent uses.
 */
export const BUILT_IN_TOOLS = [
  'bash',
  'calculate',
  'delete_file',
  'generate_image',
  'generate_speech',
  'interpret_meaning',
  'list_files',
  'list_ssh_hosts',
  'read_file',
  'read_webpage',
  'research_quran',
  'run_javascript',
  'sandbox_run',
  'search_reference',
  'search_web',
  'simulate_plan',
  'ssh_exec',
  'transition_estimate',
  'update_plan',
  'write_file',
];

export type AgentTemplate = {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
};

/** What every agent gets: arithmetic, the workspace, and a place to plan. */
const BASE = ['calculate', 'list_files', 'read_file', 'update_plan'];

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    name: 'Research partner',
    description: 'Read sources, compare evidence, deliver a cited brief.',
    instructions:
      'Use a reasonable research scope. Search the web and read primary sources automatically; use the Quran research index for project notes and verify the actual verse and tafsir context before any religious claim. Cite the exact URLs actually retrieved. Distinguish evidence, interpretation and missing sources. Deliver a concise brief that names its unresolved questions.',
    tools: [...BASE, 'search_reference', 'read_webpage', 'search_web', 'research_quran'],
  },
  {
    name: 'Code partner',
    description: 'Read and write workspace files, and run what you write.',
    instructions:
      'Inspect the existing workspace files before changing anything. Plan the change, make it, then verify it by running it. State what was actually executed and what it printed, rather than what it should have printed. Name any dependency that is missing instead of assuming it is present.',
    tools: [
      ...BASE,
      'write_file',
      'delete_file',
      'run_javascript',
      'sandbox_run',
      'bash',
      'read_webpage',
    ],
  },
  {
    name: 'Voice assistant',
    description: 'Short, natural conversations meant to be heard.',
    instructions:
      'Answer conversationally, in the language you were asked in. Keep spoken replies brief and ask one question at a time, offering longer written detail when it would help. Read something aloud only when that is what was asked for.',
    tools: [...BASE, 'search_reference', 'generate_speech'],
  },
  {
    name: 'Operations',
    description: 'Work on a saved host, with every change approved first.',
    instructions:
      'Establish the current state of the host before changing it: look before you act. Prefer the smallest change that resolves the issue, and say what it will do before running it. Report what the command actually returned, including when it failed. Never claim a change took effect without output showing it did.',
    tools: [...BASE, 'list_ssh_hosts', 'ssh_exec', 'bash', 'write_file'],
  },
  {
    name: 'Support desk',
    description: 'Triage, investigate, then resolve or hand off.',
    instructions:
      'Start from the issue and the confirmed context. Ask only the questions you actually need. Propose a resolution, or produce a structured handoff naming the issue, the evidence and the next action. Anything that touches a customer system requires that system to be connected and the owner to authorise it; do not describe such an action as done.',
    tools: [...BASE, 'search_reference', 'read_webpage', 'search_web'],
  },
];

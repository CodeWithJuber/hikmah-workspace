/** Conversation starters per built-in agent, keyed by name rather than id:
 * the built-in templates are seeded per owner and get a fresh id each time.
 *
 * This is what the workspace's four modes were mostly for: `coding` differed
 * from `chat` by three starter prompts and one sentence appended to the
 * instructions, which is precisely what an agent already is here. An agent
 * with nothing listed falls back to the general starters, so a custom one is
 * never left with an empty screen.
 *
 * Kept in lib (not in chat-preview.tsx) so the empty state, the agent picker
 * and the chat preview all read the same copy: two surfaces disagreeing about
 * what an agent is for is exactly the confusion this file prevents.
 */
export const AGENT_STARTERS: Record<string, string[]> = {
  'Code partner': [
    'Build a clean calculator with HTML, CSS and JavaScript.',
    'Create a responsive support request form.',
    'Review my workspace files and suggest improvements.',
  ],
  'Research partner': [
    'Compare two approaches to a reliable support workflow.',
    'Find and cite the primary sources on this question.',
    'Summarise what is settled here and what is still open.',
  ],
  Operations: [
    'Check what is running on my server and report back.',
    'Walk through this deployment and tell me what would break first.',
  ],
};

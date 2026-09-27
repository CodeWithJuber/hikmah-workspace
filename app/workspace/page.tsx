import { redirect } from 'next/navigation';

/**
 * The old workspace shell is gone — its hash-routed screens are real routes
 * now. This address stays working for bookmarks and lands on Agents, which is
 * also where unknown hashes used to land; auth happens on /agents.
 */
export default function WorkspacePage() {
  redirect('/agents');
}

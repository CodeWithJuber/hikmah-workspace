import Playground from '@/components/playground/shell';
import { requireChatGPTUser } from '../chatgpt-auth';

export const dynamic = 'force-dynamic';

/**
 * The workspace: the chat that runs in the tab, plus every screen around it —
 * coding, agents, compare, tools, connections, the terminal, memory, learning,
 * the research labs, settings, the owner console and the model connection.
 *
 * Moved here from `/` so that `/` can be the durable chat, whose runs belong to
 * the server. Nothing about this shell changed in the move: its sub-page lives
 * in the URL hash (`#/admin/media`, `#/terminal`), which `workspaceDestination`
 * reads without knowing anything about the pathname, so every one of those
 * addresses resolves here exactly as it did at the root.
 */
export default async function WorkspacePage() {
  await requireChatGPTUser('/workspace');
  return <Playground />;
}

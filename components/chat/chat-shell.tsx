'use client';
/** The chat page: conversations on the left, the workspace on the right. */
import { useCallback, useState } from 'react';
import { ChatPreview } from './chat-preview';
import { ConversationList } from './conversation-list';
import { FilesPanel } from './files-panel';
import { AgentsPanel, type Agent } from './agents-panel';

export function ChatShell({ conversationId }: { conversationId: string }) {
  // Bumped when a run settles. A conversation is created by its first message
  // and titled from it, so without this the list would keep showing the state
  // it had before the owner said anything.
  const [revision, setRevision] = useState(0);
  const settled = useCallback(() => setRevision((value) => value + 1), []);

  const [tab, setTab] = useState<'files' | 'agents'>('files');
  // Applies from the next turn on, not retrospectively: an agent chosen now
  // cannot change an answer already written.
  const [agent, setAgent] = useState<Agent | null>(null);

  return (
    <div className="chat-shell">
      <ConversationList activeId={conversationId} revision={revision} />
      {/* Keyed by conversation so moving between them rebuilds the chat rather
          than showing the previous transcript under the new id: useChat holds
          its messages per instance. */}
      <ChatPreview
        key={conversationId}
        conversationId={conversationId}
        agent={agent}
        onSettled={settled}
      />

      <aside className="workspace-panel" aria-label="Workspace">
        <div className="workspace-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'files'}
            onClick={() => setTab('files')}
          >
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agents'}
            onClick={() => setTab('agents')}
          >
            Agents
          </button>
        </div>
        {/* Files reload on the same signal as the conversation list: a run that
            just finished may have written one, and a panel showing the state
            from before it is worse than no panel. */}
        {tab === 'files' ? (
          <FilesPanel revision={revision} />
        ) : (
          <AgentsPanel activeId={agent?.id ?? null} onPick={setAgent} />
        )}
      </aside>
    </div>
  );
}

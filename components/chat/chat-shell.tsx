'use client';
/** The chat page: a list of conversations beside the one on screen. */
import { useCallback, useState } from 'react';
import { ChatPreview } from './chat-preview';
import { ConversationList } from './conversation-list';
import { FilesPanel } from './files-panel';

export function ChatShell({ conversationId }: { conversationId: string }) {
  // Bumped when a run settles. A conversation is created by its first message
  // and titled from it, so without this the list would keep showing the state
  // it had before the owner said anything.
  const [revision, setRevision] = useState(0);
  const settled = useCallback(() => setRevision((value) => value + 1), []);

  return (
    <div className="chat-shell">
      <ConversationList activeId={conversationId} revision={revision} />
      {/* Keyed by conversation so moving between them rebuilds the chat rather
          than showing the previous transcript under the new id: useChat holds
          its messages per instance. */}
      <ChatPreview key={conversationId} conversationId={conversationId} onSettled={settled} />
      {/* Reloaded on the same signal as the list: a run that just finished may
          have written a file, and a panel showing the state from before it is
          worse than no panel. */}
      <FilesPanel revision={revision} />
    </div>
  );
}

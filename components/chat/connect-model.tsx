'use client';
/** Keep model setup discoverable beside the draft without interrupting writing. */
import { KeyRound } from 'lucide-react';

export function ConnectModelCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="chat-key-callout">
      <KeyRound size={16} aria-hidden="true" />
      <span>Connect a model to send your first message.</span>
      <button type="button" onClick={onOpenSettings}>
        Connect model
      </button>
    </div>
  );
}

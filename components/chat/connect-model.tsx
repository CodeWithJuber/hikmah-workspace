'use client';
/** The model gate, inverted: value first, setup later.
 *
 * This card shows only when the configured model is a paid one with no key to
 * pay for it. Free-only mode never blocks — the first message always goes
 * through on the free tier, so this is a choice between two ways forward,
 * not a wall before the first send.
 */
import { KeyRound, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ConnectModelCard({
  onUseFree,
  onOpenSettings,
}: {
  /** Switch to the free-only config and keep going — no key needed. */
  onUseFree: () => void;
  /** Open Settings, where the key goes. */
  onOpenSettings: () => void;
}) {
  return (
    <div className="chat-connection-notice" role="note">
      <KeyRound size={16} aria-hidden="true" />
      <span>This model needs an API key. You can also just try the free tier — no key needed.</span>
      <Button type="button" size="sm" onClick={onUseFree}>
        <Zap size={16} aria-hidden="true" />
        Try it free now
      </Button>
      <button type="button" onClick={onOpenSettings} className="chat-key-link">
        Add my own key →
      </button>
    </div>
  );
}

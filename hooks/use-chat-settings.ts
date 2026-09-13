'use client';
/** The owner's chat preferences, over the one store that reaches a run.
 *
 * Shared rather than held by whichever component happened to need it first:
 * the chat shell and the workspace's Tools screen both switch tools off, and
 * two components keeping their own copy of "what is switched off" is how the
 * two screens came to disagree in the first place. There is one store —
 * `chat_settings`, behind `/api/chat-settings` — and this is the only way in.
 */
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@/lib/chat/settings';

export function useChatSettings() {
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS);
  // Whether `settings` is what the server holds rather than the defaults it
  // started as. A reader that overlays the saved connection on a run must not
  // overlay the defaults — that would point a run at OpenRouter for the frame
  // before the real answer arrives.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch('/api/chat-settings', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (live && payload?.settings) setSettings(payload.settings as ChatSettings);
      })
      // The defaults are usable settings, so a failed read costs nothing worth
      // interrupting the owner about.
      .catch(() => {})
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const change = useCallback(async (patch: Partial<ChatSettings>) => {
    const response = await fetch('/api/chat-settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error('Settings were not saved.');
    // Taken from the reply rather than assumed: the server clamps, so what was
    // asked for and what is now stored are not always the same.
    const payload = (await response.json()) as { settings?: ChatSettings };
    if (payload.settings) setSettings(payload.settings);
  }, []);

  return { settings, change, ready };
}

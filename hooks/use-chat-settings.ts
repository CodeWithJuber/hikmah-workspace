'use client';
/** The owner's chat preferences, over the one store that reaches a run.
 *
 * Shared rather than held by whichever component happened to need it first:
 * the chat shell and the workspace's Tools screen both switch tools off, and
 * two components keeping their own copy of "what is switched off" is how the
 * two screens came to disagree in the first place. There is one store —
 * `chat_settings`, behind `/api/chat-settings` — and this is the only way in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@/lib/chat/settings';
import { clientFetch } from '@/lib/client/request';
import { createChatSettingsSync } from '@/lib/client/chat-settings-sync';

const SETTINGS_CHANGED = 'hikmah-chat-settings-changed';

async function settingsPayload(response: Response): Promise<ChatSettings> {
  const payload = (await response.json().catch(() => null)) as { settings?: ChatSettings } | null;
  if (!response.ok) throw new Error('Settings were not saved. Check your connection and retry.');
  if (!payload?.settings) throw new Error('Settings could not be read. Please try again.');
  return payload.settings;
}

export function useChatSettings() {
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS);
  // Whether `settings` is what the server holds rather than the defaults it
  // started as. A reader that overlays the saved connection on a run must not
  // overlay the defaults — that would point a run at OpenRouter for the frame
  // before the real answer arrives.
  const [ready, setReady] = useState(false);
  const sync = useRef<ReturnType<typeof createChatSettingsSync> | null>(null);

  useEffect(() => {
    const current = createChatSettingsSync({
      read: async (signal) =>
        settingsPayload(await clientFetch('/api/chat-settings', { cache: 'no-store', signal })),
      write: async (patch) =>
        settingsPayload(
          await clientFetch('/api/chat-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          }),
        ),
      publish: setSettings,
      ready: () => setReady(true),
    });
    sync.current = current;
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ source?: unknown }>).detail?.source !== current)
        current.refresh();
    };
    // Learning may update contextModel server-side. Other mounted settings
    // readers and a returning browser tab must see that confirmed state too.
    window.addEventListener(SETTINGS_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    current.refresh();
    return () => {
      window.removeEventListener(SETTINGS_CHANGED, refresh);
      window.removeEventListener('focus', refresh);
      current.stop();
      if (sync.current === current) sync.current = null;
    };
  }, []);

  const change = useCallback(async (patch: Partial<ChatSettings>) => {
    const current = sync.current;
    if (!current) throw new Error('Settings are unavailable. Reopen the page.');
    await current.change(patch);
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED, { detail: { source: current } }));
  }, []);

  return { settings, change, ready };
}

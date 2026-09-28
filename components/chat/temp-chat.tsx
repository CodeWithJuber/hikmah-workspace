'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client/request';

/**
 * Temporary chat: a conversation that leaves nothing behind.
 *
 * Contract with the parent (which owns the send flow and the composer):
 *
 * 1. When the person toggles temp mode on, the parent calls `enterTemp()`
 *    and gets back an id like `temp-<uuid>`. It passes that id to the normal
 *    open/send flow, so the server creates the conversation like any other
 *    — the `temp-` prefix marks it as ephemeral in the conversation list,
 *    where the parent must NOT show it (sidebar, landing, search).
 * 2. When the person leaves temp mode — toggling off, switching
 *    conversation, closing — the parent calls `exitTemp()`, which DELETEs
 *    `/api/conversations/<temp-id>`. Rows cascade server-side, so nothing
 *    persists: no messages, no runs, no feedback.
 * 3. If the tab unmounts while temp is active, the hook deletes the
 *    conversation itself (best-effort fetch on unmount), so a closed tab
 *    does not strand a temp conversation.
 *
 * Only the id this hook issued is ever deleted: it can never touch a real
 * conversation. DELETE of an id the server never created (temp toggled on
 * but nothing sent) is a 404 the hook ignores.
 */
export function useTempChat(): {
  /** Temp mode is active: the composer row shows the temp indicator. */
  temp: boolean;
  /** The temp conversation id issued this session, or null outside temp. */
  tempId: string | null;
  /** Start temp mode; returns the ephemeral id for the send flow. */
  enterTemp: () => string;
  /** Adopt an id issued elsewhere (e.g. read from the route) as this
   * session's temp id, so the unmount cleanup deletes the right
   * conversation. Needed when the parent navigates to /chat/temp-<uuid>:
   * the instance that would have called enterTemp unmounts on navigation,
   * and its cleanup would otherwise delete the id it just issued. */
  adoptTemp: (id: string) => void;
  /** Leave temp mode and delete the temp conversation, if one was made. */
  exitTemp: () => Promise<void>;
} {
  const [tempId, setTempId] = useState<string | null>(null);
  const tempIdRef = useRef<string | null>(null);

  const deleteTemp = useCallback(async (id: string) => {
    try {
      // clientFetch, not bare fetch: the delete gets the same 15s deadline
      // as every other browser request (tests/client-fetch.test.mjs), and a
      // 404 — temp toggled on but nothing ever sent — is fine to ignore.
      await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // A failed delete on exit is not worth blocking navigation for; the
      // id is prefixed temp- and the list never shows it.
    }
  }, []);

  const enterTemp = useCallback(() => {
    const id = `temp-${crypto.randomUUID()}`;
    tempIdRef.current = id;
    setTempId(id);
    return id;
  }, []);

  const adoptTemp = useCallback((id: string) => {
    tempIdRef.current = id;
    setTempId(id);
  }, []);

  const exitTemp = useCallback(async () => {
    const id = tempIdRef.current;
    tempIdRef.current = null;
    setTempId(null);
    if (id) await deleteTemp(id);
  }, [deleteTemp]);

  // A closed or navigated-away tab must not leave the temp conversation
  // behind. The unmount cleanup is the only exitTemp the hook performs
  // itself; every other exit is the parent's explicit call.
  useEffect(() => {
    return () => {
      const id = tempIdRef.current;
      if (id) void deleteTemp(id);
    };
  }, [deleteTemp]);

  return { temp: tempId !== null, tempId, enterTemp, adoptTemp, exitTemp };
}

'use client';
/** A person's memories, over the one store that reaches a run.
 *
 * Shared by the chat's Memory tab and the workspace's Memory screen for the
 * reason `useChatSettings` is shared by two screens: two components each
 * keeping their own copy of "what is saved" is how the old Memory screen came
 * to save items no answer could read. There is one table, behind
 * `/api/memory`, and this is the only way in.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Memory, MemoryKind, MemoryStatus } from '@/lib/memory/store';

export type MemoryCounts = Record<MemoryStatus, number>;

export type MemoryPatch = Partial<
  Pick<Memory, 'title' | 'content' | 'kind' | 'status' | 'enabled'>
>;

export function useMemory() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [counts, setCounts] = useState<MemoryCounts>({ suggested: 0, saved: 0, rejected: 0 });
  const [recent, setRecent] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    void fetch('/api/memory', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { memories?: Memory[]; counts?: MemoryCounts; recent?: string[] } | null) => {
        if (!live) return;
        setMemories(payload?.memories ?? []);
        if (payload?.counts) setCounts(payload.counts);
        setRecent(payload?.recent ?? []);
      })
      .catch(() => {
        if (live) setMemories([]);
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  const send = useCallback(
    async (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        memory?: Memory;
      };
      if (!response.ok) throw new Error(payload.error ?? 'The change was not saved.');
      setRevision((n) => n + 1);
      return payload.memory ?? null;
    },
    [],
  );

  const add = useCallback(
    (input: { title?: string; content: string; kind: MemoryKind }) =>
      send('POST', '/api/memory', input),
    [send],
  );
  const update = useCallback(
    (id: string, patch: MemoryPatch) => send('PUT', '/api/memory', { id, ...patch }),
    [send],
  );
  const remove = useCallback(
    (id: string) => send('DELETE', '/api/memory?id=' + encodeURIComponent(id)),
    [send],
  );

  return { memories, counts, recent, loading: memories === null, add, update, remove, refresh };
}

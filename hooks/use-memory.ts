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
import { clientFetch } from '@/lib/client/request';

export type MemoryCounts = Record<MemoryStatus, number>;

export type MemoryPatch = Partial<
  Pick<Memory, 'title' | 'content' | 'kind' | 'status' | 'enabled'>
>;

export function useMemory() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [counts, setCounts] = useState<MemoryCounts>({ suggested: 0, saved: 0, rejected: 0 });
  const [recent, setRecent] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  /** A load that did not happen, told apart from a person with nothing saved.
   *
   * This hook had two ways of turning a failure into "you have no memories".
   * The catch set `[]`, and — the quieter one — a response that was not ok
   * became `null`, whose `?.memories ?? []` is also `[]`. So a 500, an expired
   * session or a dropped connection all rendered as "Nothing saved yet. Write
   * something above", to someone who may have written a hundred things. The
   * files and agents panels were fixed for exactly this in an earlier pass;
   * this is the one that was left. */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void clientFetch('/api/memory')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as {
          memories?: Memory[];
          counts?: MemoryCounts;
          recent?: string[];
        };
      })
      .then((payload) => {
        if (!live) return;
        setMemories(payload.memories ?? []);
        if (payload.counts) setCounts(payload.counts);
        setRecent(payload.recent ?? []);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  const send = useCallback(
    async (method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
      const response = await clientFetch(url, {
        method,
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

  // `loading` stops once the request settles, either way — a failed load that
  // stayed "loading" would be a spinner nobody can end.
  return {
    memories,
    counts,
    recent,
    failed,
    loading: memories === null && !failed,
    add,
    update,
    remove,
    refresh,
  };
}

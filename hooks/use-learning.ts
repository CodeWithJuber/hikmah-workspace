'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client/request';
import type { ExampleStatus, LearningExample, LearningSnapshot } from '@/lib/learning/types';

export const LEARNING_PAGE_SIZE = 25;

export type LearningAction =
  | {
      action: 'configure';
      enabled?: boolean;
      useApproved?: boolean;
      collectSyntax?: boolean;
      retentionDays?: 7 | 30 | 90;
    }
  | {
      action: 'review';
      id: string;
      revision: number;
      status: ExampleStatus;
      correction?: string | null;
    }
  | { action: 'delete'; id: string }
  | { action: 'clear' };

async function readSnapshot(
  response: Response,
): Promise<LearningSnapshot & { example?: LearningExample }> {
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(payload?.error || 'Learning could not be reached. Please try again.');
  if (!payload?.policy || !payload?.counts || !Array.isArray(payload.examples)) {
    throw new Error('The learning response was incomplete. Please try again.');
  }
  return payload;
}

async function fetchPage(status: ExampleStatus, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({
    status,
    offset: String(offset),
    limit: String(LEARNING_PAGE_SIZE),
  });
  return readSnapshot(await clientFetch(`/api/learning?${query}`, { cache: 'no-store', signal }));
}

export function useLearning(status: ExampleStatus, offset: number, revision = 0) {
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settledQuery, setSettledQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const changing = useRef(false);
  const queryKey = `${status}:${offset}:${revision}`;
  const loading = refreshing || settledQuery !== queryKey;

  const readPage = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const next = await fetchPage(status, offset, controller.signal);
      if (!controller.signal.aborted && mounted.current) {
        setSnapshot(next);
        setError('');
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Learning could not be loaded.');
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) {
        setSettledQuery(queryKey);
        setRefreshing(false);
      }
    }
  }, [status, offset, queryKey]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    await readPage();
  }, [readPage]);

  useEffect(() => {
    mounted.current = true;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    void fetchPage(status, offset, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Learning could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSettledQuery(queryKey);
          setRefreshing(false);
        }
      });
    return () => {
      mounted.current = false;
      read.current?.abort();
    };
  }, [status, offset, queryKey]);

  const send = useCallback(
    async (action: LearningAction) => {
      if (changing.current) throw new Error('Please wait for the current change to finish.');
      changing.current = true;
      setBusy(true);
      try {
        const response = await clientFetch('/api/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        });
        const next = await readSnapshot(response);
        if (mounted.current) {
          // POST returns the default queue. Keep the current filter/page until
          // its read settles instead of briefly showing an unrelated page.
          setSnapshot((current) =>
            current ? { ...current, policy: next.policy, counts: next.counts } : next,
          );
          await refresh();
        }
        return next;
      } finally {
        changing.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );

  return { snapshot, loading, busy, error: settledQuery === queryKey ? error : '', refresh, send };
}

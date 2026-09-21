'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client/request';
import { invalidateField } from '@/lib/context-model/client';
import type { ExampleStatus, LearningExample, LearningSnapshot } from '@/lib/learning/types';

export const LEARNING_PAGE_SIZE = 25;

export type LearningAction =
  | {
      action: 'configure';
      enabled?: boolean;
      automatic?: boolean;
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
  if (
    !payload?.policy ||
    !payload?.counts ||
    !payload?.automatic ||
    !Array.isArray(payload.examples)
  ) {
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

export function useLearning(status: ExampleStatus, offset: number, revision = 0, active = true) {
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settledQuery, setSettledQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = useRef<AbortController | null>(null);
  const latestRead = useRef<(() => Promise<void>) | null>(null);
  const mounted = useRef(true);
  const changing = useRef(false);
  const queryKey = `${status}:${offset}:${revision}`;
  const loading = refreshing || settledQuery !== queryKey;

  const readPage = useCallback(async () => {
    if (!active) return;
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
      if (read.current === controller) read.current = null;
    }
  }, [status, offset, queryKey, active]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    await readPage();
  }, [readPage]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      read.current?.abort();
    };
  }, []);

  useEffect(() => {
    latestRead.current = readPage;
    read.current?.abort();
    if (!active) return;
    const controller = new AbortController();
    read.current = controller;
    void fetchPage(status, offset, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted && mounted.current) {
          setSnapshot(next);
          setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && mounted.current)
          setError(cause instanceof Error ? cause.message : 'Learning could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted && mounted.current) {
          setSettledQuery(queryKey);
          setRefreshing(false);
        }
        if (read.current === controller) read.current = null;
      });
    return () => controller.abort();
  }, [active, status, offset, queryKey, readPage]);

  const checkpoint = snapshot?.automatic.checkpointId;
  const checkpointLanguage = snapshot?.automatic.language;
  useEffect(() => {
    if (checkpoint && checkpointLanguage) invalidateField(checkpointLanguage);
  }, [checkpoint, checkpointLanguage]);

  const automaticEnabled = snapshot?.policy.automatic ?? false;
  const automaticStatus = snapshot?.automatic.status;
  useEffect(() => {
    if (!active || !automaticEnabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling: AbortController | null = null;
    const delay = ['preparing', 'training', 'evaluating'].includes(automaticStatus ?? '')
      ? 2500
      : 12000;
    const schedule = () => {
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(poll, delay);
    };
    async function poll() {
      if (stopped || document.visibilityState !== 'visible') return;
      // Reads never overlap or race a consent/reset mutation. Polls retain the
      // visible content instead of replacing the review queue with a spinner.
      if (changing.current || read.current) {
        schedule();
        return;
      }
      const controller = new AbortController();
      polling = controller;
      read.current = controller;
      try {
        const next = await fetchPage(status, offset, controller.signal);
        if (!controller.signal.aborted && !stopped && mounted.current) {
          setSnapshot(next);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted && !stopped && mounted.current)
          setError(cause instanceof Error ? cause.message : 'Learning could not be refreshed.');
      } finally {
        if (read.current === controller) read.current = null;
        if (polling === controller) polling = null;
        schedule();
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') void poll();
      else polling?.abort();
    }
    schedule();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      stopped = true;
      clearTimeout(timer);
      polling?.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active, automaticEnabled, automaticStatus, status, offset, queryKey]);

  const send = useCallback(async (action: LearningAction) => {
    if (changing.current) throw new Error('Please wait for the current change to finish.');
    changing.current = true;
    read.current?.abort();
    setBusy(true);
    try {
      const response = await clientFetch('/api/learning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      const next = await readSnapshot(response);
      if (action.action === 'clear') {
        for (const language of ['en', 'ar', 'hi', 'es', 'tr']) invalidateField(language);
      }
      if (
        action.action === 'clear' ||
        (action.action === 'configure' && action.automatic !== undefined)
      ) {
        window.dispatchEvent(new Event('hikmah-chat-settings-changed'));
      }
      if (mounted.current) {
        // POST returns the default queue. Preserve the visible filter until its
        // current page settles, including if navigation changed during POST.
        setSnapshot((current) =>
          current
            ? {
                ...current,
                policy: next.policy,
                counts: next.counts,
                automatic: next.automatic,
                examples:
                  action.action === 'clear'
                    ? []
                    : action.action === 'delete'
                      ? current.examples.filter((example) => example.id !== action.id)
                      : current.examples,
                hasMore: action.action === 'clear' ? false : current.hasMore,
              }
            : next,
        );
        await latestRead.current?.();
      }
      return next;
    } catch (cause) {
      // A failed mutation must not strand an aborted page read or leave Retry
      // disabled behind a loading state. Reconcile without delaying the error.
      if (mounted.current) void latestRead.current?.();
      throw cause;
    } finally {
      changing.current = false;
      if (mounted.current) {
        setBusy(false);
        setRefreshing(false);
      }
    }
  }, []);

  return { snapshot, loading, busy, error: settledQuery === queryKey ? error : '', refresh, send };
}

'use client';
/** One streaming lane of the compare view.
 *
 * Two lanes answer the same question at once:
 *
 * - `raw`: pure passthrough through `lib/playground/transport.ts` — the
 *   model's answer to the bare prompt, no system prompt, no memory, no tools.
 * - `hikmah`: the same prompt through the real run pipeline — the server
 *   worker that owns kernel context, memory recall, tools and receipts. The
 *   run is queued on `/api/conversations/[id]/runs` and its output is tailed
 *   from the replayable log with `runStream`, exactly like the chat surface.
 *
 * Neither lane reimplements streaming: the left reuses the provider
 * transport, the right reuses the durable run transport. What is new here is
 * only folding the chunks into evidence the panel can show.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIMessageChunk } from 'ai';
import { createLaneFold, type LaneFold } from '@/lib/compare/evidence';
import { cancelRun, runStream } from '@/lib/chat/durable-transport';
import { complete, validateConfig, type Usage } from '@/lib/playground/transport';
import { defaultProvider } from '@/lib/playground/session';
import { HIKMAH_CORE } from '@/lib/playground/agent-prompts';
import { personalPrompt, type ChatSettings } from '@/lib/chat/settings';
import { clientFetch } from '@/lib/client/request';

export type LaneStatus = 'idle' | 'streaming' | 'done' | 'failed' | 'cancelled';

/** The connection the run uses. The key itself is never here: the server
 * resolves it from the saved secret name, and the relay does the same from
 * the browser via the secret reference. */
export type LaneRunConfig = {
  baseUrl: string;
  model: string;
  freeOnly: boolean;
  apiKeySecret?: string;
  maxSteps: number;
  contextCharacters: number;
  disabledTools: string[];
};

export type LaneSnapshot = {
  status: LaneStatus;
  fold: LaneFold;
  latencyMs: number | null;
  firstTextMs: number | null;
  error: string | null;
};

const freshFold = (): { state: LaneFold; apply: (chunk: UIMessageChunk) => void } =>
  createLaneFold();

const freshSnapshot = (): LaneSnapshot => ({
  status: 'idle',
  fold: freshFold().state,
  latencyMs: null,
  firstTextMs: null,
  error: null,
});

/** Re-renders at most once per interval while a lane streams. A provider at a
 * hundred chunks a second is not a hundred commits a second. */
const FLUSH_MS = 100;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'The answer could not be finished.';

function usageMeta(usage: Usage): LaneFold['meta'] {
  const meta: LaneFold['meta'] = {};
  if (Number.isSafeInteger(usage.prompt_tokens) && (usage.prompt_tokens ?? 0) >= 0)
    meta.inputTokens = usage.prompt_tokens;
  if (Number.isSafeInteger(usage.completion_tokens) && (usage.completion_tokens ?? 0) >= 0)
    meta.outputTokens = usage.completion_tokens;
  if (Number.isSafeInteger(usage.total_tokens) && (usage.total_tokens ?? 0) >= 0)
    meta.totalTokens = usage.total_tokens;
  return meta;
}

export function useCompareLane() {
  // The draft is mutated at chunk rate; `snapshot` is the throttled copy the
  // render reads. Never read the draft during render.
  const [snapshot, setSnapshot] = useState<LaneSnapshot>(freshSnapshot);
  const draft = useRef<LaneSnapshot>(snapshot);
  const controller = useRef<AbortController | null>(null);
  /** The server run id, when this lane is the Hikmah one. Read by stop()
   * before the abort so the worker is told exactly once. */
  const runIdRef = useRef<string | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      setSnapshot({ ...draft.current });
    }, FLUSH_MS);
  }, []);

  const settle = useCallback((patch: Partial<LaneSnapshot>) => {
    Object.assign(draft.current, patch);
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    setSnapshot({ ...draft.current });
  }, []);

  const begin = useCallback(() => {
    controller.current?.abort();
    runIdRef.current = null;
    const fold = freshFold();
    draft.current = {
      status: 'streaming',
      fold: fold.state,
      latencyMs: null,
      firstTextMs: null,
      error: null,
    };
    setSnapshot({ ...draft.current });
    const ctrl = new AbortController();
    controller.current = ctrl;
    return { ctrl, startedAt: Date.now(), apply: fold.apply };
  }, []);

  useEffect(
    () => () => {
      controller.current?.abort();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  /** The raw lane: the model alone, through the provider transport. */
  const startRaw = useCallback(
    async (run: LaneRunConfig, prompt: string) => {
      const { ctrl, startedAt } = begin();
      try {
        const config = validateConfig({
          ...defaultProvider,
          baseUrl: run.baseUrl,
          model: run.model,
          apiKeySecret: run.apiKeySecret,
          freeOnly: run.freeOnly,
          maxTokens: 8192,
          temperature: 0.3,
        });
        // No system message, deliberately: this is the model with nothing
        // added. No tools either — a baseline that could search the web would
        // be measuring a different thing.
        const result = await complete(config, [{ role: 'user', content: prompt }], {
          signal: ctrl.signal,
          onText: (delta) => {
            const current = draft.current;
            if (current.firstTextMs === null) current.firstTextMs = Date.now() - startedAt;
            current.fold.text += delta;
            scheduleFlush();
          },
          onMeta: (meta) => {
            draft.current.fold.meta = {
              ...draft.current.fold.meta,
              model: meta.model,
              ...usageMeta(meta.usage),
            };
            scheduleFlush();
          },
        });
        settle({
          status: 'done',
          latencyMs: Date.now() - startedAt,
          fold: {
            ...draft.current.fold,
            meta: {
              ...draft.current.fold.meta,
              model: result.model || draft.current.fold.meta.model,
              ...usageMeta(result.usage),
            },
          },
        });
      } catch (error) {
        if (ctrl.signal.aborted) settle({ status: 'cancelled', latencyMs: Date.now() - startedAt });
        else
          settle({
            status: 'failed',
            error: messageOf(error),
            latencyMs: Date.now() - startedAt,
          });
      }
    },
    [begin, scheduleFlush, settle],
  );

  /** The Hikmah lane: the same prompt through the server run pipeline. */
  const startHikmah = useCallback(
    async (run: LaneRunConfig, settings: ChatSettings, prompt: string) => {
      const { ctrl, startedAt, apply } = begin();
      let runId: string | null = null;
      try {
        const conversationId = crypto.randomUUID();
        const response = await clientFetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/runs`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseUrl: run.baseUrl,
              model: run.model,
              freeOnly: run.freeOnly,
              apiKeySecret: run.apiKeySecret,
              // The same instructions the chat surface sends: core rules plus
              // the owner's standing instructions. The server then adds the
              // kernel context, the recalled memory and the reviewed examples.
              instructions: HIKMAH_CORE + personalPrompt(settings),
              maxSteps: run.maxSteps,
              contextCharacters: run.contextCharacters,
              disabledTools: run.disabledTools,
              messages: [
                {
                  id: crypto.randomUUID(),
                  role: 'user',
                  parts: [{ type: 'text', text: prompt }],
                },
              ],
            }),
            signal: ctrl.signal,
          },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          runId?: string;
          error?: string;
        };
        if (!response.ok || !payload.runId)
          throw new Error(payload.error ?? 'The run could not be started.');
        runId = payload.runId;
        runIdRef.current = runId;

        const reader = runStream({ runId, signal: ctrl.signal }).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            apply(value);
            const current = draft.current;
            if (current.firstTextMs === null && current.fold.text)
              current.firstTextMs = Date.now() - startedAt;
            scheduleFlush();
          }
        } finally {
          reader.releaseLock();
        }
        const finished = draft.current.fold;
        settle({
          status: finished.error
            ? 'failed'
            : finished.cancelled || ctrl.signal.aborted
              ? 'cancelled'
              : 'done',
          error: finished.error,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        if (ctrl.signal.aborted) settle({ status: 'cancelled', latencyMs: Date.now() - startedAt });
        else
          settle({
            status: 'failed',
            error: messageOf(error),
            latencyMs: Date.now() - startedAt,
          });
      }
    },
    [begin, scheduleFlush, settle],
  );

  /** Stop the lane. For the server lane this also tells the worker, so Stop
   * ends the work rather than just this tab's view of it. */
  const stop = useCallback(() => {
    if (draft.current.status !== 'streaming') return;
    const runId = runIdRef.current;
    runIdRef.current = null;
    controller.current?.abort();
    if (runId) void cancelRun(runId);
  }, []);

  return { snapshot, startRaw, startHikmah, stop };
}

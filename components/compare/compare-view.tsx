'use client';
/** The /compare view: one question, two answers, side by side.
 *
 * Left: the raw model alone — a pure passthrough through the provider
 * transport, no system prompt, no memory, no tools. Right: the same model
 * through the real run pipeline — kernel context, memory recall, tools and
 * receipts, exactly as the chat surface runs it.
 *
 * The point is the one from the UX research: raw model capability is a
 * commodity; what keeps a person is accumulated context. This view makes the
 * workspace's additions visible, turn by turn, in plain language. No jargon
 * in the UI — "bandit", "FTS5" and friends stay in the code.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Scale, Sparkles } from 'lucide-react';
import { useChatSettings } from '@/hooks/use-chat-settings';
import { useMemory } from '@/hooks/use-memory';
import { clientFetch } from '@/lib/client/request';
import { listModels } from '@/lib/playground/transport';
import { defaultProvider } from '@/lib/playground/session';
import { priceKind } from '@/lib/playground/model-catalog';
import { allModelsFree, providerDestination } from '@/lib/ai/endpoint';
import { matchLearningExamples } from '@/lib/compare/evidence';
import type { LearningExample, LearningSnapshot } from '@/lib/learning/types';
import type { MemoryKind } from '@/lib/memory/store';
import { ModelPicker, type PickerModel } from '@/components/chat/model-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SendStopButton } from '@/components/chat/send-stop-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ComparePane } from './compare-pane';
import { EvidencePanel, type MemoryLookup } from './evidence-panel';
import { LearningStrip } from './learning-strip';
import { useCompareLane, type LaneRunConfig } from './use-compare-lane';

type Connection = {
  baseUrl: string;
  model: string;
  freeOnly: boolean;
  apiKeySecret?: string;
};

const FALLBACK: Connection = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/free',
  freeOnly: true,
};

/** One-click seeds for a first-time workspace. Plain preferences the person
 * would plausibly hold; each is saved as their own words, not as fact. */
const STARTERS: { title: string; content: string }[] = [
  {
    title: 'Short summaries',
    content:
      'The user prefers concise summaries: the result first, detail only where it changes what to do.',
  },
  {
    title: 'Cite sources',
    content: 'The user wants factual claims backed by cited sources.',
  },
  {
    title: 'TypeScript examples',
    content: 'The user prefers code examples in TypeScript.',
  },
];

const weekdayOf = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString('en', { weekday: 'long' })
    : null;
};

export function CompareView() {
  const { settings } = useChatSettings();
  const {
    memories,
    loading: memoriesLoading,
    failed: memoriesFailed,
    add: addMemory,
    refresh: refreshMemories,
  } = useMemory();
  const raw = useCompareLane();
  const hikmah = useCompareLane();

  const [connection, setConnection] = useState<Connection | null>(null);
  const [catalog, setCatalog] = useState<PickerModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [managedKey, setManagedKey] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState('');
  const [lastPrompt, setLastPrompt] = useState('');
  const [learning, setLearning] = useState<LearningSnapshot | null>(null);
  const [seeding, setSeeding] = useState<string | null>(null);
  const [seedError, setSeedError] = useState('');

  // The connection the workspace already has, so this surface talks to the
  // same provider as the rest of the app. Same fallback chain as the chat
  // surface: chat settings, then the workspace blob, then the free default.
  useEffect(() => {
    let live = true;
    void (async () => {
      const read = (saved: Partial<Connection> | undefined): Connection | null =>
        saved?.baseUrl && saved.model
          ? {
              baseUrl: saved.baseUrl,
              model: saved.model,
              freeOnly: saved.freeOnly !== false,
              apiKeySecret: saved.apiKeySecret || undefined,
            }
          : null;
      try {
        const response = await clientFetch('/api/chat-settings');
        if (response.ok) {
          const next = read(
            ((await response.json()) as { settings?: { connection?: Partial<Connection> } })
              .settings?.connection,
          );
          if (next) {
            if (live) setConnection(next);
            return;
          }
        }
      } catch {
        /* fall through to the workspace blob */
      }
      try {
        const response = await clientFetch('/api/workspace-state');
        if (response.ok) {
          const payload = (await response.json()) as { session?: string };
          let saved: Partial<Connection> | undefined;
          try {
            saved = payload.session ? JSON.parse(payload.session)?.connection : undefined;
          } catch {
            saved = undefined;
          }
          const next = read(saved);
          if (next) {
            if (live) setConnection(next);
            return;
          }
        }
      } catch {
        /* fall through to the default */
      }
      if (live) setConnection(FALLBACK);
    })();
    return () => {
      live = false;
    };
  }, []);

  // The model catalogue for the one-model picker. A convenience, not a
  // precondition: the connection's own model is always selectable.
  useEffect(() => {
    if (!connection) return;
    const controller = new AbortController();
    void listModels(
      {
        ...defaultProvider,
        baseUrl: connection.baseUrl,
        model: connection.model,
        apiKeySecret: connection.apiKeySecret,
        freeOnly: connection.freeOnly,
      },
      controller.signal,
    )
      .then((rows) => {
        if (controller.signal.aborted) return;
        const usable =
          connection.freeOnly && !allModelsFree(connection.baseUrl)
            ? rows.filter((row) => priceKind(row) === 'free')
            : rows;
        setCatalog(usable.map((row) => ({ ...row, label: row.name || row.id })).slice(0, 500));
        setCatalogError('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalog([]);
        setCatalogError(
          error instanceof Error ? error.message : 'The catalogue could not be loaded.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [connection]);

  // Whether the workspace already pays for runs, so the empty state can ask
  // for a key instead of offering a comparison that would fail.
  useEffect(() => {
    let live = true;
    void clientFetch('/api/billing')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { managedKey?: boolean } | null) => {
        if (live) setManagedKey(Boolean(payload?.managedKey));
      })
      .catch(() => {
        if (live) setManagedKey(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // Approved examples for the "reviewed examples" evidence and the learning
  // strip. Counts cover every status; the examples feed the matcher.
  useEffect(() => {
    let live = true;
    void clientFetch('/api/learning?status=approved&offset=0&limit=300', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('learning unavailable');
        return (await response.json()) as Partial<LearningSnapshot>;
      })
      .then((payload) => {
        if (live && Array.isArray(payload.examples)) setLearning(payload as LearningSnapshot);
      })
      .catch(() => {
        /* the strip degrades to memories alone */
      });
    return () => {
      live = false;
    };
  }, []);

  const models = useMemo<PickerModel[]>(() => {
    if (!connection) return catalog;
    return catalog.some((row) => row.id === connection.model)
      ? catalog
      : [{ id: connection.model, label: connection.model }, ...catalog];
  }, [catalog, connection]);
  const activeModel = chosenModel ?? connection?.model ?? '';
  const needsKey =
    managedKey === false &&
    connection !== null &&
    Boolean(providerDestination(connection.baseUrl)) &&
    !connection.apiKeySecret;

  const busy = raw.snapshot.status === 'streaming' || hikmah.snapshot.status === 'streaming';
  const ran = raw.snapshot.status !== 'idle' || hikmah.snapshot.status !== 'idle';

  const approvedExamples: LearningExample[] = useMemo(
    () =>
      (learning?.examples ?? []).filter(
        (example): example is LearningExample => example?.status === 'approved',
      ),
    [learning],
  );
  const matchedExamples = useMemo(
    () => (lastPrompt ? matchLearningExamples(lastPrompt, approvedExamples) : []),
    [lastPrompt, approvedExamples],
  );
  const memoryUses: MemoryLookup = useMemo(
    () => new Map((memories ?? []).map((memory) => [memory.id, { uses: memory.uses }])),
    [memories],
  );

  const send = () => {
    const text = prompt.trim();
    if (!text || busy || !connection || !activeModel || needsKey) return;
    const run: LaneRunConfig = {
      baseUrl: connection.baseUrl,
      model: activeModel,
      freeOnly: connection.freeOnly,
      apiKeySecret: connection.apiKeySecret,
      maxSteps: settings.maxSteps,
      contextCharacters: settings.contextCharacters,
      disabledTools: settings.disabledTools,
    };
    setPrompt('');
    setLastPrompt(text);
    // Both lanes start together: the point is the side-by-side.
    void raw.startRaw(run, text);
    void hikmah.startHikmah(run, settings, text);
  };

  const stopAll = () => {
    raw.stop();
    hikmah.stop();
  };

  // Staged loading, named honestly: the pipeline is richer than a spinner,
  // so the waiting says what it is waiting on.
  const hikmahStage = (() => {
    const snapshot = hikmah.snapshot;
    if (snapshot.status !== 'streaming') return '';
    const runningTool = snapshot.fold.tools.find((tool) => tool.state === 'running');
    if (runningTool) return `Using ${runningTool.name}…`;
    if (snapshot.fold.tools.length > 0 && !snapshot.fold.text) return 'Working with tools…';
    if (snapshot.fold.thinking && !snapshot.fold.text) return 'Thinking…';
    if (snapshot.fold.memories.length > 0 && !snapshot.fold.text) return 'Reading your memory…';
    if (snapshot.fold.text) return 'Writing…';
    return 'Starting the run…';
  })();
  const rawStage =
    raw.snapshot.status === 'streaming'
      ? raw.snapshot.fold.text
        ? 'Writing…'
        : 'Asking the model…'
      : '';

  // The aha-moment: when a memory or a reviewed example actually fired, say
  // so — small, specific, and only then.
  const firedMemory = hikmah.snapshot.fold.memories[0];
  const ahaMemory = firedMemory
    ? (memories ?? []).find((memory) => memory.id === firedMemory.id)
    : undefined;
  const ahaWeekday = weekdayOf(ahaMemory?.createdAt);
  const showAha =
    hikmah.snapshot.status !== 'idle' && (Boolean(ahaMemory) || matchedExamples.length > 0);
  const ahaCopy = ahaMemory
    ? `Your note${ahaWeekday ? ` from ${ahaWeekday}` : ''} just improved this answer.`
    : 'A reviewed example just improved this answer.';
  const annotation = showAha ? (
    <p className="mb-3 flex items-start gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm text-foreground">
      <Sparkles size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
      <span>{ahaCopy}</span>
    </p>
  ) : undefined;

  const hasMemories = !memoriesLoading && !memoriesFailed && (memories ?? []).length > 0;
  const showGhosts =
    !memoriesLoading && !memoriesFailed && !hasMemories && hikmah.snapshot.status === 'idle';

  const seed = async (starter: { title: string; content: string }) => {
    setSeedError('');
    setSeeding(starter.title);
    try {
      await addMemory({
        title: starter.title,
        content: starter.content,
        kind: 'preference' as MemoryKind,
      });
      refreshMemories();
    } catch (error) {
      setSeedError(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setSeeding(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="max-w-3xl">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Scale size={16} aria-hidden="true" />
          Compare
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
          See what your workspace adds
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask one question. The left shows the raw model on its own; the right shows the same model
          with your workspace — your saved memory, your tools, and examples you&apos;ve reviewed.
          Watch what your workspace adds, turn by turn.
        </p>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ModelPicker
          models={models}
          value={activeModel}
          onSelect={setChosenModel}
          loading={catalogLoading}
          error={catalogError}
          title="The one model both sides use"
        />
        {connection?.freeOnly && (
          <span className="text-xs text-muted-foreground">Free models only</span>
        )}
      </div>

      {needsKey && (
        <Alert className="mt-4">
          <AlertDescription>
            Connect a model key before comparing — neither side can run without one.{' '}
            <Link
              href="/chat?settings=connection"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Open connection settings
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <form
        className="mt-4 rounded-lg border border-border bg-card p-3 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label htmlFor="compare-prompt" className="sr-only">
          Ask both sides
        </label>
        <Textarea
          id="compare-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Ask anything — both sides answer at once…"
          rows={3}
          className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={busy || needsKey}
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {busy ? 'Both sides are answering — Stop ends both.' : 'One question, two answers.'}
          </p>
          <SendStopButton
            state={busy ? 'streaming' : 'idle'}
            onSend={send}
            onStop={stopAll}
            disabled={!prompt.trim() || !connection || !activeModel || needsKey}
          />
        </div>
      </form>

      {ran && lastPrompt && (
        <p className="mt-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">You asked: </span>
          {lastPrompt}
        </p>
      )}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
        <ComparePane
          badge="Raw AI"
          title="The model alone"
          caption="Nothing added — no memory, no tools, no extra instructions."
          snapshot={raw.snapshot}
          stage={rawStage}
          footer={<span>Nothing added — pure model output.</span>}
          empty={
            <div className="flex h-full flex-col justify-center text-sm text-muted-foreground">
              <p>The raw answer will appear here.</p>
              <p className="mt-1 text-xs">
                The model as anyone else would meet it — your workspace changes nothing on this
                side.
              </p>
            </div>
          }
        />
        <div className="flex min-w-0 flex-col">
          <ComparePane
            badge="Hikmah"
            title="With your workspace"
            caption="The same model, plus your saved memory, tools and reviewed examples."
            snapshot={hikmah.snapshot}
            stage={hikmahStage}
            annotation={annotation}
            footer={<span>Same model, with your workspace.</span>}
            empty={
              showGhosts ? (
                <div>
                  <div className="flex flex-col gap-2" aria-hidden="true">
                    <Skeleton className="h-4 w-10/12 opacity-60" />
                    <Skeleton className="h-4 w-7/12 opacity-40" />
                    <Skeleton className="h-4 w-8/12 opacity-25" />
                  </div>
                  <p className="mt-4 text-sm text-muted-foreground">
                    Your workspace is empty — teach it something and watch this column light up.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {STARTERS.map((starter) => (
                      <Button
                        key={starter.title}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={seeding !== null}
                        onClick={() => void seed(starter)}
                      >
                        {seeding === starter.title ? 'Saving…' : `Remember: ${starter.title}`}
                      </Button>
                    ))}
                  </div>
                  {seedError && (
                    <p className="mt-2 text-xs text-destructive" role="alert">
                      {seedError}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">
                    Or write your own on the{' '}
                    <Link
                      href="/knowledge"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Memory screen
                    </Link>
                    .
                  </p>
                </div>
              ) : (
                <div className="flex h-full flex-col justify-center text-sm text-muted-foreground">
                  <p>The workspace answer will appear here.</p>
                  <p className="mt-1 text-xs">
                    Everything below the answer names what your workspace added to it.
                  </p>
                </div>
              )
            }
          >
            {hikmah.snapshot.status !== 'idle' && (
              <EvidencePanel
                fold={hikmah.snapshot.fold}
                matchedExamples={matchedExamples}
                memoryUses={memoryUses}
                busy={hikmah.snapshot.status === 'streaming'}
              />
            )}
          </ComparePane>
          <LearningStrip
            memories={memories}
            examples={approvedExamples}
            loading={memoriesLoading}
          />
        </div>
      </div>
    </div>
  );
}

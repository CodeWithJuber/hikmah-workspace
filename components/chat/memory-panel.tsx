'use client';
/** Memory: what the person has saved, what the model has suggested, and what
 * the last answers drew on.
 *
 * One panel for two surfaces — the chat's fourth tab and the workspace's
 * Memory screen — over the one store a run reads (`/api/memory`). The old
 * screen wrote into the workspace blob, which no answer has read since the
 * browser run loop was retired, and promised a Remember control and a
 * "which items were used" line that nothing provided. Both are real here.
 *
 * Every memory shows where it came from, because that is what decides how far
 * to trust it: the person's own words, a named source, or the model's guess.
 */
import { useEffect, useState } from 'react';
import { BookmarkPlus, Check, Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useMemory } from '@/hooks/use-memory';
import { setIncognito, useIncognito } from '@/lib/memory/incognito';
import type { Memory, MemoryKind } from '@/lib/memory/store';
import { planMemoryMasterToggle } from '@/lib/memory/master-toggle';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';
import type { LearningExample, LearningSnapshot } from '@/lib/learning/types';
import { dayWord, growthStory } from './memory-annotations';

const PROVENANCE: Record<Memory['provenance'], string> = {
  quote: 'Your words',
  source: 'From a source',
  inference: 'Model’s inference',
};

/** Trim for the learned-examples list: long enough to recognise, short enough
 * to scan. */
const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value;

/** What the workspace learned, in plain language — from /api/learning.
 *
 * The snapshot's `capability.mode` is 'reviewed-examples' with
 * `providerWeightsChanged: false`: these are demonstrations the person
 * reviewed and the workspace applies, and the header says exactly that.
 * There is no per-example observation count in the API, so the surface shows
 * the aggregate approved/pending counts instead of inventing one. */
function LearnedRules() {
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void clientFetch('/api/learning')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as LearningSnapshot;
      })
      .then((payload) => {
        if (live) setSnapshot(payload);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // A failed load says nothing here rather than claiming an empty brain; the
  // memory list above is the main story.
  if (failed || !snapshot) return null;
  const counts = snapshot.counts ?? { pending: 0, approved: 0, rejected: 0, total: 0 };
  const approved = (snapshot.examples ?? [])
    .filter((example) => example.status === 'approved')
    .slice(0, 5);

  const ruleFor = (example: LearningExample) =>
    example.correction
      ? // A reviewed correction: what the person taught, in their own words.
        `You corrected an answer — it now says: “${clip(example.effectiveResponse, 140)}”`
      : // An approved demonstration: the answer the person endorsed.
        `You approved this answer: “${clip(example.effectiveResponse, 140)}”`;

  return (
    <section>
      <h3>What your workspace learned</h3>
      <p className="text-sm text-muted-foreground">
        {counts.approved} approved {counts.approved === 1 ? 'example' : 'examples'} your workspace
        applies
        {counts.pending > 0 && ` · ${counts.pending} waiting for your review`}. Nothing here
        re-trains the AI model — your workspace learns from reviewed examples, not by changing model
        weights.
      </p>
      {approved.length > 0 ? (
        <ul>
          {approved.map((example) => (
            <li key={example.id} className="memory-item">
              <p dir="auto">{ruleFor(example)}</p>
              <span className="memory-source">
                From: “{clip(example.prompt, 90)}” · reviewed{' '}
                {dayWord(example.reviewedAt ?? example.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-empty">
          Nothing approved yet — corrections you review land here, and answers start using them.
        </p>
      )}
    </section>
  );
}

const EMPTY_DRAFT = { title: '', content: '', kind: 'reference' as MemoryKind };

export function MemoryPanel() {
  const { memories, counts, recent, loading, failed, refresh, add, update, remove } = useMemory();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [masterBusy, setMasterBusy] = useState(false);

  const attempt = async (work: () => Promise<unknown>) => {
    setNote('');
    try {
      await work();
      return true;
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The change was not saved.');
      return false;
    }
  };

  const needle = search.trim().toLowerCase();
  const matches = (memory: Memory) =>
    !needle || (memory.title + ' ' + memory.content).toLowerCase().includes(needle);
  const suggested = (memories ?? []).filter(
    (memory) => memory.status === 'suggested' && matches(memory),
  );
  const saved = (memories ?? []).filter((memory) => memory.status === 'saved' && matches(memory));

  // The master switch: persistent bulk on/off over saved memories through the
  // same per-item API the row switches use. Suggestions are never touched —
  // no run reads one until accepted.
  const masterOn = saved.some((memory) => memory.enabled);
  // Session incognito: the client-only counterpart to the persistent master
  // switch. It writes nothing to the server — the runs route gates the
  // saved-memory block, the `remember` auto-save and the learning consent on
  // the request flag instead (see lib/memory/incognito.ts). It dies with the
  // tab, so there is no stale "off" to discover later.
  const incognito = useIncognito();
  const flipMaster = async () => {
    const plan = planMemoryMasterToggle(memories ?? []);
    if (plan.ids.length === 0 || masterBusy) return;
    setMasterBusy(true);
    setNote('');
    try {
      for (const id of plan.ids) await update(id, { enabled: plan.enable });
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The change was not saved.');
    } finally {
      setMasterBusy(false);
    }
  };
  const recentRows = recent
    .map((id) => saved.find((memory) => memory.id === id))
    .filter((memory): memory is Memory => !!memory)
    .slice(0, 5);

  const item = (memory: Memory) => {
    if (editing?.id === memory.id)
      return (
        <li key={memory.id} className="memory-item">
          <form
            className="memory-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await attempt(() =>
                update(memory.id, {
                  title: editing.title,
                  content: editing.content,
                  kind: editing.kind,
                  // Editing a suggestion is accepting it in your own words.
                  ...(memory.status === 'suggested' ? { status: 'saved' } : {}),
                }),
              );
              if (ok) setEditing(null);
            }}
          >
            <Input
              aria-label="Title"
              value={editing.title}
              onChange={(event) => setEditing({ ...editing, title: event.target.value })}
            />
            <Textarea
              aria-label="Memory"
              value={editing.content}
              onChange={(event) => setEditing({ ...editing, content: event.target.value })}
            />
            <div className="memory-form-actions">
              <Button type="submit" size="sm">
                <Check size={16} /> Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <X size={16} /> Cancel
              </Button>
            </div>
          </form>
        </li>
      );
    return (
      <li
        key={memory.id}
        id={'memory-' + memory.id}
        className={'memory-item' + (memory.status === 'suggested' ? ' is-suggested' : '')}
      >
        <header>
          {memory.status === 'saved' && (
            <Switch
              aria-label={'Use ' + memory.title}
              checked={memory.enabled}
              onCheckedChange={(enabled) => void attempt(() => update(memory.id, { enabled }))}
            />
          )}
          <strong title={memory.title}>{memory.title}</strong>
          <span className={'memory-chip is-' + memory.provenance}>
            {PROVENANCE[memory.provenance]}
          </span>
        </header>
        <p dir="auto">{memory.content}</p>
        <span className="memory-source">
          {(() => {
            const bits = [memory.kind === 'preference' ? 'Preference' : 'Reference'];
            if (memory.source) bits.push(memory.source);
            // What it learned is above; this is where from, and how often the
            // person’s answers have actually drawn on it.
            bits.push(memory.uses > 0 ? `used ${memory.uses}×` : 'not used yet');
            if (memory.lastUsedAt) bits.push(`last used ${dayWord(memory.lastUsedAt)}`);
            return bits.join(' · ');
          })()}
        </span>
        <div className="memory-actions">
          {memory.status === 'suggested' && (
            <Button
              size="sm"
              onClick={() => void attempt(() => update(memory.id, { status: 'saved' }))}
            >
              <Check size={16} /> Accept
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={'Edit ' + memory.title}
            onClick={() => setEditing(memory)}
          >
            <Pencil size={16} /> Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={'Forget ' + memory.title}
            onClick={() =>
              void attempt(() =>
                // A rejected suggestion is kept, so the same one is not made
                // again; a saved memory forgotten is gone.
                memory.status === 'suggested'
                  ? update(memory.id, { status: 'rejected' })
                  : remove(memory.id),
              )
            }
          >
            <Trash2 size={16} /> Forget
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="memory-panel">
      <h2>
        Memory
        <Button size="sm" variant="outline" onClick={() => setAdding((open) => !open)}>
          <BookmarkPlus size={16} /> Remember something
        </Button>
      </h2>
      {/* The master switch: one honest on/off for every saved memory. Off
       * disables each saved memory through the per-item API (reversible —
       * nothing is deleted); on re-enables them all. */}
      {!loading && !failed && saved.length > 0 && (
        <label className="memory-master">
          <Switch
            aria-label="Memory"
            checked={masterOn}
            disabled={masterBusy}
            onCheckedChange={() => void flipMaster()}
          />
          <span>
            <strong>Memory</strong>
            <span>
              {masterOn
                ? 'On — answers draw on your saved memories.'
                : 'Off — no saved memory is used.'}
            </span>
          </span>
        </label>
      )}
      {!loading && !failed && (
        <label className="memory-master">
          <Switch
            aria-label="Incognito session"
            checked={incognito}
            onCheckedChange={(value) => setIncognito(value)}
          />
          <span>
            <strong>Incognito session</strong>
            <span>
              {incognito
                ? 'On for this session — answers won’t draw on your memories, and nothing is saved or captured automatically. Ends when this tab closes.'
                : 'Off — this session uses memory normally.'}
            </span>
          </span>
        </label>
      )}
      {/* The growth story: what the person owns, and that it is being used.
       * Compounding value made visible — the habit forms from seeing the
       * second brain grow, not from streaks or badges. */}
      {!loading && !failed && memories && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="text-sm font-medium text-foreground">Your second brain</p>
          <p className="text-sm text-muted-foreground">
            {(() => {
              const story = growthStory(memories);
              return `${story.total} ${story.total === 1 ? 'memory' : 'memories'} · ${story.usedThisWeek} used this week`;
            })()}
          </p>
        </div>
      )}
      {/* Honesty, exactly: the workspace learns — reviewed examples, routing
       * the person checks — and no memory here fine-tunes the model. */}
      <p className="text-sm text-muted-foreground">
        Your workspace learns from saved memories and reviewed examples. The AI model itself is
        never re-trained.
      </p>
      {adding && (
        <form
          className="memory-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!draft.content.trim()) return;
            const ok = await attempt(() => add(draft));
            if (ok) {
              setDraft(EMPTY_DRAFT);
              setAdding(false);
            }
          }}
        >
          <Textarea
            aria-label="What to remember"
            placeholder="A preference, a project fact, a reference to reuse…"
            dir="auto"
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
          <Input
            aria-label="Title (optional)"
            placeholder="Title (optional)"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <label className="memory-kind">
            <input
              type="checkbox"
              checked={draft.kind === 'preference'}
              onChange={(event) =>
                setDraft({ ...draft, kind: event.target.checked ? 'preference' : 'reference' })
              }
            />
            A preference — carry it into every answer
          </label>
          <div className="memory-form-actions">
            <Button type="submit" size="sm" disabled={!draft.content.trim()}>
              Save in your own words
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {note && (
        <p className="memory-note" role="alert">
          {note}
        </p>
      )}
      {(memories?.length ?? 0) > 5 && (
        <Input
          type="search"
          aria-label="Search memories"
          placeholder="Search memories"
          dir="auto"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      {loading ? (
        <div className="memory-empty grid gap-2" role="status" aria-label="Loading memories">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-3/6" />
        </div>
      ) : failed ? (
        // Not "nothing saved yet": that sentence is a claim about what this
        // person has written, and a failed load knows nothing about it.
        <p className="memory-empty" role="status">
          Couldn&rsquo;t load your memories.{' '}
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </p>
      ) : (
        <>
          {suggested.length > 0 && (
            <section>
              <h3>To review ({counts.suggested})</h3>
              <ul>{suggested.map(item)}</ul>
            </section>
          )}
          <section>
            <h3>Saved ({counts.saved})</h3>
            {saved.length ? (
              <ul>{saved.map(item)}</ul>
            ) : (
              <p className="memory-empty">
                Nothing saved yet. Write something above, or ask Hikmah to remember a line from your
                message.
              </p>
            )}
          </section>
          {recentRows.length > 0 && (
            <section>
              <h3>Used in recent answers</h3>
              <ul className="memory-recent">
                {recentRows.map((memory) => (
                  <li key={memory.id}>{memory.title}</li>
                ))}
              </ul>
            </section>
          )}
          {/* Learned rules surface: reviewed examples, in plain language.
           * Proposed placement (coordinator): move into a shadcn Tabs on this
           * panel — "Memories" / "What it learned" — when the tab bar lands. */}
          <LearnedRules />
        </>
      )}
    </div>
  );
}

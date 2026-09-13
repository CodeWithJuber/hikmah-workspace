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
import { useState } from 'react';
import { BookmarkPlus, Check, Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useMemory } from '@/hooks/use-memory';
import type { Memory, MemoryKind } from '@/lib/memory/store';

const PROVENANCE: Record<Memory['provenance'], string> = {
  quote: 'Your words',
  source: 'From a source',
  inference: 'Model’s inference',
};

const EMPTY_DRAFT = { title: '', content: '', kind: 'reference' as MemoryKind };

export function MemoryPanel() {
  const { memories, counts, recent, loading, add, update, remove } = useMemory();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');

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
                <Check size={14} /> Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <X size={14} /> Cancel
              </Button>
            </div>
          </form>
        </li>
      );
    return (
      <li
        key={memory.id}
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
          {memory.kind === 'preference' ? 'Preference' : 'Reference'}
          {memory.source ? ' · ' + memory.source : ''}
          {memory.uses > 0 ? ` · used ${memory.uses}×` : ''}
        </span>
        <div className="memory-actions">
          {memory.status === 'suggested' && (
            <Button
              size="sm"
              onClick={() => void attempt(() => update(memory.id, { status: 'saved' }))}
            >
              <Check size={14} /> Accept
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={'Edit ' + memory.title}
            onClick={() => setEditing(memory)}
          >
            <Pencil size={14} /> Edit
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
            <Trash2 size={14} /> Forget
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
          <BookmarkPlus size={14} /> Remember something
        </Button>
      </h2>
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
        <p className="memory-empty">Loading…</p>
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
        </>
      )}
    </div>
  );
}

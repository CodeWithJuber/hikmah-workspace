'use client';
import { randomId } from '../../lib/id.ts';

import { useState } from 'react';
import { BookOpen, Plus, Search, Pencil, Trash2, BrainCircuit, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { usePlayground } from './context';
import { MemoryPanel } from '@/components/chat/memory-panel';
import { type KnowledgeItem, parseKnowledge } from '@/lib/playground/knowledge';
import { toast } from 'sonner';
import { useKernel } from '@/components/kernel/context';
export function KnowledgeEditor({
  value,
  onClose,
  shared = false,
}: {
  value: KnowledgeItem | null;
  onClose: () => void;
  shared?: boolean;
}) {
  const { refreshSharedKnowledge } = usePlayground();
  const [draft, setDraft] = useState(value);
  if (!draft) return null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="knowledge-editor">
        <DialogHeader>
          <DialogTitle>{shared ? 'Publish shared knowledge' : 'Remember this'}</DialogTitle>
          <DialogDescription>
            {shared
              ? 'Published items are available to every signed-in user of this app. Review the source and remove personal information.'
              : 'Review the text before saving. Relevant items are shared with your selected model when you chat.'}
          </DialogDescription>
        </DialogHeader>
        <label>
          Title
          <Input
            aria-label="Knowledge title"
            maxLength={120}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          What should Hikmah remember?
          <Textarea
            aria-label="Knowledge content"
            maxLength={12000}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
        </label>
        <label>
          Use in conversations
          <Select
            value={draft.kind}
            onValueChange={(v) => setDraft({ ...draft, kind: v as KnowledgeItem['kind'] })}
          >
            <SelectTrigger aria-label="Knowledge type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="reference">When relevant to the question</SelectItem>
              <SelectItem value="preference">Always · my preference</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label>
          Source
          <Input
            aria-label="Knowledge source"
            maxLength={300}
            value={draft.source}
            onChange={(e) => setDraft({ ...draft, source: e.target.value })}
          />
        </label>
        <Button
          disabled={!draft.content.trim() || !draft.title.trim()}
          onClick={async () => {
            try {
              const next = parseKnowledge([
                { ...draft, status: 'saved', updatedAt: new Date().toISOString() },
              ]);
              if (shared) {
                const r = await fetch('/api/shared-knowledge', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(next[0]),
                });
                if (!r.ok) throw Error('Shared knowledge could not be published.');
                await refreshSharedKnowledge();
                toast.success('Shared knowledge published.');
              } else {
                // Into the memories table — the store every answer reads — not
                // the workspace blob, which no answer has read since the
                // browser run loop was retired.
                const r = await fetch('/api/memory', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    title: next[0].title,
                    content: next[0].content,
                    kind: next[0].kind,
                    source: next[0].source,
                  }),
                });
                if (!r.ok)
                  throw Error(
                    ((await r.json().catch(() => ({}))) as { error?: string }).error ??
                      'Could not save.',
                  );
                toast.success('Saved to your memory.');
              }
              onClose();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not save.');
            }
          }}
        >
          {shared ? 'Publish shared knowledge' : 'Save knowledge'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
export function newKnowledge(content = '', source = 'Added by you'): KnowledgeItem {
  const now = new Date().toISOString();
  return {
    id: randomId(),
    title: content.slice(0, 75),
    content: content.slice(0, 12000),
    status: 'saved',
    kind: 'reference',
    source,
    createdAt: now,
    updatedAt: now,
    enabled: true,
  };
}
export function Knowledge() {
  const { sharedKnowledge, refreshSharedKnowledge, setWorkspacePage } = usePlayground();
  const kernel = useKernel();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<KnowledgeItem | null>(null);
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  const [error, setError] = useState('');
  const owner = kernel.role === 'super_admin';
  const visible = sharedKnowledge.filter((k) =>
    (k.title + ' ' + k.content).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="knowledge-page">
      <header className="workspace-header">
        <SidebarTrigger />
        <h1>Memory</h1>
        {scope === 'shared' && owner && (
          <Button onClick={() => setDraft(newKnowledge())}>
            <Plus size={16} />
            Publish knowledge
          </Button>
        )}
      </header>
      <div className="knowledge-body">
        <div className="knowledge-intro">
          <BookOpen size={32} />
          <div>
            <h2>A little context goes a long way.</h2>
            <p>Save preferences, project facts and useful references. You choose what stays.</p>
          </div>
        </div>
        <div className="knowledge-tabs" role="group" aria-label="Knowledge scope">
          <Button
            variant={scope === 'personal' ? 'default' : 'ghost'}
            onClick={() => setScope('personal')}
          >
            Personal
          </Button>
          <Button
            variant={scope === 'shared' ? 'default' : 'ghost'}
            onClick={() => setScope('shared')}
          >
            Shared knowledge <span>{sharedKnowledge.length}</span>
          </Button>
        </div>
        <p className="knowledge-scope-note">
          {scope === 'personal'
            ? 'Private to your account, and the store every answer reads. Suggestions wait for your review before use.'
            : 'Published by the owner for everyone in this app. Personal chats are never published automatically.'}
        </p>
        {scope === 'personal' ? (
          /* The same panel as the chat's Memory tab, over the same table. This
             screen used to keep its own list in the workspace blob, which no
             answer could read. */
          <div className="knowledge-personal">
            <MemoryPanel />
          </div>
        ) : (
          <>
            <div className="knowledge-search">
              <Search size={20} />
              <Input
                aria-label="Search knowledge"
                placeholder="Search shared knowledge"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {error && <p role="alert">{error}</p>}
            <div className="knowledge-list">
              {visible.map((item) => (
                <article key={item.id} className="knowledge-card">
                  <header>
                    <BookOpen size={20} />
                    <h3>{item.title}</h3>
                    <span className="status-pill">Owner published</span>
                  </header>
                  <p>{item.content}</p>
                  <footer>
                    <span>
                      {item.kind === 'preference' ? 'Preference' : 'Reference'} · {item.source}
                      <br />
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </span>
                    {owner && (
                      <>
                        <Button
                          variant="ghost"
                          aria-label={'Edit ' + item.title}
                          onClick={() => setDraft(item)}
                        >
                          <Pencil size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={'Forget ' + item.title}
                          onClick={async () => {
                            try {
                              const r = await fetch(
                                '/api/shared-knowledge?id=' + encodeURIComponent(item.id),
                                { method: 'DELETE' },
                              );
                              if (!r.ok) throw Error('Could not remove shared knowledge.');
                              await refreshSharedKnowledge();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Request failed.');
                            }
                          }}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </>
                    )}
                  </footer>
                </article>
              ))}
            </div>
            {!visible.length && (
              <div className="knowledge-empty">
                <BookOpen size={32} />
                <h3>{search ? 'No matching knowledge' : 'Shared knowledge starts with review'}</h3>
                <p>The owner can publish approved facts and references here.</p>
              </div>
            )}
          </>
        )}
        <div className="learning-separation">
          <BrainCircuit size={24} />
          <div>
            <strong>Memory & learning are connected</strong>
            <p>
              Chats preserve experience. Approved knowledge adds context. Your feedback updates
              workflow preferences; reviewed labels train the context model.
            </p>
          </div>
          <Button variant="ghost" onClick={() => setWorkspacePage('learning')}>
            View learning
            <ArrowUpRight size={16} />
          </Button>
        </div>
        <details className="knowledge-learning-details">
          <summary>What happens in real time?</summary>
          <ol>
            <li>
              Every answer retrieves the saved memories relevant to your question — preferences
              always, references when the question shares their words — and its receipt says how
              many it used.
            </li>
            <li>
              Every memory shows where it came from: your own words, a named source, or the model’s
              inference. Only your own words are ever saved without review.
            </li>
            <li>Shared knowledge published by the owner is retrieved the same way.</li>
            <li>
              Feedback updates a measured workflow preference. Parameter training uses reviewed
              examples and a regression gate.
            </li>
          </ol>
          <p>
            Forgetting stops future retrieval. Copies already quoted in past chats and exports
            remain until those are removed.
          </p>
        </details>
      </div>
      {draft && (
        <KnowledgeEditor key={draft.id} value={draft} onClose={() => setDraft(null)} shared />
      )}
    </div>
  );
}

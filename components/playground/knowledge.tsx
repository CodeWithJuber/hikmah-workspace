'use client';
import { randomId } from '../../lib/id.ts';

import { useState } from 'react';
import { BookOpen, Plus, Search, Pencil, Trash2, BrainCircuit, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
  const { knowledge, setKnowledge, refreshSharedKnowledge } = usePlayground();
  const [draft, setDraft] = useState(value);
  if (!draft) return null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="knowledge-editor">
        <DialogHeader>
          <DialogTitle>
            {knowledge.some((k) => k.id === draft.id) ? 'Edit saved knowledge' : 'Remember this'}
          </DialogTitle>
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
                ...knowledge.filter((k) => k.id !== draft.id),
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
                setKnowledge(next);
                toast.success('Knowledge updated. Syncing to your workspace.');
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
  const {
    knowledge,
    setKnowledge,
    sharedKnowledge,
    refreshSharedKnowledge,
    setWorkspacePage,
    storageMessage,
  } = usePlayground();
  const kernel = useKernel();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<KnowledgeItem | null>(null);
  const [scope, setScope] = useState<'personal' | 'shared'>('personal');
  const [error, setError] = useState('');
  const owner = kernel.role === 'super_admin';
  const items = scope === 'shared' ? sharedKnowledge : knowledge;
  const visible = items.filter((k) =>
    (k.title + ' ' + k.content).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="knowledge-page">
      <header className="workspace-header">
        <SidebarTrigger />
        <h1>Memory</h1>
        {(scope === 'personal' || owner) && (
          <Button onClick={() => setDraft(newKnowledge())}>
            <Plus size={17} />
            {scope === 'shared' ? 'Publish knowledge' : 'Remember something'}
          </Button>
        )}
      </header>
      <div className="knowledge-body">
        <div className="knowledge-intro">
          <BookOpen size={30} />
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
            Personal <span>{knowledge.length}</span>
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
            ? 'Private to your account. New suggestions wait for your review before use.'
            : 'Published by the owner for everyone in this app. Personal chats are never published automatically.'}
        </p>
        {scope === 'personal' && knowledge.some((k) => k.status === 'suggested') && (
          <div className="memory-review-banner" role="status">
            <span>
              <strong>
                {knowledge.filter((k) => k.status === 'suggested').length} suggestions
              </strong>{' '}
              waiting for your review
            </span>
            <Button onClick={() => setDraft(knowledge.find((k) => k.status === 'suggested')!)}>
              Review next
            </Button>
          </div>
        )}
        <div className="knowledge-search">
          <Search size={18} />
          <Input
            aria-label="Search knowledge"
            placeholder="Search your knowledge"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="knowledge-list">
          {visible.map((item) => (
            <article
              key={item.id}
              className={'knowledge-card' + (item.status === 'suggested' ? ' suggested' : '')}
            >
              <header>
                <BookOpen size={18} />
                <h3>{item.title}</h3>
                {item.status === 'suggested' ? (
                  <span className="status-pill">Review suggestion</span>
                ) : scope === 'personal' ? (
                  <Switch
                    aria-label={'Use ' + item.title}
                    checked={item.enabled}
                    onCheckedChange={(enabled) =>
                      setKnowledge((items) =>
                        items.map((k) => (k.id === item.id ? { ...k, enabled } : k)),
                      )
                    }
                  />
                ) : (
                  <span className="status-pill">Owner published</span>
                )}
              </header>
              <p>{item.content}</p>
              <footer>
                <span>
                  {item.kind === 'preference' ? 'Preference' : 'Reference'} · {item.source}
                  <br />
                  {new Date(item.updatedAt).toLocaleDateString()}
                </span>
                {(scope === 'personal' || owner) && (
                  <>
                    <Button
                      variant="ghost"
                      aria-label={'Edit ' + item.title}
                      onClick={() => setDraft(item)}
                    >
                      {item.status === 'suggested' ? 'Review' : <Pencil size={16} />}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={'Forget ' + item.title}
                      onClick={async () => {
                        if (scope === 'shared') {
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
                        } else {
                          setKnowledge((items) => items.filter((k) => k.id !== item.id));
                          toast('Removed from future retrieval', {
                            action: {
                              label: 'Undo',
                              onClick: () =>
                                setKnowledge((items) => [
                                  item,
                                  ...items.filter((k) => k.id !== item.id),
                                ]),
                            },
                          });
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
            <BookOpen size={34} />
            <h3>
              {search
                ? 'No matching knowledge'
                : scope === 'shared'
                  ? 'Shared knowledge starts with review'
                  : 'Start with something useful'}
            </h3>
            <p>
              {scope === 'shared'
                ? 'The owner can publish approved facts and references here.'
                : 'Your preferences, a project brief, or a fact to reuse. Choose Remember on a message, or ask Hikmah to suggest a memory.'}
            </p>
            {(scope === 'personal' || owner) && (
              <Button variant="outline" onClick={() => setDraft(newKnowledge())}>
                Add an item
              </Button>
            )}
          </div>
        )}
        <div className="learning-separation">
          <BrainCircuit size={23} />
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
            <li>Messages and tool receipts are saved as the task progresses.</li>
            <li>
              The model can suggest a memory from your exact words. Suggestions are excluded until
              approved.
            </li>
            <li>
              Relevant personal and shared knowledge is retrieved for the next request. Each answer
              shows which items were used.
            </li>
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
        <p className="knowledge-research-link">
          <a href="/research/v7/memory-research.md" target="_blank" rel="noreferrer">
            Memory research, Quranic context & equations ↗
          </a>
        </p>
        <p className="knowledge-save" role="status">
          {storageMessage}
        </p>
      </div>
      {draft && (
        <KnowledgeEditor
          key={draft.id}
          value={draft}
          shared={scope === 'shared'}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

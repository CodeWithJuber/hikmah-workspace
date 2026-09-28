'use client';
/** "Why different?" — exactly what the workspace added to this answer.
 *
 * Every row is something the run recorded, not something the panel inferred:
 * recalled memory rows and conversations come from the worker's
 * `data-memories` chunk, reviewed examples from the same lexical match the
 * server uses to inject them, tools from the stream's tool chunks. Nothing
 * here is a claim about the model's weights — the copy says "your workspace
 * learns", never "your model learns".
 */
import Link from 'next/link';
import { Brain, CheckCheck, History, Wrench } from 'lucide-react';
import type { LearningExample } from '@/lib/learning/types';
import type { LaneFold } from '@/lib/compare/evidence';
import { Badge } from '@/components/ui/badge';

export type MemoryLookup = Map<string, { uses: number }>;

const count = (value: number) => new Intl.NumberFormat('en-US').format(value);

function Row({
  icon,
  title,
  detail,
  href,
  linkLabel,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Link
        href={href}
        className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline"
      >
        {linkLabel}
      </Link>
    </li>
  );
}

export function EvidencePanel({
  fold,
  matchedExamples,
  memoryUses,
  busy,
}: {
  /** The folded Hikmah run. */
  fold: LaneFold;
  /** Reviewed examples the server would have injected for this question. */
  matchedExamples: LearningExample[];
  /** Memory id -> times the person has used it, for honest "used N times". */
  memoryUses: MemoryLookup;
  /** The run is still streaming; counts may grow. */
  busy: boolean;
}) {
  const hasAny =
    fold.memories.length > 0 ||
    fold.conversations.length > 0 ||
    matchedExamples.length > 0 ||
    fold.tools.length > 0;

  return (
    <section aria-label="Why the answers differ" className="mt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">Why different?</h3>
        {busy && (
          <span className="text-xs text-muted-foreground" role="status">
            Still reading the run…
          </span>
        )}
      </div>
      {!hasAny ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          The workspace added nothing this turn — the model answered from the prompt alone. Teach it
          something and this panel starts naming what it used.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {fold.memories.map((memory) => {
            const uses = memoryUses.get(memory.id)?.uses;
            return (
              <Row
                key={memory.id}
                icon={<Brain size={16} />}
                title={memory.title || 'Untitled memory'}
                detail={`From your saved memory${uses ? ` · used ${count(uses)} ${uses === 1 ? 'time' : 'times'}` : ''}`}
                href="/knowledge"
                linkLabel="View memory"
              />
            );
          })}
          {fold.conversations.map((conversation) => (
            <Row
              key={conversation.id}
              icon={<History size={16} />}
              title={conversation.title || 'Earlier conversation'}
              detail="Recalled from your conversation history"
              href={`/chat/${encodeURIComponent(conversation.id)}`}
              linkLabel="Open chat"
            />
          ))}
          {matchedExamples.map((example) => (
            <Row
              key={example.id}
              icon={<CheckCheck size={16} />}
              title={example.prompt.slice(0, 90) + (example.prompt.length > 90 ? '…' : '')}
              detail="A reviewed example you approved — used as reference, not as fact"
              href="/learning"
              linkLabel="Review"
            />
          ))}
          {fold.tools.length > 0 && (
            <li className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5">
              <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
                <Wrench size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {count(fold.tools.length)} {fold.tools.length === 1 ? 'tool ran' : 'tools ran'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {fold.tools.map((tool) => tool.name).join(', ')}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {fold.tools.some((tool) => tool.state === 'error' || tool.state === 'denied') && (
                  <Badge variant="destructive">some did not succeed</Badge>
                )}
              </div>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

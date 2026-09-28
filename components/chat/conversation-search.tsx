'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type SearchableMessage = {
  /** The message row id the parent scrolls to. */
  id: string;
  /** Plain text of the message; matching is case-insensitive on this. */
  text: string;
};

/**
 * In-conversation search (Chat v2).
 *
 * Props:
 * - messages: [{id, text}] for the open conversation. The component matches
 *   against `text` only; it never reads parts or markdown.
 * - onJump(id): the parent scrolls the message row into view and, if it
 *   wants, highlights it. The component is pure search state — jumping is
 *   the parent's job because only the parent owns the scroll container.
 *
 * Mount near the composer (the report puts it by the input, §2.2): a small
 * row the parent shows/hides, or always renders. Enter/Shift+Enter cycles
 * through matches; the "2/7" counter shows position; Esc clears the query.
 */
export function ConversationSearch({
  messages,
  onJump,
  className,
}: {
  messages: SearchableMessage[];
  onJump: (id: string) => void;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return messages.filter((m) => m.text.toLowerCase().includes(q));
  }, [messages, query]);

  const at = matches.length > 0 ? index % matches.length : 0;

  const cycle = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      setIndex((i) => (i + direction + matches.length) % matches.length);
    },
    [matches.length],
  );

  // Jump as the match moves: cycling, or a new query landing on results.
  useEffect(() => {
    if (matches.length > 0) onJump(matches[at].id);
    // onJump scrolls; it must not re-run the effect, only the match position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, matches.length, query]);

  const clear = () => {
    setQuery('');
    setIndex(0);
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn('flex w-full max-w-md items-center gap-2', className)}
      role="search"
      aria-label="Search in conversation"
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              cycle(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              clear();
            }
          }}
          placeholder="Search in this conversation"
          aria-label="Search in this conversation"
          className="pl-9 pr-8"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={clear}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 size-6 -translate-y-1/2"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <div
        className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {query.trim() && (matches.length > 0 ? `${at + 1}/${matches.length}` : '0/0')}
      </div>
    </div>
  );
}

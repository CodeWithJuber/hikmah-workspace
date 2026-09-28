'use client';
/** One answer pane of the compare view.
 *
 * The two panes are deliberately near-identical chrome: same size, same
 * receipt line, same waiting states. The only deliberate asymmetry is the
 * caption under each — "the model alone, nothing added" on the left, the
 * workspace's additions on the right — because that asymmetry is the product.
 */
import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { LaneSnapshot, LaneStatus } from './use-compare-lane';

const count = (value: number) => new Intl.NumberFormat('en-US').format(value);

function tokensOf(snapshot: LaneSnapshot): string | null {
  const { inputTokens, outputTokens, totalTokens } = snapshot.fold.meta;
  const total =
    (totalTokens ?? (inputTokens !== undefined || outputTokens !== undefined))
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  return total === undefined ? null : `${count(total)} tokens`;
}

const statusLine = (status: LaneStatus, stage: string): ReactNode => {
  if (status === 'streaming')
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
      >
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        {stage}
      </span>
    );
  return null;
};

export function ComparePane({
  badge,
  title,
  caption,
  snapshot,
  stage,
  annotation,
  empty,
  footer,
  children,
}: {
  /** "Raw AI" / "Hikmah". */
  badge: string;
  title: string;
  /** One plain line saying what this pane is. */
  caption: string;
  snapshot: LaneSnapshot;
  /** What the lane is doing right now, in words ("Using web search…"). */
  stage: string;
  /** The aha-moment annotation, rendered above the answer when set. */
  annotation?: ReactNode;
  /** Shown instead of an answer when the lane never ran. */
  empty?: ReactNode;
  /** Under-answer line: "Nothing added" on the left, the receipt on the right. */
  footer: ReactNode;
  /** The evidence panel, on the Hikmah pane. */
  children?: ReactNode;
}) {
  const { status, fold, error, latencyMs } = snapshot;
  const ran = status !== 'idle';
  const tokens = tokensOf(snapshot);

  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col rounded-lg border border-border bg-card"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{badge}</Badge>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
        </div>
        {statusLine(status, stage)}
      </header>

      <div className="flex min-h-[220px] flex-1 flex-col px-4 py-3">
        {annotation}
        {!ran && empty}
        {ran && !fold.text && status === 'streaming' && (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}
        {ran && !fold.text && status !== 'streaming' && !error && (
          <p className="text-sm text-muted-foreground">The model returned no text.</p>
        )}
        {fold.text && (
          <div className="min-w-0 text-sm">
            <MessageResponse isAnimating={status === 'streaming'}>{fold.text}</MessageResponse>
          </div>
        )}
        {error && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      {ran && !error && (
        <footer className="border-t border-border px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {footer}
            {fold.meta.model && <span title="The model that answered">{fold.meta.model}</span>}
            {tokens && <span title="Tokens this answer used">{tokens}</span>}
            {latencyMs !== null && (
              <span title="Time from send to the last token">{(latencyMs / 1000).toFixed(1)}s</span>
            )}
          </div>
        </footer>
      )}
      {ran && !error && children ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  );
}

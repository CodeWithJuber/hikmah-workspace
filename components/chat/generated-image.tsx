'use client';
/**
 * Renders one generated image inside a chat message (Chat v2, WS4).
 *
 * The parent mounts this for the `file` part the images route stores:
 * `part.type === 'file'` and `part.mediaType` starting with `image/` (the
 * message metadata also carries `image: true`). Props are plain values so
 * the parent can pass them straight from the part:
 *
 *   <GeneratedImage url={part.url} alt={message.metadata?.prompt} model={message.metadata?.model} />
 *
 * The image is rounded and height-capped; the footer shows the model badge
 * and a download button. A URL that fails to load renders an inline error
 * state instead of a broken image icon.
 */
import { useEffect, useState } from 'react';
import { Download, ImageOff, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export function GeneratedImage({
  url,
  alt,
  model,
}: {
  /** The image URL — an `/api/media/assets/...` URL or the provider's URL. */
  url: string;
  /** Alt text; the generation prompt when the parent has it. */
  alt?: string;
  /** The image model id, shown as a badge. */
  model?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A new URL is a new image: reset the error during render (the documented
  // pattern for prop-derived state), then probe the URL in an effect rather
  // than an onError handler, which the a11y rules do not want on <img>.
  const [seenUrl, setSeenUrl] = useState(url);
  if (seenUrl !== url) {
    setSeenUrl(url);
    setFailed(false);
  }
  useEffect(() => {
    const probe = new window.Image();
    probe.onerror = () => setFailed(true);
    probe.src = url;
    return () => {
      probe.onerror = null;
      probe.src = '';
    };
  }, [url]);

  if (failed)
    return (
      <div
        className="flex w-full max-w-md items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground"
        role="img"
        aria-label="The generated image could not be loaded."
      >
        <ImageOff className="size-4 shrink-0" aria-hidden />
        <span>The generated image could not be loaded.</span>
      </div>
    );

  return (
    <figure className="w-full max-w-md">
      {/* Not next/image: generated at request time behind an owner-scoped
          route, so there is nothing for the optimiser to pre-process and a
          loader would only add a hop. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt || 'Generated image'}
        className="h-auto max-h-[420px] w-full rounded-xl border border-border object-contain"
        loading="lazy"
      />
      <figcaption className="mt-1.5 flex flex-wrap items-center gap-2">
        {model ? (
          <Badge variant="secondary" className="font-mono text-[11px]" title="Image model">
            {model}
          </Badge>
        ) : null}
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" asChild>
          <a href={url} download aria-label="Download generated image">
            <Download className="size-3.5" aria-hidden />
            Download
          </a>
        </Button>
      </figcaption>
    </figure>
  );
}

/**
 * Honest progress indication while the image POST is in flight — mounted by
 * the parent where the finished `GeneratedImage` will appear, so the thread
 * never shows a dead spinner or a gap. A live elapsed-seconds ticker says
 * the request is actually progressing; the copy sets the expectation (image
 * models are slow). Pass `onCancel` when the parent can abort the request;
 * otherwise no cancel button is shown.
 */
export function ImageGeneratingState({
  prompt,
  onCancel,
}: {
  /** The prompt being generated, shown truncated as a reminder. */
  prompt: string;
  /** Called when the person cancels. Optional. */
  onCancel?: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className="w-full max-w-md rounded-xl border border-[#17664f]/25 bg-[#17664f]/[0.04] p-4 dark:border-[#17664f]/40 dark:bg-[#17664f]/10"
      role="status"
      aria-live="polite"
      data-testid="image-generating"
    >
      <div className="flex items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-[#17664f]/12 text-[#17664f] dark:bg-[#17664f]/25 dark:text-[#7fd6ae]">
          <Sparkles className="size-4 animate-pulse" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Generating your image…</p>
          <p className="truncate text-xs text-muted-foreground" title={prompt}>
            {prompt}
          </p>
        </div>
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {elapsed}s
        </span>
      </div>
      <div
        className="mt-3 aspect-square w-full animate-pulse rounded-lg bg-gradient-to-br from-[#17664f]/15 via-[#17664f]/5 to-transparent"
        aria-hidden
      />
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Usually takes under a minute.</p>
        {onCancel ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

'use client';
/**
 * The composer hint for the `/image` command (Chat v2, WS4).
 *
 * Props-driven on purpose: the parent decides when the composer text starts
 * a command (e.g. `IMAGE_COMMANDS.some((c) => text.startsWith(c))`) and
 * mounts `<ImageCommandHint visible={...} />` under the composer. This file
 * owns the command spellings and the hint's look, nothing else.
 */
import { ImagePlus, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** The slash commands that trigger image generation. */
export const IMAGE_COMMANDS = ['/image', '/imagine'];

export function ImageCommandHint({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="flex justify-start px-1 pb-1" data-testid="image-command-hint">
      <Badge
        variant="secondary"
        className="gap-1.5 border border-primary/25 bg-primary/8 py-1 pr-3 pl-2 text-primary dark:border-primary/40 dark:bg-primary/15"
      >
        <Sparkles className="size-3.5" aria-hidden />
        <span className="font-medium">Image mode</span>
        <span className="font-normal opacity-80">— describe the picture after</span>
        <kbd className="rounded bg-primary/12 px-1 py-px font-mono text-[11px] font-semibold dark:bg-white/10">
          /image
        </kbd>
      </Badge>
    </div>
  );
}

/**
 * The one subtle composer button for image generation (progressive
 * disclosure: the command stays discoverable without touching the send
 * flow). The parent places it beside the composer actions and wires
 * `onInsert` to put `/image ` at the composer caret; the hint chip above
 * takes over from there.
 */
export function ImageCommandButton({ onInsert }: { onInsert: (prefix: string) => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground hover:text-primary"
      title="Generate an image (/image)"
      aria-label="Generate an image"
      onClick={() => onInsert('/image ')}
      data-testid="image-command-button"
    >
      <ImagePlus className="size-4" aria-hidden />
    </Button>
  );
}

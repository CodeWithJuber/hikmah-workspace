'use client';
/** Create or rename a project folder.
 *
 * One dialog for both, because the only difference is the title and the
 * starting text in the field. The parent passes `saving` and `error` so the
 * network round trip stays outside this presentational piece.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function ProjectDialog({
  open,
  onOpenChange,
  mode,
  initialName,
  saving,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'create' for a fresh folder, 'rename' for an existing one. */
  mode: 'create' | 'rename';
  initialName?: string;
  saving: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the field each time the dialog opens: a stale rename from last time
  // would otherwise sit in the create box. Done during render (guarded, so it
  // is idempotent) rather than in an effect.
  const [seenKey, setSeenKey] = useState<string>('closed');
  const openKey = open ? `open:${initialName ?? ''}` : 'closed';
  if (openKey !== seenKey) {
    setSeenKey(openKey);
    if (open) setName(initialName ?? '');
  }

  // Focus the field on open. A ref + effect rather than the autoFocus prop,
  // which yanks focus in ways assistive technology cannot predict.
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New project' : 'Rename project'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Projects are folders for your conversations. A conversation can live in at most one.'
              : 'Renaming a project does not move its conversations.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Project name"
          aria-label="Project name"
          maxLength={120}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : mode === 'create' ? 'Create project' : 'Rename'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

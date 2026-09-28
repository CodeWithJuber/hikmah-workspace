'use client';

import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  EXISTING_SHORTCUTS,
  SHORTCUTS,
  isMacPlatform,
  shortcutKeys,
  type Shortcut,
} from '@/lib/chat/shortcuts';

/** One <kbd> badge: the bordered key-cap style the report's LibreChat set
 * wears (report §2.7, 2.8). */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted px-1.5 text-[11px] font-medium text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.06)] dark:shadow-[0_1px_0_rgba(255,255,255,0.08)]">
      {children}
    </kbd>
  );
}

function Row({ label, keys, hint }: { label: string; keys: string[]; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div
        className="flex shrink-0 items-center gap-1"
        aria-label={`${label}: ${keys.join(' + ')}`}
      >
        {keys.map((k) => (
          <Key key={k}>{k}</Key>
        ))}
      </div>
    </div>
  );
}

/**
 * The keyboard-shortcut reference dialog (report §2.7).
 *
 * Props: {open, onOpenChange} — the parent wires `open-shortcuts-dialog`
 * (Cmd/Ctrl+/) from useKeyboardShortcuts to setOpen(true), and keeps the
 * kill-switch state itself: when shortcuts are disabled in settings the
 * parent should not render the button that opens this.
 *
 * Labels are ⌘/Ctrl-aware: ⌘ glyphs on macOS, Ctrl wording everywhere else.
 * Mounted at the app shell (next to the chat view), not inside the
 * composer — it describes chords that reach the whole window.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mac = useMemo(() => isMacPlatform(), []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Chords are shown for {mac ? 'macOS (⌘)' : 'Windows and Linux (Ctrl)'}.
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border">
          {SHORTCUTS.map((s: Shortcut) => (
            <Row key={s.id} label={s.label} keys={shortcutKeys(s, mac)} />
          ))}
        </div>
        <div className="pt-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Already bound elsewhere
          </div>
          <div className="divide-y divide-border">
            {EXISTING_SHORTCUTS.map((s) => (
              <Row
                key={s.id}
                label={s.label}
                keys={mac ? s.mac : s.win}
                hint="Kept as-is; not listed above because it is not this dialog's shortcut."
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

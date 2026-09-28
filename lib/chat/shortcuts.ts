/** Keyboard shortcuts for the chat surface (Chat v2).
 *
 * The reference is LibreChat v0.8.7's shortcut set (report §2.7): 11
 * shortcuts, ⌘/Ctrl-aware labels rendered as kbd badges, and a master
 * kill-switch that stops the UI advertising the chords when off.
 *
 * Two deliberate differences from LibreChat:
 * - focus-composer is Cmd/Ctrl+J, not a bare `/`: a bare slash would fire
 *   while typing (and conflicts with command palettes), and Ctrl+J is
 *   reserved by nothing in this app. Cmd+K is NOT rebound — it already opens
 *   the app's global search, and is listed below as `EXISTING_SHORTCUTS` so
 *   the dialog can show it without claiming it.
 * - stop-generation (Esc) is the one chord that fires from inside a text
 *   field, because the moment you most need it your fingers are in the
 *   composer. Every other chord is ignored while typing.
 */

import { useEffect, useRef } from 'react';

/** A physical chord: which modifiers and which key, normalised for matching. */
export type ShortcutChord = {
  /** Cmd on macOS, Ctrl everywhere else. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Compared against KeyboardEvent.key case-insensitively; 'Escape' as-is. */
  key: string;
};

export type Shortcut = {
  id: string;
  /** What the dialog row says. */
  label: string;
  /** Rendered on macOS, as kbd badges. */
  mac: string[];
  /** Rendered everywhere else, as kbd badges. */
  win: string[];
  /** The physical chord this entry matches. */
  chord: ShortcutChord;
  /** Fires while the caret is in an input, textarea or contenteditable. */
  inField?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'new-chat',
    label: 'New chat',
    mac: ['⌘', '⇧', 'O'],
    win: ['Ctrl', 'Shift', 'O'],
    chord: { mod: true, shift: true, key: 'o' },
  },
  {
    id: 'focus-composer',
    label: 'Focus the composer',
    mac: ['⌘', 'J'],
    win: ['Ctrl', 'J'],
    chord: { mod: true, key: 'j' },
  },
  {
    id: 'toggle-sidebar',
    label: 'Toggle sidebar',
    mac: ['⌘', '.'],
    win: ['Ctrl', '.'],
    chord: { mod: true, key: '.' },
  },
  {
    id: 'open-shortcuts-dialog',
    label: 'Show keyboard shortcuts',
    mac: ['⌘', '/'],
    win: ['Ctrl', '/'],
    chord: { mod: true, key: '/' },
  },
  {
    id: 'stop-generation',
    label: 'Stop generating',
    mac: ['Esc'],
    win: ['Esc'],
    chord: { key: 'Escape' },
    inField: true,
  },
  {
    id: 'scroll-bottom',
    label: 'Scroll to latest message',
    mac: ['⌘', 'End'],
    win: ['Ctrl', 'End'],
    chord: { mod: true, key: 'End' },
  },
];

/** Chords this app binds but which this module does not own. Shown in the
 * dialog under "already bound" so a person does not hunt for them here. */
export const EXISTING_SHORTCUTS: { id: string; label: string; mac: string[]; win: string[] }[] = [
  { id: 'global-search', label: 'Global search', mac: ['⌘', 'K'], win: ['Ctrl', 'K'] },
];

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent ?? '');
}

/** The badges to render for a shortcut on this platform. */
export function shortcutKeys(shortcut: Shortcut, mac: boolean): string[] {
  return mac ? shortcut.mac : shortcut.win;
}

function chordMatches(
  chord: ShortcutChord,
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
): boolean {
  const mod = event.metaKey || event.ctrlKey;
  if (!!chord.mod !== mod) return false;
  if (!!chord.shift !== event.shiftKey) return false;
  if (!!chord.alt !== event.altKey) return false;
  return chord.key.toLowerCase() === (event.key ?? '').toLowerCase();
}

/**
 * Which shortcut, if any, a keydown event triggers.
 *
 * Pure: given a DOM-like key event and whether the event target is a text
 * field, returns the matching shortcut or null. The kill-switch is the
 * `enabled` flag — when false nothing matches, and the dialog stops
 * advertising the chords (report §2.7).
 */
export function matchShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  options: { inField?: boolean; enabled?: boolean } = {},
): Shortcut | null {
  if (options.enabled === false) return null;
  const inField = options.inField ?? false;
  for (const shortcut of SHORTCUTS) {
    if (inField && !shortcut.inField) continue;
    if (chordMatches(shortcut.chord, event)) return shortcut;
  }
  return null;
}

/** Whether a keydown target is somewhere the person is typing. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

export type ShortcutHandlers = Partial<Record<Shortcut['id'], () => void>>;

/**
 * Wire the shortcut set to the window.
 *
 * `handlers` names the shortcut ids to handle; unhandled ids do nothing.
 * `enabled` is the master kill-switch (settings master switch, report §2.7):
 * off means no chord fires and the dialog should not advertise them. Typing
 * in a field suppresses every chord except stop-generation (Esc).
 */
export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;
  // The parent passes an object literal most renders; subscribing on its
  // identity would re-add the listener every frame. The ref keeps the latest
  // handlers while the subscription lives only as long as `enabled`.
  const handlersRef = useRef(handlers);
  // A passive effect keeps the latest handlers without touching the ref
  // during render (writing handlersRef.current in render breaks eslint's
  // react-hooks/refs rule and can tear under concurrent rendering).
  useEffect(() => {
    handlersRef.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Let the browser keep its own system chords (e.g. Cmd+W): ours never
      // compete with those, and swallowing one would trap the tab.
      if (event.defaultPrevented) return;
      const shortcut = matchShortcut(event, { inField: isEditableTarget(event.target), enabled });
      if (!shortcut) return;
      const handler = handlersRef.current[shortcut.id];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

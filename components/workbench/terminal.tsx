'use client';
/** xterm reads `document` while it loads, so the panel is client-only. */
import dynamic from 'next/dynamic';

export const Terminal = dynamic(
  () => import('./terminal-panel').then((module) => module.TerminalPanel),
  {
    ssr: false,
    loading: () => <div className="p-3 text-xs text-muted-foreground">Loading the terminal…</div>,
  },
);

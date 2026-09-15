'use client';
/** The interactive terminal.
 *
 * xterm renders and the workbench runs the shell; this component is only the
 * wire between them. It is loaded through `./terminal` so that xterm, which
 * touches `document` at import time, never reaches the server bundle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RotateCw, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { closeReason, controlFrame, encodeInput, refusedReason } from '@/lib/workbench/protocol';
import { clientFetch } from '@/lib/client/request';

type Status =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; reason: string }
  | { state: 'error'; reason: string };

/** Read the CSS variables so the shell matches the rest of the workspace
 * instead of being a black rectangle pasted into it. */
function themeFrom(element: HTMLElement) {
  const styles = getComputedStyle(element);
  const value = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value('--card', '#0b0f14'),
    foreground: value('--card-foreground', '#e6edf3'),
    cursor: value('--primary', '#e6edf3'),
    selectionBackground: value('--muted', '#30363d'),
  };
}

export function TerminalPanel({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'connecting' });
  const [attempt, setAttempt] = useState(0);

  const reconnect = useCallback(() => {
    setStatus({ state: 'connecting' });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let disposed = false;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: themeFrom(container),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();

    // The ticket is single-use and lives 30 seconds, so it is fetched per
    // connection rather than held anywhere.
    const start = async () => {
      let url: string;
      try {
        const response = await clientFetch('/api/workbench/ticket', { method: 'POST' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Could not open a terminal.');
        url = body.url;
      } catch (error) {
        if (disposed) return;
        const reason = error instanceof Error ? error.message : 'Could not open a terminal.';
        setStatus({ state: 'error', reason });
        terminal.writeln(`\r\n\x1b[31m${reason}\x1b[0m`);
        return;
      }
      if (disposed) return;

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      socket.current = ws;

      // A handshake that never completed is a refusal, not a dropped session,
      // and the two need different words: one means "this did not start", the
      // other means "this ended". Browsers report every failed handshake as
      // close code 1006 with no detail, and onclose fires after onerror, so
      // without this flag the refusal was always overwritten by "The
      // connection dropped." — which is what the terminal said for months
      // while the real cause was a proxy path mismatch.
      let opened = false;

      ws.onopen = () => {
        opened = true;
        setStatus({ state: 'open' });
        // The shell starts at 80x24; tell it the real size before the first
        // prompt is drawn, or full-screen programs open at the wrong size.
        ws.send(controlFrame({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        terminal.focus();
      };
      ws.onmessage = (event) => {
        terminal.write(
          typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer),
        );
      };
      ws.onclose = (event) => {
        if (disposed) return;
        if (opened) setStatus({ state: 'closed', reason: closeReason(event.code) });
        else setStatus({ state: 'error', reason: refusedReason(event.code) });
      };
      ws.onerror = () => {
        // Left to onclose, which always follows and knows whether the session
        // ever opened. Setting a reason here only to have it replaced a
        // millisecond later is how the useful half got lost.
      };
      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeInput(data));
      });
    };
    void start();

    // Resize on layout change as well as window resize: the panel is inside a
    // resizable split, which the window event never sees.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* the panel is hidden, so there is nothing to fit */
      }
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(controlFrame({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      socket.current?.close();
      socket.current = null;
      terminal.dispose();
    };
  }, [attempt]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TerminalSquare className="size-3.5" aria-hidden />
          Terminal
        </span>
        <span className="flex items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            className={status.state === 'open' ? 'text-muted-foreground' : 'text-destructive'}
          >
            {status.state === 'connecting' && 'Connecting…'}
            {status.state === 'open' && 'Connected'}
            {(status.state === 'closed' || status.state === 'error') && status.reason}
          </span>
          {status.state !== 'open' && status.state !== 'connecting' && (
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={reconnect}>
              <RotateCw className="size-3" aria-hidden />
              Reconnect
            </Button>
          )}
        </span>
      </div>
      <div
        ref={host}
        className="h-full min-h-48 w-full"
        // xterm needs a focusable host to receive keystrokes at all.
        tabIndex={-1}
        aria-label="Terminal"
      />
    </div>
  );
}

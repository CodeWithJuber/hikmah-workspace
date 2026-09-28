'use client';
/** A page from the workspace, full screen.
 *
 * The preview used to live inside the Files drawer at 320px tall, which on a
 * phone was a letterbox and on a desktop a thumbnail. This takes the whole
 * viewport, the way an artifact opens in the products people know: the page,
 * a phone/desktop width switch, its console, a link that can be copied, and a
 * way to open it in its own tab.
 *
 * The frame is sandboxed with no origin. The page is the owner's, but it was
 * written by a model, and on this host it must not become the signed-in
 * person. Its console reaches this window only through the postMessage bridge
 * the server adds to every served page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2, Monitor, Smartphone, TerminalSquare, X } from 'lucide-react';
import { copyText } from '@/components/playground/error-card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function PagePreview({
  href,
  title,
  onClose,
}: {
  /** The served page, under its preview token. */
  href: string;
  title: string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState<'phone' | 'desktop'>('desktop');
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data as { source?: string; level?: string; text?: string } | null;
      if (
        event.source !== frame.current?.contentWindow ||
        !data ||
        data.source !== 'hikmah-preview' ||
        typeof data.text !== 'string'
      )
        return;
      setLogs((lines) =>
        [
          ...lines,
          `${data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log'}: ${data.text!.slice(0, 1500)}`,
        ].slice(-80),
      );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  const copy = useCallback(async () => {
    await copyText(new URL(href, window.location.origin).toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [href]);

  if (typeof document === 'undefined') return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* The base dialog styles assume a centred card; the preview is a full
          viewport surface, so the centred-card utilities are overridden here.
          The `.page-preview` rules in chat.css own the layout. */}
      <DialogContent
        className="page-preview top-0 left-0 flex max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 shadow-none"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{`Preview of ${title}`}</DialogTitle>
        </DialogHeader>
        <header className="page-preview-bar">
          <strong dir="auto">{title}</strong>
          <div className="page-preview-width" role="group" aria-label="Preview width">
            <button
              type="button"
              aria-pressed={width === 'phone'}
              title="Phone width"
              onClick={() => setWidth('phone')}
            >
              <Smartphone size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={width === 'desktop'}
              title="Full width"
              onClick={() => setWidth('desktop')}
            >
              <Monitor size={16} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            title="Copy a private link, valid for a week"
          >
            <Link2 size={16} aria-hidden="true" />
            <span>{copied ? 'Copied' : 'Copy link'}</span>
          </button>
          <a href={href} target="_blank" rel="noopener noreferrer" title="Open in a new tab">
            <ExternalLink size={16} aria-hidden="true" />
            <span>New tab</span>
          </a>
          <button
            type="button"
            aria-pressed={showLogs}
            title="Console"
            onClick={() => setShowLogs((value) => !value)}
          >
            <TerminalSquare size={16} aria-hidden="true" />
            {logs.length > 0 && <span className="page-preview-count">{logs.length}</span>}
          </button>
          <button type="button" aria-label="Close preview" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className={'page-preview-stage' + (width === 'phone' ? ' is-phone' : '')}>
          <iframe
            ref={frame}
            title={title}
            src={href}
            // Scripts, forms, popups and downloads, and nothing that would make
            // the page this origin.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
          />
        </div>
        {showLogs && (
          <div className="page-preview-console" aria-label="Preview console">
            {logs.length === 0 ? (
              <p>Nothing logged yet.</p>
            ) : (
              logs.map((line, index) => <p key={index}>{line}</p>)
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

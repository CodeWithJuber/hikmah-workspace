'use client';
/** The workspace beside the conversation.
 *
 * The agent writes files with `write_file`; this is where they are read, edited
 * and run. It talks to `/api/workspace/files` rather than the workspace blob,
 * so the files here are the same rows the tools wrote — which is why this is a
 * rewrite rather than a port of `components/playground/code-workspace.tsx`:
 * that one is bound to `usePlayground().files`, and `validateFiles` rejects the
 * nested paths (`src/app.ts`) the server store deliberately allows.
 *
 * Three things are reused rather than rebuilt: the CodeMirror editor, the
 * preview document builder that puts a restrictive CSP ahead of the page, and
 * the console bridge that forwards the preview's own console back out.
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { previewDocument } from '@/lib/playground/workspace-tools';

// Dynamic, and without SSR: CodeMirror is a large chunk and has no business in
// the first paint of a conversation.
const Editor = dynamic(() => import('@/components/playground/editor'), {
  ssr: false,
  loading: () => <p className="files-note">Loading the editor…</p>,
});

type Entry = { path: string; size: number; updated_at: string };

/** Forwards the preview's console and its uncaught errors to the panel. The
 * preview is sandboxed and same-origin-less, so a postMessage is the only way
 * back, and the listener checks the source frame before believing any of it. */
const BRIDGE =
  "<script>const send=(level,args)=>{try{parent.postMessage({source:'hikmah-preview',level,text:args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')},'*')}catch{}};const oldLog=console.log;console.log=(...a)=>{send('log',a);oldLog(...a)};window.addEventListener('error',e=>send('error',[e.message]));window.addEventListener('unhandledrejection',e=>send('error',[String(e.reason)]));<\/script>";

/** A page can be previewed once there is something to open. */
const isPreviewable = (paths: string[]) => paths.includes('index.html');

function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function FilesPanel({ revision }: { revision: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [tab, setTab] = useState<'code' | 'preview'>('code');
  const [preview, setPreview] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  // Bumped after a write or a delete, so the listing reloads without the effect
  // depending on the values it sets.
  const [changed, setChanged] = useState(0);

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
          `${data.level === 'error' ? 'error' : 'log'}: ${data.text!.slice(0, 1500)}`,
        ].slice(-50),
      );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  // A run finishing reloads the listing and nothing else — not the open file,
  // not what has been typed into it — so an edit in progress survives the agent
  // writing something unrelated.
  useEffect(() => {
    let live = true;
    void fetch('/api/workspace/files', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { files: [] }))
      .then((payload: { files?: Entry[] }) => {
        if (live) setEntries(payload.files ?? []);
      })
      .catch(() => {
        if (live) setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [revision, changed]);

  const load = useCallback(async (path: string) => {
    const response = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return;
    const { file } = (await response.json()) as { file?: { body?: string } };
    setOpen(path);
    setBody(file?.body ?? '');
    setDirty(false);
    setNote('');
    setTab('code');
  }, []);

  const save = useCallback(async () => {
    if (!open) return;
    const response = await fetch('/api/workspace/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: open, content: body }),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    // The server's own words: it knows whether this was a name, a ceiling or a
    // session, and a generic "could not save" would hide all three.
    setNote(response.ok ? 'Saved.' : (payload.error ?? 'That did not save.'));
    if (response.ok) {
      setDirty(false);
      setChanged((value) => value + 1);
    }
  }, [body, open]);

  const remove = useCallback(
    async (path: string) => {
      const response = await fetch(`/api/workspace/files?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) return;
      if (path === open) {
        setOpen(null);
        setBody('');
        setDirty(false);
      }
      setChanged((value) => value + 1);
    },
    [open],
  );

  /** Read the three files a page is made of and render them together.
   *
   * Three requests rather than one: the route reads a file at a time, and a
   * bulk endpoint for something pressed by hand would be machinery for no gain.
   * The file being edited is taken from the editor, not the server, so Run
   * previews what is on screen.
   */
  const run = useCallback(async () => {
    const names = (entries ?? []).map((entry) => entry.path);
    const wanted = ['index.html', 'style.css', 'script.js'].filter((name) => names.includes(name));
    const files: Record<string, string> = {};
    for (const name of wanted) {
      if (name === open) {
        files[name] = body;
        continue;
      }
      const response = await fetch(`/api/workspace/files?path=${encodeURIComponent(name)}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) continue;
      const { file } = (await response.json()) as { file?: { body?: string } };
      files[name] = file?.body ?? '';
    }
    setLogs([]);
    setPreview(previewDocument(files).replace('</head>', BRIDGE + '</head>'));
    setTab('preview');
  }, [body, entries, open]);

  const paths = (entries ?? []).map((entry) => entry.path);

  return (
    // A plain div: the panel around this is the landmark, and nesting a second
    // one inside it would announce two regions where a person sees one.
    <div className="files-panel">
      {entries === null && <p className="files-note">Loading…</p>}
      {entries?.length === 0 && (
        <p className="files-note">Nothing here yet. Ask for something to be written.</p>
      )}

      <ul>
        {entries?.map((entry) => (
          <li key={entry.path} className={entry.path === open ? 'is-open' : ''}>
            <button type="button" onClick={() => void load(entry.path)}>
              <span className="files-path">{entry.path}</span>
              <span className="files-size">{entry.size.toLocaleString()}</span>
            </button>
            <button
              type="button"
              className="files-delete"
              aria-label={`Delete ${entry.path}`}
              onClick={() => void remove(entry.path)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {isPreviewable(paths) && (
        <div className="files-run">
          <button type="button" onClick={() => void run()}>
            Run preview
          </button>
          {tab === 'preview' && (
            <button type="button" onClick={() => setTab('code')}>
              Back to code
            </button>
          )}
        </div>
      )}

      {tab === 'preview' && (
        <div className="files-preview">
          <iframe
            ref={frame}
            title="Workspace preview"
            // allow-scripts and nothing else: the page is the owner's, but it
            // was written by a model, so it gets no same-origin access and no
            // way back into this document except the bridge above.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={preview}
          />
          <div className="files-console" aria-label="Preview console">
            {logs.length === 0 ? (
              <p>Nothing logged.</p>
            ) : (
              logs.map((line, index) => <p key={index}>{line}</p>)
            )}
          </div>
        </div>
      )}

      {tab === 'code' && open && (
        <div className="files-editor">
          <label htmlFor="files-body">{open}</label>
          <div className="files-editor-surface">
            <Editor
              filename={open}
              value={body}
              theme={currentTheme()}
              onChange={(value) => {
                setBody(value);
                setDirty(true);
                setNote('');
              }}
            />
          </div>
          <div className="files-actions">
            <button type="button" onClick={() => void save()} disabled={!dirty}>
              Save
            </button>
            {/* Announced rather than only shown: saving is the one action here
                whose outcome the person cannot see for themselves. */}
            <span aria-live="polite">{note}</span>
          </div>
        </div>
      )}
    </div>
  );
}

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
import { useCallback, useEffect, useState } from 'react';
import { PagePreview } from './page-preview';

// Dynamic, and without SSR: CodeMirror is a large chunk and has no business in
// the first paint of a conversation.
const Editor = dynamic(() => import('@/components/playground/editor'), {
  ssr: false,
  loading: () => <p className="files-note">Loading the editor…</p>,
});

type Entry = { path: string; size: number; updated_at: string };

/** The page a preview opens: the file being edited when it is a page,
 * otherwise the site's front page, otherwise the first page there is. */
function pageToPreview(open: string | null, paths: string[]): string | null {
  if (open && /\.html?$/i.test(open)) return open;
  if (paths.includes('index.html')) return 'index.html';
  return paths.find((path) => /\.html?$/i.test(path)) ?? null;
}

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
  // Where this workspace's pages are served (see lib/files/preview-link.ts),
  // and which page is open full screen.
  const [previewBase, setPreviewBase] = useState('');
  const [showing, setShowing] = useState<string | null>(null);
  // Bumped after a write or a delete, so the listing reloads without the effect
  // depending on the values it sets.
  const [changed, setChanged] = useState(0);

  // A run finishing reloads the listing and nothing else — not the open file,
  // not what has been typed into it — so an edit in progress survives the agent
  // writing something unrelated.
  useEffect(() => {
    let live = true;
    void fetch('/api/workspace/files', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { files: [] }))
      .then((payload: { files?: Entry[]; preview?: string }) => {
        if (!live) return;
        setEntries(payload.files ?? []);
        setPreviewBase(payload.preview ?? '');
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

  const paths = (entries ?? []).map((entry) => entry.path);
  const page = pageToPreview(open, paths);

  /** Open the page full screen, served with every file it links to. An edit
   * in progress is saved first: the server serves rows, not the editor. */
  const run = useCallback(async () => {
    if (!page) return;
    if (dirty) await save();
    setShowing(page);
  }, [dirty, page, save]);

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

      {page && previewBase && (
        <div className="files-run">
          <button type="button" onClick={() => void run()}>
            Open {page}
          </button>
          <a href={previewBase + page} target="_blank" rel="noopener noreferrer">
            New tab
          </a>
        </div>
      )}

      {showing && previewBase && (
        <PagePreview
          href={previewBase + showing}
          title={showing}
          onClose={() => setShowing(null)}
        />
      )}

      {open && (
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

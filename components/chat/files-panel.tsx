'use client';
/** The workspace beside the conversation.
 *
 * The agent writes files with write_file; this is where they can be read and
 * edited. Deliberately a plain textarea rather than the playground's editor:
 * that one is bound to the workspace blob and carries a preview iframe and a
 * console, and porting it wholesale would move a lot of code before anything
 * could be seen working. Reading and editing what the agent wrote is the part
 * that makes the tools useful.
 */
import { useCallback, useEffect, useState } from 'react';

type Entry = { path: string; size: number; updated_at: string };

export function FilesPanel({ revision }: { revision: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  // Bumped after a write or a delete, so the listing reloads without the effect
  // depending on the values it sets.
  const [changed, setChanged] = useState(0);

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

      {open && (
        <div className="files-editor">
          <label htmlFor="files-body">{open}</label>
          <textarea
            id="files-body"
            value={body}
            spellCheck={false}
            onChange={(event) => {
              setBody(event.target.value);
              setDirty(true);
              setNote('');
            }}
          />
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

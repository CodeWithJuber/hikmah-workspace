'use client';
/** Artifacts: the page (or code, or document) an answer produced.
 *
 * The inline card is always live — scripts run, the network stays isolated —
 * because the old Run/Stop toggle made every demo start dead. The iframe
 * remounts whenever its document changes, so the preview follows the code as
 * it arrives instead of freezing on the first paint.
 *
 * The expanded panel adds a client-side version strip: every distinct set of
 * files the panel is shown gets snapshotted, an old version can be viewed,
 * and restoring one writes it back to the workspace with PUT
 * /api/workspace/files.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  previewDocument,
  detectArtifactKind,
  artifactLanguageLabel,
  primaryArtifactFile,
  type ArtifactKind,
} from '@/lib/playground/workspace-tools';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { HikmahIcon } from './icons';
import { copyText } from '@/components/playground/error-card';
import { Maximize2, PencilLine, FileCode2, FileText, Eye, History, RotateCcw } from 'lucide-react';
import { PagePreview } from '@/components/chat/page-preview';
import { Streamdown } from 'streamdown';
import { clientFetch } from '@/lib/client/request';

/** Human title for the artifact card header, based on what the files are. */
function kindTitle(kind: ArtifactKind): string {
  switch (kind) {
    case 'web':
      return 'Web artifact';
    case 'markdown':
      return 'Document';
    case 'code':
      return 'Code artifact';
    case 'empty':
      return 'Artifact';
  }
}

/** Subtitle like "3 files · Python" or "2 files · HTML preview". */
function kindSubtitle(kind: ArtifactKind, files: WorkspaceFiles): string {
  const count = Object.keys(files).length;
  const filesLabel = `${count} file${count === 1 ? '' : 's'}`;
  switch (kind) {
    case 'web':
      return `${filesLabel} · HTML preview`;
    case 'markdown':
      return `${filesLabel} · Markdown`;
    case 'code':
      return `${filesLabel} · ${artifactLanguageLabel(files)}`;
    case 'empty':
      return 'No files yet';
  }
}

/** Tiny content hash: the iframe's key. It only needs to change when the
 * document does. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'd' + (h >>> 0).toString(36);
}

/** Compact file list + primary file snippet for non-web artifacts inline. */
function InlineCodePreview({ files }: { files: WorkspaceFiles }) {
  const names = Object.keys(files);
  const primary = primaryArtifactFile(files);
  const snippet = primary ? (files[primary] ?? '').split('\n').slice(0, 14).join('\n') : '';
  const truncated = primary ? (files[primary] ?? '').split('\n').length > 14 : false;
  return (
    <div className="inline-artifact-code">
      <ul className="inline-artifact-files" aria-label="Files in this artifact">
        {names.map((name) => (
          <li key={name} className={name === primary ? 'is-primary' : undefined}>
            <FileCode2 size={16} aria-hidden="true" />
            <span>{name}</span>
          </li>
        ))}
      </ul>
      {primary && (
        <div className="inline-artifact-snippet">
          <div className="inline-artifact-snippet-head">
            <span>{primary}</span>
            <Button variant="ghost" onClick={() => void copyText(files[primary] ?? '')}>
              Copy
            </Button>
          </div>
          <pre>{snippet}</pre>
          {truncated && <span className="inline-artifact-more">Expand to see the full file</span>}
        </div>
      )}
    </div>
  );
}

export function InlineArtifact({
  files,
  caption,
  onOpen,
}: {
  files: WorkspaceFiles;
  /** One line saying what this is, under the header — the agent's own
   * description of what it built. */
  caption?: string;
  onOpen: (files: WorkspaceFiles) => void;
}) {
  const kind = useMemo(() => detectArtifactKind(files), [files]);
  const doc = useMemo(() => (kind === 'web' ? previewDocument(files) : ''), [files, kind]);
  const primary = useMemo(() => primaryArtifactFile(files), [files]);
  return (
    <div className="inline-artifact">
      <header>
        <HikmahIcon name="artifact" />
        <div>
          <strong>{kindTitle(kind)}</strong>
          <span>{kindSubtitle(kind, files)}</span>
        </div>
        <Button variant="ghost" onClick={() => onOpen(files)}>
          <HikmahIcon name="preview" />
          Expand
        </Button>
      </header>
      {caption && <p className="inline-artifact-caption">{caption}</p>}
      {kind === 'web' && (
        <>
          <iframe
            // Keyed on the document, not on a toggle: as the code arrives the
            // preview re-renders with it. An iframe does not reload when its
            // srcDoc attribute is updated, so without the key it would freeze
            // on the first paint.
            key={hashString(doc)}
            title="Inline generated page preview"
            // Always live: scripts run, the network stays isolated. The old
            // Run/Stop toggle made every demo start dead — "Static preview"
            // with a button to make it work is not a preview.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={doc}
          />
          <footer>
            <span>Interactive preview · network isolated</span>
          </footer>
        </>
      )}
      {kind === 'code' && <InlineCodePreview files={files} />}
      {kind === 'markdown' && primary && (
        <div className="inline-artifact-markdown">
          <Streamdown>{files[primary] ?? ''}</Streamdown>
        </div>
      )}
      {kind === 'empty' && (
        <div className="inline-artifact-empty">
          <FileText size={20} aria-hidden="true" />
          <p>Nothing to preview yet — files will appear here as they are created.</p>
        </div>
      )}
    </div>
  );
}

type Snapshot = { at: number; files: WorkspaceFiles };

export function ArtifactPanel({
  files,
  previewBase,
  onClose,
  onEdit,
}: {
  files: WorkspaceFiles;
  /** Where the workspace's pages are served (lib/files/preview-link.ts). With
   * it the preview is the page as written, links and all, and can open full
   * screen; without it the three-file inline document is shown as before. */
  previewBase?: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [full, setFull] = useState(false);
  // The version strip: every distinct set of files the panel is shown gets
  // snapshotted, oldest first. Client-side only — it lives as long as the
  // panel does. A new snapshot returns the view to the latest.
  const [history, setHistory] = useState<Snapshot[]>([]);
  /** Which snapshot is on screen, or null for the live files. */
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreNote, setRestoreNote] = useState('');
  const sigRef = useRef('');
  useEffect(() => {
    const sig = JSON.stringify(files);
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    setHistory((current) => [...current, { at: Date.now(), files }].slice(-10));
    setViewIndex(null);
  }, [files]);
  const shown = viewIndex === null ? files : (history[viewIndex]?.files ?? files);
  const live = viewIndex === null;

  const kind = useMemo(() => detectArtifactKind(shown), [shown]);
  const doc = useMemo(() => (kind === 'web' ? previewDocument(shown) : ''), [shown, kind]);
  // Code artifacts have no visual preview, so they get no Preview tab at all
  // and land on Source; web and markdown artifacts land on Preview.
  const defaultTab = kind === 'code' || kind === 'empty' ? 'code' : 'preview';
  const [tab, setTab] = useState(defaultTab);
  // A new artifact (different kind) resets the tab choice.
  const [lastKind, setLastKind] = useState(kind);
  if (kind !== lastKind) {
    setLastKind(kind);
    setTab(defaultTab);
  }
  const primary = useMemo(() => primaryArtifactFile(shown), [shown]);
  const page = Object.keys(shown).find((name) => /\.html?$/i.test(name)) ?? 'index.html';
  // The served page always shows what is in the workspace *now*, so an old
  // version is previewed from its snapshot document instead — otherwise the
  // strip would lie about what v1 looked like.
  const href = live && kind === 'web' && previewBase ? previewBase + page : undefined;
  const fileCount = Object.keys(shown).length;

  /** Write an old version back to the workspace, one PUT per file, then treat
   * it as the latest: the workspace is now at that content. */
  const restore = async (index: number) => {
    const snap = history[index];
    if (!snap || restoring) return;
    setRestoring(true);
    setRestoreNote('');
    try {
      const entries = Object.entries(snap.files);
      for (const [path, content] of entries) {
        const response = await clientFetch('/api/workspace/files', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(payload?.error ?? `Could not write ${path}.`);
        }
      }
      setHistory((current) => [...current, { at: Date.now(), files: snap.files }].slice(-10));
      setViewIndex(null);
      setRestoreNote(
        `Restored v${index + 1} — ${entries.length} file${entries.length === 1 ? '' : 's'} written to the workspace.`,
      );
    } catch (error) {
      setRestoreNote(error instanceof Error ? error.message : 'Restore failed.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <aside className="artifact-panel">
      {full && href && <PagePreview href={href} title={page} onClose={() => setFull(false)} />}
      <header>
        <HikmahIcon name="artifact" />
        <div className="artifact-panel-heading">
          <strong>{kindTitle(kind)}</strong>
          <span>{kindSubtitle(kind, shown)}</span>
        </div>
        <Button
          variant="ghost"
          className="icon-button artifact-panel-close"
          aria-label="Close artifact preview"
          onClick={onClose}
        >
          <HikmahIcon name="close" />
        </Button>
      </header>
      {/* The version strip: only when there is more than one version to move
          between. The single-version case stays exactly as quiet as before. */}
      {history.length > 1 && (
        <div className="artifact-versions" role="group" aria-label="Version history">
          <History size={16} aria-hidden="true" />
          {history.map((entry, index) => {
            const active = (viewIndex ?? history.length - 1) === index;
            const latest = index === history.length - 1;
            return (
              <button
                key={entry.at + '-' + index}
                type="button"
                className={'artifact-version' + (active ? ' is-active' : '')}
                aria-pressed={active}
                title={new Date(entry.at).toLocaleString()}
                onClick={() => {
                  setViewIndex(latest ? null : index);
                  setRestoreNote('');
                }}
              >
                {latest ? 'Latest' : `v${index + 1}`}
              </button>
            );
          })}
          {!live && viewIndex !== null && (
            <Button
              variant="outline"
              size="sm"
              disabled={restoring}
              onClick={() => void restore(viewIndex)}
            >
              <RotateCcw size={16} aria-hidden="true" />
              {restoring ? 'Restoring…' : `Restore v${viewIndex + 1}`}
            </Button>
          )}
        </div>
      )}
      {restoreNote && (
        <p className="artifact-restore-note" role="status">
          {restoreNote}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab} className="artifact-panel-tabs">
        <div className="artifact-panel-toolbar">
          <TabsList aria-label="Artifact view">
            {/* Code has no visual preview, so no Preview tab — the old one
                showed an empty "No visual preview" card behind a tab that
                promised a preview. */}
            {kind !== 'code' && (
              <TabsTrigger value="preview">
                <Eye size={16} aria-hidden="true" />
                Preview
              </TabsTrigger>
            )}
            <TabsTrigger value="code">
              <FileCode2 size={16} aria-hidden="true" />
              Source
            </TabsTrigger>
          </TabsList>
          {/* One row of equal buttons, each an icon with its word. On a phone
              the row wraps under the tabs whole, rather than the buttons
              stacking at whatever width their words happened to need. */}
          <div className="artifact-panel-actions">
            {href && (
              <Button
                variant="outline"
                aria-label="Open full page"
                title="Open full page"
                onClick={() => setFull(true)}
              >
                <Maximize2 size={16} aria-hidden="true" />
                <span>Full page</span>
              </Button>
            )}
            <Button
              variant="outline"
              aria-label="Edit in workspace"
              title="Edit in workspace"
              onClick={onEdit}
            >
              <PencilLine size={16} aria-hidden="true" />
              <span>Edit</span>
            </Button>
          </div>
        </div>
        <TabsContent value="preview" className="artifact-panel-preview">
          {kind === 'web' &&
            (href ? (
              <iframe
                key={hashString(doc)}
                title="Expanded generated page preview"
                // The served page, so css/ and js/ links resolve. Always
                // live; the network stays isolated by the sandbox.
                sandbox="allow-scripts allow-forms allow-modals"
                referrerPolicy="no-referrer"
                src={href}
              />
            ) : (
              <iframe
                key={hashString(doc)}
                title="Expanded generated page preview"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                srcDoc={doc}
              />
            ))}
          {kind === 'markdown' && primary && (
            <div className="artifact-panel-markdown">
              <Streamdown>{shown[primary] ?? ''}</Streamdown>
            </div>
          )}
          {kind === 'empty' && (
            <div className="artifact-preview-empty">
              <FileText size={24} aria-hidden="true" />
              <p>
                <strong>Nothing here yet</strong>
                <span>Files will appear here as the assistant creates them.</span>
              </p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="code" className="artifact-panel-source">
          {fileCount === 0 ? (
            <div className="artifact-preview-empty">
              <FileText size={24} aria-hidden="true" />
              <p>
                <strong>No files yet</strong>
                <span>Source files will be listed here as they are created.</span>
              </p>
            </div>
          ) : (
            Object.entries(shown).map(([name, code]) => (
              <section key={name}>
                <header>
                  <strong>{name}</strong>
                  <Button variant="ghost" onClick={() => void copyText(code)}>
                    Copy
                  </Button>
                </header>
                <pre>{code}</pre>
              </section>
            ))
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

'use client';
import { useMemo, useState } from 'react';
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
import { Maximize2, PencilLine, Play, Square, FileCode2, FileText, Eye } from 'lucide-react';
import { PagePreview } from '@/components/chat/page-preview';
import { Streamdown } from 'streamdown';

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
  onOpen,
}: {
  files: WorkspaceFiles;
  onOpen: (files: WorkspaceFiles) => void;
}) {
  const [run, setRun] = useState(false);
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
      {kind === 'web' && (
        <>
          <iframe
            key={run ? 'run' : 'static'}
            title="Inline generated page preview"
            sandbox={run ? 'allow-scripts' : ''}
            referrerPolicy="no-referrer"
            srcDoc={doc}
          />
          <footer>
            <span>{run ? 'Interactive preview · network isolated' : 'Static preview'}</span>
            <Button variant="ghost" onClick={() => setRun(!run)}>
              {run ? 'Stop interactions' : 'Run interactions'}
            </Button>
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
  const [run, setRun] = useState(false);
  const [full, setFull] = useState(false);
  const kind = useMemo(() => detectArtifactKind(files), [files]);
  const doc = useMemo(() => (kind === 'web' ? previewDocument(files) : ''), [files, kind]);
  // Code artifacts have no visual preview, so land on the Source tab; web and
  // markdown artifacts land on Preview.
  const defaultTab = kind === 'code' || kind === 'empty' ? 'code' : 'preview';
  const [tab, setTab] = useState(defaultTab);
  // A new artifact (different kind) resets the tab choice.
  const [lastKind, setLastKind] = useState(kind);
  if (kind !== lastKind) {
    setLastKind(kind);
    setTab(defaultTab);
  }
  const primary = useMemo(() => primaryArtifactFile(files), [files]);
  const page = Object.keys(files).find((name) => /\.html?$/i.test(name)) ?? 'index.html';
  const href = kind === 'web' && previewBase ? previewBase + page : undefined;
  const fileCount = Object.keys(files).length;
  return (
    <aside className="artifact-panel">
      {full && href && <PagePreview href={href} title={page} onClose={() => setFull(false)} />}
      <header>
        <HikmahIcon name="artifact" />
        <div className="artifact-panel-heading">
          <strong>{kindTitle(kind)}</strong>
          <span>{kindSubtitle(kind, files)}</span>
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
      <Tabs value={tab} onValueChange={setTab} className="artifact-panel-tabs">
        <div className="artifact-panel-toolbar">
          <TabsList aria-label="Artifact view">
            <TabsTrigger value="preview">
              <Eye size={16} aria-hidden="true" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="code">
              <FileCode2 size={16} aria-hidden="true" />
              Source
            </TabsTrigger>
          </TabsList>
          {/* One row of equal buttons, each an icon with its word. On a phone
              the row wraps under the tabs whole, rather than the buttons
              stacking at whatever width their words happened to need. */}
          <div className="artifact-panel-actions">
            {kind === 'web' && (
              <Button
                variant="outline"
                aria-pressed={run}
                aria-label={run ? 'Stop interactions' : 'Run interactions'}
                title={run ? 'Stop interactions' : 'Run the page’s scripts'}
                onClick={() => setRun(!run)}
              >
                {run ? (
                  <Square size={16} aria-hidden="true" />
                ) : (
                  <Play size={16} aria-hidden="true" />
                )}
                <span>{run ? 'Stop' : 'Run'}</span>
              </Button>
            )}
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
                key={run ? 'run' : 'static'}
                title="Expanded generated page preview"
                // The served page, so css/ and js/ links resolve. Static until
                // interactions are switched on, like the inline version.
                sandbox={run ? 'allow-scripts allow-forms allow-modals' : ''}
                referrerPolicy="no-referrer"
                src={href}
              />
            ) : (
              <iframe
                key={run ? 'run' : 'static'}
                title="Expanded generated page preview"
                sandbox={run ? 'allow-scripts' : ''}
                referrerPolicy="no-referrer"
                srcDoc={doc}
              />
            ))}
          {kind === 'markdown' && primary && (
            <div className="artifact-panel-markdown">
              <Streamdown>{files[primary] ?? ''}</Streamdown>
            </div>
          )}
          {kind === 'code' && (
            <div className="artifact-preview-empty">
              <FileCode2 size={24} aria-hidden="true" />
              <p>
                <strong>No visual preview</strong>
                <span>
                  Code files don’t render as a page — {fileCount} file
                  {fileCount === 1 ? '' : 's'} in {artifactLanguageLabel(files)}. See the Source tab
                  for the full code.
                </span>
              </p>
              <Button variant="outline" onClick={() => setTab('code')}>
                View source
              </Button>
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
            Object.entries(files).map(([name, code]) => (
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

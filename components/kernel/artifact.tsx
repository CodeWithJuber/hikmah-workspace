'use client';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { previewDocument } from '@/lib/playground/workspace-tools';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { HikmahIcon } from './icons';
import { copyText } from '@/components/playground/error-card';
import { Maximize2, PencilLine, Play, Square } from 'lucide-react';
import { PagePreview } from '@/components/chat/page-preview';
export function InlineArtifact({
  files,
  onOpen,
}: {
  files: WorkspaceFiles;
  onOpen: (files: WorkspaceFiles) => void;
}) {
  const [run, setRun] = useState(false);
  const doc = useMemo(() => previewDocument(files), [files]);
  return (
    <div className="inline-artifact">
      <header>
        <HikmahIcon name="artifact" />
        <div>
          <strong>Web artifact</strong>
          <span>{Object.keys(files).length} files · HTML preview</span>
        </div>
        <Button variant="ghost" onClick={() => onOpen(files)}>
          <HikmahIcon name="preview" />
          Expand
        </Button>
      </header>
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
  const doc = useMemo(() => previewDocument(files), [files]);
  const page = Object.keys(files).find((name) => /\.html?$/i.test(name)) ?? 'index.html';
  const href = previewBase ? previewBase + page : undefined;
  return (
    <aside className="artifact-panel">
      {full && href && <PagePreview href={href} title={page} onClose={() => setFull(false)} />}
      <header>
        <HikmahIcon name="artifact" />
        <strong>Web artifact</strong>
        <Button
          variant="ghost"
          className="icon-button"
          aria-label="Close artifact preview"
          onClick={onClose}
        >
          <HikmahIcon name="close" />
        </Button>
      </header>
      <Tabs defaultValue="preview" className="artifact-panel-tabs">
        <div className="artifact-panel-toolbar">
          <TabsList>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="code">Source</TabsTrigger>
          </TabsList>
          {/* One row of equal buttons, each an icon with its word. On a phone
              the row wraps under the tabs whole, rather than the buttons
              stacking at whatever width their words happened to need. */}
          <div className="artifact-panel-actions">
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
          {href ? (
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
          )}
        </TabsContent>
        <TabsContent value="code" className="artifact-panel-source">
          {Object.entries(files).map(([name, code]) => (
            <section key={name}>
              <header>
                <strong>{name}</strong>
                <Button variant="ghost" onClick={() => void copyText(code)}>
                  Copy
                </Button>
              </header>
              <pre>{code}</pre>
            </section>
          ))}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

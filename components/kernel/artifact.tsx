'use client';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { previewDocument } from '@/lib/playground/workspace-tools';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { HikmahIcon } from './icons';
import { copyText } from '@/components/playground/error-card';
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
  onClose,
  onEdit,
}: {
  files: WorkspaceFiles;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [run, setRun] = useState(false);
  const doc = useMemo(() => previewDocument(files), [files]);
  return (
    <aside className="artifact-panel">
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
          <Button variant="outline" onClick={onEdit}>
            Edit in workspace
          </Button>
        </div>
        <TabsContent value="preview" className="artifact-panel-preview">
          <iframe
            key={run ? 'run' : 'static'}
            title="Expanded generated page preview"
            sandbox={run ? 'allow-scripts' : ''}
            referrerPolicy="no-referrer"
            srcDoc={doc}
          />
          <Button variant="outline" onClick={() => setRun(!run)}>
            {run ? 'Stop interactions' : 'Run interactions'}
          </Button>
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

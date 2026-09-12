'use client';
import {
  memo,
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { Streamdown, type Components } from 'streamdown';
import { FileCode2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/* The same renderer both surfaces use, so an answer reads identically on each.
   It brings Shiki highlighting, KaTeX and mermaid, and it repairs the
   half-written markdown a stream produces mid-token. Its code blocks scroll at
   400px, which is what replaced the "View source · N lines" disclosure: a long
   block is now readable in place instead of one more thing to click open. */
const plugins = { cjk, code, math, mermaid };

function plain(node: ReactNode): string {
  return Children.toArray(node)
    .map((n) =>
      typeof n === 'string' || typeof n === 'number'
        ? String(n)
        : isValidElement<{ children?: ReactNode }>(n)
          ? plain(n.props.children)
          : '',
    )
    .join('');
}

/* Model output is untrusted, so remote images are named rather than fetched. */
const blockedImage: Components['img'] = ({ alt }) => (
  <span className="muted">[Image: {alt || 'not loaded'}]</span>
);
const readOnly: Components = { img: blockedImage };

export const MessageContent = memo(function MessageContent({
  text,
  onSave,
}: {
  text: string;
  onSave?: (language: string, code: string) => void;
}) {
  /* Streamdown's own <pre> just tags the code element, so wrapping it keeps its
     copy and download controls while adding the one control the workspace
     needs, rather than re-implementing a highlighted code block. */
  /* Cast because Streamdown's `Components` intersects a per-element map with a
     `Record<string, unknown>` index signature, and no override can satisfy
     both; `img` above only type-checks because it is written as an element
     type rather than inside the literal. */
  const withSave = {
    img: blockedImage,
    pre: ({ children }: { children?: ReactNode }) => {
      if (!isValidElement<{ children?: ReactNode; className?: string }>(children))
        return <>{children}</>;
      const language = children.props.className?.replace(/^language-/, '') || 'text';
      const source = plain(children.props.children).replace(/\n$/, '');
      return (
        <div className="code-host">
          {cloneElement(children as ReactElement<Record<string, unknown>>, {
            'data-block': 'true',
          })}
          <Button
            variant="ghost"
            className="code-host-save"
            onClick={() => onSave?.(language, source)}
          >
            <FileCode2 size={14} />
            Save to workspace
          </Button>
        </div>
      );
    },
  } as Components;
  return (
    <Streamdown
      className="markdown-content"
      dir="auto"
      skipHtml
      plugins={plugins}
      components={onSave ? withSave : readOnly}
    >
      {text}
    </Streamdown>
  );
});

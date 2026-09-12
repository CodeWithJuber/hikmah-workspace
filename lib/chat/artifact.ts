/** The web page an answer produced, if it produced one.
 *
 * Two sources, because the agent has two ways of writing a page. It may fence
 * the code in its reply, which is what `artifactFiles` already reads; or it may
 * call `write_file`, which is what it actually does once the tool is available
 * — and the old detector would have found nothing in that case, so the preview
 * would simply never appear for the path the agent prefers.
 *
 * The tool's *input* carries the content: its output reports only the path and
 * a length, since the file itself is a row by then.
 */

import { artifactFiles } from '../kernel/artifacts.ts';
import type { WorkspaceFiles } from '../playground/session.ts';

/** Only these three make a previewable page, and only these three are read
 * from the tool calls — a written `notes.md` is not an artifact. */
const PREVIEWABLE = new Set(['index.html', 'style.css', 'script.js']);

/** Guard against a huge file being inlined into the preview document. Matches
 * the cap `artifactFiles` applies to fenced code. */
const MAX_CHARACTERS = 80_000;

type MessageLike = {
  parts: readonly unknown[];
};

function textOf(message: MessageLike): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => {
      const value = part as { type?: unknown; text?: unknown };
      return value.type === 'text' && typeof value.text === 'string';
    })
    .map((part) => part.text)
    .join('\n\n');
}

/** Files this message wrote through the workspace tool, as far as a preview
 * cares. A call that failed carries no output, and is skipped. */
function writtenFiles(message: MessageLike): WorkspaceFiles {
  const files: WorkspaceFiles = {};
  for (const part of message.parts) {
    const value = part as {
      type?: unknown;
      state?: unknown;
      input?: { path?: unknown; content?: unknown };
      output?: { path?: unknown };
    };
    if (value.type !== 'tool-write_file' || value.state !== 'output-available') continue;
    const path = value.input?.path;
    const content = value.input?.content;
    if (
      typeof path === 'string' &&
      typeof content === 'string' &&
      PREVIEWABLE.has(path) &&
      content.length <= MAX_CHARACTERS
    )
      files[path] = content;
  }
  return files;
}

/**
 * The previewable bundle for one answer, or null when there is not one.
 *
 * Written files win over fenced ones: if the agent both wrote `index.html` and
 * showed it in the reply, the written copy is the one that exists.
 */
export function messageArtifact(message: MessageLike): WorkspaceFiles | null {
  const written = writtenFiles(message);
  const fenced = artifactFiles(textOf(message)) ?? {};
  const files = { ...fenced, ...written };
  return files['index.html'] ? files : null;
}

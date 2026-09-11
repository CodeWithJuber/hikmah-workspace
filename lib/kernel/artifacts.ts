import type { WorkspaceFiles } from '../playground/session';
export function artifactFiles(text: string): WorkspaceFiles | null {
  const files: WorkspaceFiles = {};
  const pattern = /^```(html|css|javascript|js)\s*\n([\s\S]*?)^```\s*$/gm;
  for (const match of text.matchAll(pattern)) {
    const key = match[1] === 'html' ? 'index.html' : match[1] === 'css' ? 'style.css' : 'script.js';
    if (!Object.hasOwn(files, key) && match[2].length <= 80000) files[key] = match[2];
  }
  return files['index.html'] ? files : null;
}

/** Notes search connector.
 *
 * Manifest claims: searches the workspace notes for a query and returns
 * matching lines with file and line number. Read-only: it never writes.
 * Permission requested: `notes:read`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ConnectorDefinition, ConnectorResult } from '@/lib/catalog/connector.ts';

export interface NoteMatch {
  file: string;
  line: number;
  snippet: string;
}

async function collectMarkdown(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectMarkdown(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
}

async function searchNotes(
  notesDir: string,
  query: string,
  limit = 10,
): Promise<{ matches: NoteMatch[]; filesSearched: number }> {
  const files: string[] = [];
  await collectMarkdown(notesDir, files);
  const needle = query.toLowerCase();
  const matches: NoteMatch[] = [];
  for (const file of files) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (info.size > 1_000_000) continue;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matches.push({
          file: relative(notesDir, file),
          line: i + 1,
          snippet: lines[i].trim().slice(0, 200),
        });
        if (matches.length >= limit) return { matches, filesSearched: files.length };
      }
    }
  }
  return { matches, filesSearched: files.length };
}

export const definition: ConnectorDefinition = {
  name: 'notes-search',
  requiredPermissions: ['notes:read'],
  async run(input: unknown, ctx): Promise<ConnectorResult> {
    const body = (input ?? {}) as { query?: unknown; limit?: unknown };
    if (typeof body.query !== 'string' || body.query.trim().length === 0)
      return { ok: false, code: 'bad-input', error: 'Pass { "query": "admission" }.' };
    if (body.query.length > 200)
      return { ok: false, code: 'query-too-long', error: 'Queries are limited to 200 characters.' };
    const limit =
      typeof body.limit === 'number' && Number.isInteger(body.limit)
        ? Math.min(Math.max(body.limit, 1), 50)
        : 10;
    try {
      const { matches, filesSearched } = await searchNotes(ctx.notesDir, body.query.trim(), limit);
      return { ok: true, data: { query: body.query.trim(), filesSearched, matches } };
    } catch (error) {
      return {
        ok: false,
        code: 'search-failed',
        error: error instanceof Error ? error.message : 'Search failed.',
      };
    }
  },
};

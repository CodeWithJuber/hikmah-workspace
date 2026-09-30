/** Local file reader connector.
 *
 * Manifest claims: reads a text file inside an explicitly allowed directory
 * and returns its content. The path is resolved against the allowed
 * directory and must stay inside it — `..` escapes, absolute paths outside
 * the directory, and symlink escapes are all refused. Permission requested:
 * `files:read`.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { ConnectorDefinition, ConnectorResult } from '@/lib/catalog/connector.ts';

const MAX_BYTES = 1_000_000;

/** Resolve `requested` against `allowedDir` and refuse anything that escapes
 * it — including through symlinks, which are resolved before the check. */
async function resolveInside(allowedDir: string, requested: string): Promise<string> {
  const base = await realpath(allowedDir).catch(() => resolve(allowedDir));
  const joined = resolve(base, requested);
  const real = await realpath(joined).catch(() => joined);
  const rel = relative(base, real);
  if (rel === '' || rel === '.')
    throw new Error('A file path is required, not the directory itself.');
  if (rel.startsWith('..') || rel.split(sep).includes('..'))
    throw new Error('The path escapes the allowed directory.');
  return real;
}

export const definition: ConnectorDefinition = {
  name: 'local-file-reader',
  requiredPermissions: ['files:read'],
  async run(input: unknown, ctx): Promise<ConnectorResult> {
    const body = (input ?? {}) as { path?: unknown };
    if (typeof body.path !== 'string' || body.path.trim().length === 0)
      return { ok: false, code: 'bad-input', error: 'Pass { "path": "notes/todo.md" }.' };
    if (body.path.length > 500)
      return { ok: false, code: 'path-too-long', error: 'Paths are limited to 500 characters.' };
    let resolved: string;
    try {
      resolved = await resolveInside(ctx.allowedDir, body.path.trim());
    } catch (error) {
      return {
        ok: false,
        code: 'path-rejected',
        error: error instanceof Error ? error.message : 'The path was rejected.',
      };
    }
    let info;
    try {
      info = await stat(resolved);
    } catch {
      return { ok: false, code: 'not-found', error: 'No such file inside the allowed directory.' };
    }
    if (!info.isFile()) return { ok: false, code: 'not-a-file', error: 'The path is not a file.' };
    if (info.size > MAX_BYTES)
      return { ok: false, code: 'file-too-large', error: 'Files over 1 MB are not read.' };
    const content = await readFile(resolved, 'utf8').catch(() => null);
    if (content === null)
      return { ok: false, code: 'unreadable', error: 'The file could not be read as text.' };
    return {
      ok: true,
      data: { path: relative(ctx.allowedDir, resolved), size: info.size, content },
    };
  },
};

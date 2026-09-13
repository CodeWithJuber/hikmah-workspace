/** A workspace's files, served as a site: `/preview/<token>/<path>`.
 *
 * No session here. The token in the path is the credential (see
 * lib/files/preview-link.ts), which is what lets a sandboxed frame — an opaque
 * origin that sends no cookies — fetch the page's own stylesheet and script.
 *
 * Every response carries a `sandbox` Content-Security-Policy without
 * `allow-same-origin`: the page is the owner's, but it was written by a model,
 * and on this host it must not be able to read the owner's cookies or call
 * the owner's APIs. It can run scripts, submit forms and open windows; it
 * cannot be anyone.
 */
import { FileError, createFileStore } from '@/lib/files/store';
import { contentTypeFor, verifyPreviewToken, withConsoleBridge } from '@/lib/files/preview-link';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self'";

const headersFor = (type: string) => ({
  'Content-Type': type,
  'Content-Security-Policy': SANDBOX,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store, private',
  'X-Robots-Tag': 'noindex',
});

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A small page rather than JSON: this URL is opened by people, in a tab. */
function notice(text: string, status: number) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hikmah preview</title><style>body{font-family:system-ui,sans-serif;padding:32px 20px;color:#17212b}p{max-width:36em;line-height:1.5}</style></head><body><p>${escape(text)}</p></body></html>`,
    { status, headers: headersFor('text/html; charset=utf-8') },
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; path?: string[] }> },
) {
  const { token, path } = await context.params;
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
  const claim = secret ? verifyPreviewToken(token, secret) : null;
  if (!claim) return notice('This preview link has expired or is not valid.', 404);

  const segments = path ?? [];
  const name = segments.length ? segments.join('/') : 'index.html';
  const files = createFileStore(getStorage().raw);
  let file;
  try {
    file = files.read(claim.userId, name);
    // A folder: its index page, the way any static host answers.
    if (!file && !name.includes('.')) file = files.read(claim.userId, name + '/index.html');
  } catch (error) {
    if (error instanceof FileError) return notice('There is no such file in this workspace.', 404);
    throw error;
  }
  if (!file) return notice('There is no such file in this workspace.', 404);

  const type = contentTypeFor(file.path);
  const body = type.startsWith('text/html') ? withConsoleBridge(file.body) : file.body;
  return new Response(body, { headers: headersFor(type) });
}

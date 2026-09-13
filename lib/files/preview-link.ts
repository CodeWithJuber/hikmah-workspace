/** A workspace's pages, served as pages.
 *
 * The preview used to inline three named files into one `srcdoc`, so a page
 * that linked `css/style.css` rendered bare, and nothing could open it
 * full-screen or hand out a link to it. Now a page is served at
 * `/preview/<token>/<path>`, where the token is a signed, expiring reference
 * to one workspace. Two things follow from the token being in the path rather
 * than a cookie:
 *
 * - The page's own relative links resolve: `css/style.css` is one more request
 *   under the same token.
 * - The page can run in a sandbox with an opaque origin and no credentials —
 *   which is the only safe way to run a model-written page on the app's own
 *   host — and still fetch its stylesheet, because nothing about the request
 *   depends on being the signed-in person.
 *
 * The signature is an HMAC over the workspace id and the expiry, keyed from
 * the deployment's session secret, so a token cannot be edited to point at
 * another workspace or to live longer. Pure: no storage, no request.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** A link lasts a week: long enough to send to someone, short enough that a
 * leaked one stops working on its own. */
export const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PreviewClaim = { userId: string; expiresAt: number };

const key = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'hikmah-preview-link-v1', 'hmac-sha256', 32));

const sign = (payload: string, secret: string) =>
  createHmac('sha256', key(secret)).update(payload).digest('base64url');

export function signPreviewToken(claim: PreviewClaim, secret: string): string {
  const payload = Buffer.from(`${claim.userId}:${Math.trunc(claim.expiresAt)}`).toString(
    'base64url',
  );
  return `${payload}.${sign(payload, secret)}`;
}

/** The claim a token carries, or null for anything expired, altered or made up. */
export function verifyPreviewToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): PreviewClaim | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  const expected = sign(payload, secret);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const decoded = Buffer.from(payload, 'base64url').toString();
  const split = decoded.lastIndexOf(':');
  if (split <= 0) return null;
  const userId = decoded.slice(0, split);
  const expiresAt = Number(decoded.slice(split + 1));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { userId, expiresAt };
}

/** Where a file is served under a token; the root of the token is index.html. */
export function previewPath(token: string, path = ''): string {
  return `/preview/${token}/${path}`;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  xml: 'application/xml; charset=utf-8',
};

/** What a file is served as. The store holds text, so this is the text types;
 * anything unnamed is plain text, which a browser will not run. */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return TYPES[extension] ?? 'text/plain; charset=utf-8';
}

/** Forwards the page's console and its uncaught errors to the window that
 * framed it. The frame is sandboxed with no origin, so a postMessage is the
 * only way out, and the listener checks the source frame before believing it. */
export const CONSOLE_BRIDGE =
  "<script>(()=>{const send=(level,args)=>{try{parent.postMessage({source:'hikmah-preview',level,text:args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')},'*')}catch{}};for(const level of ['log','info','warn','error']){const old=console[level];console[level]=(...a)=>{send(level==='log'||level==='info'?'log':level,a);old(...a)}}window.addEventListener('error',e=>send('error',[e.message]));window.addEventListener('unhandledrejection',e=>send('error',[String(e.reason)]))})()<\/script>";

/** The page with the bridge ahead of its own scripts: before `</head>` when
 * there is one, otherwise first. */
export function withConsoleBridge(html: string): string {
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + CONSOLE_BRIDGE + html.slice(head);
  return CONSOLE_BRIDGE + html;
}

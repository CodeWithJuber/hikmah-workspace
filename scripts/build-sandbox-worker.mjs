/** Bundle the JavaScript sandbox worker as a standalone ES module.
 *
 * Next's webpack emits this worker as a *classic* script and loads its chunks
 * with importScripts, whatever `{ type: 'module' }` says. That breaks QuickJS
 * outright: the single-file variant carries the WASM binary as a string full of
 * octal escapes, which are illegal in the context importScripts parses it in, so
 * every single run failed with
 *
 *   Failed to execute 'importScripts' on 'WorkerGlobalScope':
 *   Octal escape sequences are not allowed in template strings.
 *
 * Building it here instead produces one real ES module with nothing to import at
 * runtime, so there is no chunk loader involved and no string to re-parse. It is
 * served from /sandbox-worker.js and fetched only when someone runs code.
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';

const out = resolve('public/sandbox-worker.js');

await build({
  entryPoints: [resolve('lib/playground/sandbox.worker.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // Matches the browsers this app already targets; QuickJS's own output needs
  // nothing newer.
  target: ['chrome120', 'firefox120', 'safari17'],
  minify: true,
  // A worker has no DOM, and nothing here reads NODE_ENV, but leaving it
  // undefined would let a bundled dependency take a development branch.
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});

console.info('Built', out);

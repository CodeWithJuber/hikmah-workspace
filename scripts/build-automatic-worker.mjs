import { build } from 'esbuild';
await build({
  entryPoints: ['lib/learning/automatic-fit-worker.ts'],
  outfile: 'public/research/v6/automatic-fit-worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
});

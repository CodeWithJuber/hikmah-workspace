import {build} from 'esbuild';
await build({entryPoints:['lib/context-model/train-worker.ts'],bundle:true,format:'esm',platform:'browser',outfile:'public/research/v6/train-worker.js',minify:true});

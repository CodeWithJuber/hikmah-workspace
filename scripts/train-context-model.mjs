import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const input=process.argv[2],output=process.argv[3];if(!input||!output)throw Error('Pass the processed corpus directory and output directory.');
await mkdir(output,{recursive:true});await build({entryPoints:['lib/context-model/field-model.ts'],outfile:'/tmp/hikmah-field-training.mjs',bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const {fitField,evaluateField}=await import(pathToFileURL('/tmp/hikmah-field-training.mjs'));
const manifest={format:'hikmah.context-experiment.v1',createdAt:new Date().toISOString(),protocol:'Internal document-group partition of PUD, folds 2–9 train, 1 development, 0 test. This is one research split, not completed ten-fold cross-validation or official shared-task performance.',input:'Gold basic-token segmentation; predicted POS; base relations; gold punctuation excluded',selection:'Highest development LAS; tie-break POS. Test evaluated once after selection.',languages:[]};
for(const language of ['en','ar','hi','es','tr']){
 const dataset=JSON.parse(await readFile(join(input,'ud-pud-'+language+'.json'),'utf8'));
 const sentences=dataset.sentences,dev=sentences.filter(s=>s.split==='development'),test=sentences.filter(s=>s.split==='test');
 const start=Date.now();const model=fitField(sentences,language);const variants=[{name:'local factors',transition:0,lexicalArc:0,rootCandidates:3},{name:'sequence context',transition:.45,lexicalArc:0,rootCandidates:3},{name:'sequence and lexical relations',transition:.45,lexicalArc:.6,rootCandidates:3},{name:'stronger sequence context',transition:1,lexicalArc:.6,rootCandidates:3}];let best=null;
 const trials=[];for(const v of variants){const candidate={...model,config:{transition:v.transition,lexicalArc:v.lexicalArc,rootCandidates:v.rootCandidates}};const measured=evaluateField(candidate,dev);trials.push({name:v.name,config:candidate.config,posAccuracy:measured.posAccuracy,uas:measured.uas,las:measured.las});if(!best||measured.las>best.metrics.las||(measured.las===best.metrics.las&&measured.posAccuracy>best.metrics.posAccuracy))best={model:candidate,metrics:measured};}
 const measured=evaluateField(best.model,test);const name=language+'.model.json';await writeFile(join(output,name),JSON.stringify(best.model));
 const {perSentence,...metrics}=measured;const {perSentence:devRows,...development}=best.metrics;
 const result={language,modelFile:name,training:best.model.training,source:dataset.provenance,development,trials,test:metrics,elapsedMs:Date.now()-start,fieldBytes:Buffer.byteLength(JSON.stringify(best.model))};manifest.languages.push(result);
 await writeFile(join(output,language+'.evaluation.json'),JSON.stringify({protocol:manifest.protocol,...result,testSentences:perSentence},null,2));
 console.log(JSON.stringify({language,train:model.training.sentences,tokens:model.training.tokens,developmentLAS:development.las,testLAS:metrics.las,testPOS:metrics.posAccuracy,elapsedMs:result.elapsedMs,bytes:result.fieldBytes}));
}
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));

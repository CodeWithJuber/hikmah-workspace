import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'hikmah-chat-workflow-'));
await build({entryPoints:['lib/playground/run-preparation.ts','lib/server/web-search.ts','lib/server/quran-research.ts','lib/server/runtime-relay.ts','lib/context-model/client.ts'],outdir:dir,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},logLevel:'silent'});
const load = name => import(pathToFileURL(join(dir,name+'.mjs')));
const {withinDeadline,prepareConnectors} = await load('playground/run-preparation');
const {searchWeb} = await load('server/web-search');
const {researchQuran} = await load('server/quran-research');
const {runtimeRelay} = await load('server/runtime-relay');
const {loadField,invalidateField} = await load('context-model/client');
const signal = () => new AbortController().signal;
const env=(t,key,value)=>{const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});};

test('optional preparation times out and Stop cancels a hung task', async()=>{
 await assert.rejects(withinDeadline(new Promise(()=>{}),signal(),10),/timed out/);
 const controller=new AbortController();const pending=withinDeadline(new Promise(()=>{}),controller.signal,10000);controller.abort();
 await assert.rejects(pending,{name:'AbortError'});
});
test('connect enabled services on demand; failure does not remove other tools',async()=>{
 const calls=[];const result=await prepareConnectors([{id:'existing',enabled:true},{id:'new',enabled:true},{id:'bad',enabled:true},{id:'off',enabled:false}],{}, {existing:[{name:'read'}]},signal(),async c=>{calls.push(c.id);if(c.id==='bad')throw Error('offline');return [{name:'run_code'}];});
 assert.deepEqual(calls.sort(),['bad','new']);assert.equal(result.catalogs.existing[0].name,'read');assert.equal(result.catalogs.new[0].name,'run_code');assert.equal(result.failures[0].id,'bad');
});
test('non-owner context analysis loads public released parameters without accessing owner data',async t=>{
 invalidateField('en');const released=JSON.parse(await readFile('public/research/v6/models/en.model.json','utf8'));const calls=[];
 t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return String(url).startsWith('/api/')?new Response('',{status:403}):Response.json(released);});
 const model=await loadField('en');assert.equal(model.language,'en');assert.equal(calls[1],'/research/v6/models/en.model.json');invalidateField('en');
});
test('web search returns real source URLs, bounded snippets and no browser credentials',async t=>{
 env(t,'HIKMAH_SEARCH_URL','http://search:8080/search');let sent;
 t.mock.method(globalThis,'fetch',async(url,init)=>{sent={url,init};return Response.json({results:[{title:'Source',url:'https://example.org/paper',content:'<b>Evidence</b>'},{title:'Private',url:'https://127.0.0.1',content:'discard'}]});});
 const result=await searchWeb('test source',signal());assert.equal(sent.url.searchParams.get('format'),'json');assert.equal(sent.init.headers.Authorization,undefined);assert.equal(result.results.length,1);assert.equal(result.results[0].snippet,'Evidence');assert.equal(result.untrusted,true);
});
test('search failure is visible and is never represented as verified evidence',async t=>{
 env(t,'HIKMAH_SEARCH_URL','http://search:8080/search');t.mock.method(globalThis,'fetch',async()=>new Response('',{status:429}));
 await assert.rejects(searchWeb('test',signal()),/No search evidence/);
});
test('Quran index retains corpus coverage and distinguishes notes from actual scripture',async()=>{
 const result=await researchQuran({verse:'49:6'});assert.equal(result.totalIndexed,6236);assert.equal(result.results.length,1);assert.equal(result.results[0].ayah_key,'49:6');assert.match(result.recordType,/not scripture/);assert.equal(result.scholarlyVerification,'not_independently_verified');assert.match(result.results[0].verse_url,/quran.com\/49\/6/);
 const invalid=await researchQuran({verse:'115:1'});assert.equal(invalid.results.length,0);await assert.rejects(researchQuran({verse:'../secrets'}));
});
const runtimeRequest=(body,origin='https://app.example')=>new Request('https://app.example/api/runtime',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('runtime requires owner and same origin before contacting the configured host',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Unexpected');});
 assert.equal((await runtimeRelay(runtimeRequest({}),false)).status,403);
 assert.equal((await runtimeRelay(runtimeRequest({},'https://attacker.example'),true)).status,403);assert.equal(calls,0);
});
test('runtime forwards only to operator endpoint, retains private token server-side, bounds tools',async t=>{
 env(t,'HIKMAH_RUNTIME_URL','http://runtime:8765/mcp');env(t,'HIKMAH_RUNTIME_TOKEN','fixture-runtime-secret');let sent;
 t.mock.method(globalThis,'fetch',async(url,init)=>{sent={url,init};return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'fixture-runtime-secret'}]}});});
 const body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_code',arguments:{language:'python',code:'print(42)'}}};
 const response=await runtimeRelay(runtimeRequest(body),true);assert.equal(response.status,200);assert.equal(sent.url.href,'http://runtime:8765/mcp');assert.equal(sent.init.headers.Authorization,'Bearer fixture-runtime-secret');assert.equal(sent.init.redirect,'error');assert.doesNotMatch(await response.text(),/fixture-runtime-secret/);
 body.params.name='arbitrary_shell';assert.equal((await runtimeRelay(runtimeRequest(body),true)).status,400);
});
test.after(()=>rm(dir,{recursive:true,force:true}));

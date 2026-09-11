import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {openStorage} from '../server/storage.mjs';
import {createSecretStore} from '../server/workspace-secrets.mjs';
const directory=await mkdtemp(join(tmpdir(),'hikmah-vault-tests-'));
const output=join(directory,'build');
await build({entryPoints:['lib/server/secrets-api.ts','lib/server/provider-relay.ts','lib/server/media-relay.ts','lib/server/mcp-relay.ts','lib/server/runtime-relay.ts','lib/server/public-https.ts','lib/server/web-search.ts','lib/playground/transport.ts','lib/playground/session.ts','lib/playground/mcp-client.ts','lib/playground/media-client.ts'],outdir:output,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},logLevel:'silent'});
const load=name=>import(pathToFileURL(join(output,name+'.mjs')));
const {secretsRequest}=await load('server/secrets-api');
const {relayProviderRequest}=await load('server/provider-relay');
const {relayMediaRequest}=await load('server/media-relay');
const {relayMcpRequest}=await load('server/mcp-relay');
const {runtimeRelay}=await load('server/runtime-relay');
const {publicIPv4}=await load('server/public-https');
const {searchWeb}=await load('server/web-search');
const {complete}=await load('playground/transport');
const {parseSession}=await load('playground/session');
const {callMcp}=await load('playground/mcp-client');
const {mediaFetch}=await load('playground/media-client');
const value='fixture-key-private-2eb1570d';
const config={baseUrl:'https://openrouter.ai/api/v1',apiKey:'',apiKeySecret:'MODEL_KEY',model:'test/model',maxTokens:256,temperature:.3,stream:false};
const setEnv=(t,name,value)=>{const previous=process.env[name];if(value===undefined)delete process.env[name];else process.env[name]=value;t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});};
async function fixture(t){setEnv(t,'HIKMAH_VAULT_KEY','fixture-master-key-'.padEnd(64,'1'));const dir=await mkdtemp(join(directory,'db-'));const storage=openStorage(dir);t.after(()=>storage.close());return {dir,storage,store:createSecretStore(storage.DB)};}
function req(path,method='GET',body,headers={}){return new Request('https://app.example'+path,{method,headers:{origin:'https://app.example','Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});}

test('vault encrypts randomly, survives reopening, and lists metadata only',async t=>{
 const {store,storage,dir}=await fixture(t);
 await store.save('alice',{name:'MODEL_KEY',value,destination:'provider:openrouter'});
 const first=storage.raw.prepare('SELECT sealed FROM workspace_secrets').get().sealed;
 await store.save('alice',{name:'MODEL_KEY',value,destination:'provider:openrouter'});
 const second=storage.raw.prepare('SELECT sealed FROM workspace_secrets').get().sealed;
 assert.notEqual(first,second);assert.ok(!second.includes(value));
 const other=openStorage(dir);try{assert.equal(await createSecretStore(other.DB).resolve('alice','MODEL_KEY','provider:openrouter'),value);}finally{other.close();}
 const list=await store.list('alice');assert.deepEqual(Object.keys(list[0]).sort(),['destination','name','updatedAt']);assert.ok(!JSON.stringify(list).includes(value));
 storage.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert.equal((await readFile(join(dir,'workspace.sqlite'))).includes(Buffer.from(value)),false);
});
test('vault isolates users, binds destination and detects altered ciphertext',async t=>{
 const {store,storage}=await fixture(t);await store.save('alice',{name:'MODEL_KEY',value,destination:'provider:openrouter'});
 assert.deepEqual(await store.list('bob'),[]);await assert.rejects(store.resolve('bob','MODEL_KEY','provider:openrouter'),/missing/);
 await assert.rejects(store.resolve('alice','MODEL_KEY','provider:experiential'),/different service/);
 storage.raw.prepare('UPDATE workspace_secrets SET destination=?').run('provider:experiential');
 await assert.rejects(store.resolve('alice','MODEL_KEY','provider:experiential'),/cannot be decrypted/);
});
test('wrong master key fails closed and replacement repairs the value',async t=>{
 const {store}=await fixture(t);await store.save('alice',{name:'MODEL_KEY',value,destination:'provider:openrouter'});
 process.env.HIKMAH_VAULT_KEY='different-master-key'.padEnd(64,'2');await assert.rejects(store.resolve('alice','MODEL_KEY','provider:openrouter'),/cannot be decrypted/);
 await store.save('alice',{name:'MODEL_KEY',value:'replacement',destination:'provider:openrouter'});assert.equal(await store.resolve('alice','MODEL_KEY','provider:openrouter'),'replacement');
 await store.remove('alice','MODEL_KEY');await assert.rejects(store.resolve('alice','MODEL_KEY','provider:openrouter'),/missing/);
});
test('secret API authenticates, checks origin, excludes values and scopes deletion',async t=>{
 const {store}=await fixture(t);const body={name:'MODEL_KEY',value,destination:'provider:openrouter'};
 assert.equal((await secretsRequest(req('/api/secrets','PUT',body),undefined,store)).status,401);
 assert.equal((await secretsRequest(req('/api/secrets','PUT',body,{origin:'https://other.example'}),'alice',store)).status,403);
 const saved=await secretsRequest(req('/api/secrets','PUT',body),'alice',store);assert.equal(saved.status,200);assert.match(saved.headers.get('cache-control'),/no-store/);assert.ok(!(await saved.text()).includes(value));
 await secretsRequest(req('/api/secrets?name=MODEL_KEY','DELETE'),'bob',store);assert.equal(await store.resolve('alice','MODEL_KEY','provider:openrouter'),value);
 const listed=await secretsRequest(req('/api/secrets'),'alice',store);assert.equal((await listed.json()).secrets[0].name,'MODEL_KEY');
 await secretsRequest(req('/api/secrets?name=MODEL_KEY','DELETE'),'alice',store);assert.deepEqual(await store.list('alice'),[]);
});
test('vault rejects oversized credentials, line breaks, bad names and reserved runtime options',async t=>{
 const {store}=await fixture(t);
 for(const body of [{name:'MODEL_KEY',value:'x'.repeat(8193),destination:'provider:openrouter'},{name:'../KEY',value,destination:'provider:openrouter'},{name:'KEY',value:'a\nb',destination:'provider:openrouter'},{name:'NODE_OPTIONS',value:'--require=x',destination:'runtime:env'},{name:'MCP_KEY',value,destination:'mcp:http://localhost/mcp'}])await assert.rejects(store.save('alice',body));
 await store.save('alice',{name:'MULTILINE_TOKEN',value:'line one\nline two',destination:'runtime:env'});assert.equal(await store.resolve('alice','MULTILINE_TOKEN','runtime:env'),'line one\nline two');
});
test('saved provider key resolves only after auth/origin and goes to its fixed provider',async t=>{
 const {store}=await fixture(t);await store.save('alice',{name:'MODEL_KEY',value,destination:'provider:openrouter'});
 let resolved=0,sent;const resolver=async(name,destination)=>{resolved++;return store.resolve('alice',name,destination);};
 const request=()=>req('/api/provider?provider=openrouter&operation=models','GET',undefined,{'X-Hikmah-Secret-Ref':'MODEL_KEY'});
 assert.equal((await relayProviderRequest(request(),false,resolver)).status,401);assert.equal(resolved,0);
 assert.equal((await relayProviderRequest(req('/api/provider?provider=openrouter&operation=models','GET',undefined,{origin:'https://wrong.example'}),true,resolver)).status,403);assert.equal(resolved,0);
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent={url,options};return Response.json({data:[{id:'test/model'}]});});
 const response=await relayProviderRequest(request(),true,resolver);assert.equal(response.status,200);assert.equal(sent.url,'https://openrouter.ai/api/v1/models');assert.equal(sent.options.headers.Authorization,'Bearer '+value);assert.ok(!(await response.text()).includes(value));
 await store.remove('alice','MODEL_KEY');assert.equal((await relayProviderRequest(request(),true,resolver)).status,400);
});
test('transport sends a reference with no browser credential and session exports retain only names',async t=>{
 let sent;t.mock.method(globalThis,'fetch',async(url,options)=>{sent={url,options};return Response.json({choices:[{message:{content:'Ready'},finish_reason:'stop'}],model:'test/model'});});
 assert.equal((await complete(config,[{role:'user',content:'Hello'}])).content,'Ready');assert.equal(sent.options.headers['X-Hikmah-Secret-Ref'],'MODEL_KEY');assert.equal(sent.options.headers.Authorization,undefined);assert.equal(sent.options.headers['X-Hikmah-Provider-Key'],undefined);
 const session=parseSession(JSON.stringify({version:1,additions:[],experimental:false,conversations:[],files:{},connection:{...config,apiKey:value},workspace:{connectors:[{id:'mcp',name:'Tools',url:'https://tools.example/mcp',secretRef:'TOOLS_KEY'}],media:{secretRef:'MODEL_KEY'}}}));
 assert.equal(session.connection.apiKeySecret,'MODEL_KEY');assert.equal(session.workspace.connectors[0].secretRef,'TOOLS_KEY');assert.equal(session.workspace.media.secretRef,'MODEL_KEY');assert.ok(!JSON.stringify(session).includes(value));
});
test('media can reuse the same saved OpenRouter variable and sends only its name from the browser',async t=>{
 let sent;t.mock.method(globalThis,'fetch',async(url,options)=>{sent={url,options};return Response.json({data:[]});});
 await mediaFetch('','models',{kind:'image',secretRef:'MODEL_KEY'});assert.equal(sent.options.headers['X-Hikmah-Secret-Ref'],'MODEL_KEY');assert.equal(sent.options.headers['X-Hikmah-Provider-Key'],undefined);
 const response=await relayMediaRequest(req('/api/media?operation=models&kind=image','GET',undefined,{'X-Hikmah-Secret-Ref':'MODEL_KEY'}),true,async(name,destination)=>{assert.equal(name,'MODEL_KEY');assert.equal(destination,'provider:openrouter');return value;});
 assert.equal(response.status,200);assert.equal(sent.options.headers.Authorization,'Bearer '+value);
});
test('saved MCP reference uses authenticated relay without browser bearer token',async t=>{
 let sent;t.mock.method(globalThis,'fetch',async(url,options)=>{sent={url,options};return Response.json({jsonrpc:'2.0',id:JSON.parse(options.body).id,result:{content:[{type:'text',text:'Done'}]}});});
 await callMcp({id:'tools',url:'https://tools.example/mcp',protocol:'2026-07-28',secretRef:'TOOLS_KEY'},'',{name:'read',inputSchema:{}},{q:'test'});
 assert.equal(sent.url,'/api/mcp');assert.equal(sent.options.credentials,'same-origin');assert.equal(sent.options.headers.Authorization,undefined);assert.equal(sent.options.headers['X-Hikmah-Secret-Ref'],'TOOLS_KEY');
});
test('MCP relay binds the exact service, redacts JSON and SSE, and rejects redirects',async t=>{
 const {store}=await fixture(t);await store.save('alice',{name:'TOOLS_KEY',value,destination:'mcp:https://tools.example/mcp'});
 const resolver=(name,destination)=>store.resolve('alice',name,destination);
 const request=(url='https://tools.example/mcp')=>req('/api/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read',arguments:{}}},{'X-Hikmah-Secret-Ref':'TOOLS_KEY','X-Hikmah-Mcp-Url':url,'MCP-Protocol-Version':'2025-11-25'});
 let calls=0;const send=async(url,headers)=>{calls++;assert.equal(url.href,'https://tools.example/mcp');assert.equal(headers.Authorization,'Bearer '+value);return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:value}]}});};
 assert.equal((await relayMcpRequest(request(),false,resolver,send)).status,401);
 assert.equal((await relayMcpRequest(request('https://other.example/mcp'),true,resolver,send)).status,502);assert.equal(calls,0);
 const reply=await relayMcpRequest(request(),true,resolver,send);assert.equal(reply.status,200);assert.ok(!(await reply.text()).includes(value));
 const sse=await relayMcpRequest(request(),true,resolver,async()=>new Response('data: '+JSON.stringify({jsonrpc:'2.0',id:1,result:{text:value}})+'\n\n',{headers:{'content-type':'text/event-stream'}}));assert.ok(!(await sse.text()).includes(value));
 assert.equal((await relayMcpRequest(request(),true,resolver,async()=>new Response('',{status:302,headers:{location:'http://localhost'}}))).status,502);
});
test('MCP network boundary rejects private, metadata, mapped and reserved addresses',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.20.0.1','100.100.100.200','0.0.0.0','224.1.1.1','198.18.1.2','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
});
test('runtime injects server-selected environment only into code calls and redacts outputs',async t=>{
 setEnv(t,'HIKMAH_RUNTIME_URL','http://runtime:8765/mcp');setEnv(t,'HIKMAH_RUNTIME_TOKEN',undefined);
 let sent,environmentCalls=0;const secrets={token:async()=>value,environment:async()=>{environmentCalls++;return {REPORT_TOKEN:'line one\nline two'};}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({stdout:'line one\nline two'})}]}});});
 const body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_code',arguments:{code:'print(42)',language:'python',_env:{UNAPPROVED:'bad'}}}};
 const reply=await runtimeRelay(req('/api/runtime','POST',body),true,secrets);assert.equal(reply.status,200);assert.deepEqual(sent.params.arguments._env,{REPORT_TOKEN:'line one\nline two'});assert.equal(environmentCalls,1);assert.ok(!(await reply.text()).includes('line one'));
 body.params.name='ssh_action';await runtimeRelay(req('/api/runtime','POST',body),true,secrets);assert.equal(environmentCalls,1);assert.equal(sent.params.arguments._env,undefined);
});
test('runtime catalog exposes only granted variable names without decrypting values',async t=>{
 setEnv(t,'HIKMAH_RUNTIME_URL','http://runtime:8765/mcp');
 t.mock.method(globalThis,'fetch',async()=>Response.json({jsonrpc:'2.0',id:1,result:{tools:[{name:'run_code',description:'Run source.'}]}}));
 const response=await runtimeRelay(req('/api/runtime','POST',{jsonrpc:'2.0',id:1,method:'tools/list'}),true,{token:async()=>value,environment:async()=>{throw Error('Catalog must not decrypt runtime variables');},environmentNames:async()=>['REPORT_TOKEN']});
 const body=await response.text();assert.equal(response.status,200);assert.match(body,/REPORT_TOKEN/);assert.ok(!body.includes(value));
});
test('Brave search resolves a saved variable only when its fixed service is used',async t=>{
 setEnv(t,'HIKMAH_SEARCH_URL',undefined);setEnv(t,'BRAVE_SEARCH_API_KEY',undefined);let sent,resolved=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{sent={url,options};return Response.json({web:{results:[{title:'Source',url:'https://example.org',description:value}]},results:[]});});
 const resolve=async()=>{resolved++;return value;};const result=await searchWeb('query',new AbortController().signal,resolve);assert.equal(sent.options.headers['X-Subscription-Token'],value);assert.ok(!JSON.stringify(result).includes(value));assert.equal(resolved,1);
 process.env.HIKMAH_SEARCH_URL='http://search:8080/search';await searchWeb('query',new AbortController().signal,resolve);assert.equal(resolved,1);assert.equal(sent.options.headers['X-Subscription-Token'],undefined);
});
test.after(()=>rm(directory,{recursive:true,force:true}));

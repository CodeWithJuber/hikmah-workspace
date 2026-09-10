import test from 'node:test';
import assert from 'node:assert/strict';
import {complete,createCompletionBody,ProviderTransportError} from '../lib/playground/transport.ts';
import {CompletionFramer,FramingError} from '../lib/playground/completion-framing.ts';
import {parseCheckpoint} from '../lib/playground/checkpoint.ts';
import {setImmediate as immediate} from 'node:timers/promises';
const config={baseUrl:'https://api.experientiallabs.ai/v1',apiKey:'test-only-key',model:'test/model',maxTokens:1024,temperature:0.3};
const messages=[{role:'user',content:'Hi'}];
const evt=x=>'data: '+JSON.stringify(x)+'\n\n';
const delta=(content,finish_reason=null)=>({choices:[{index:0,delta:{content},finish_reason}]});

test('active stream lasting longer than five minutes completes because received chunks reset idle timeout',async t=>{
 t.mock.timers.enable({apis:['setTimeout'],now:0});let source;
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){source=c;}}),{headers:{'Content-Type':'text/event-stream'}}));
 const pending=complete(config,messages);let settled=false;pending.finally(()=>settled=true).catch(()=>{});
 await immediate();t.mock.timers.tick(200000);source.enqueue(new TextEncoder().encode(evt(delta('part1'))));await immediate();
 t.mock.timers.tick(200000);await immediate();assert.equal(settled,false);
 source.enqueue(new TextEncoder().encode(evt(delta('part2','stop'))+'data: [DONE]\n\n'));source.close();
 assert.equal((await pending).content,'part1part2');
});

test('idle stream still stops after five minutes with preserved text',async t=>{
 t.mock.timers.enable({apis:['setTimeout'],now:0});let source,cancelled=false;
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){source=c;},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}}));
 let visible='';const pending=complete(config,messages,{onText:s=>visible+=s});pending.catch(()=>{});
 await immediate();source.enqueue(new TextEncoder().encode(evt(delta('partial'))));await immediate();
 t.mock.timers.tick(300001);await assert.rejects(pending,e=>e instanceof ProviderTransportError&&e.code==='timeout');assert.equal(visible,'partial');assert.equal(cancelled,true);
});

test('signed tool-call IDs round-trip through completion, request history, and checkpoint',async t=>{
 const id='call_'+('signed/opaque+data='.repeat(3000));assert.ok(id.length>256&&id.length<=65536);
 const tool={id,type:'function',function:{name:'calculate',arguments:'{"expression":"1+1"}'}};
 t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[tool]},finish_reason:'tool_calls'}]}));
 const result=await complete(config,messages);assert.equal(result.toolCalls[0].id,id);
 const history=[...messages,{role:'assistant',content:null,tool_calls:[tool]},{role:'tool',tool_call_id:id,content:'2'}];
 const body=JSON.parse(createCompletionBody(config,history));assert.equal(body.messages[1].tool_calls[0].id,id);assert.equal(body.messages[2].tool_call_id,id);
 const cp=parseCheckpoint({version:1,messages:history,goal:messages[0],output:'',requests:1,toolCount:1,compactions:0,pendingCalls:result.toolCalls,pendingIndex:1,recentSignatures:[],phase:'ready'});assert.equal(cp.messages[1].tool_calls[0].id,id);assert.equal(cp.pendingCalls[0].id,id);
});

test('malformed choices entries are protocol errors rather than CORS/network diagnosis',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[null]}));
 await assert.rejects(complete(config,messages),e=>e instanceof ProviderTransportError&&e.code==='protocol');
});

test('empty SSE data fields still consume the bounded record budget',()=>{const parser=new CompletionFramer(()=>{},32);assert.throws(()=>parser.feed('data:\n'.repeat(1000)),FramingError);});

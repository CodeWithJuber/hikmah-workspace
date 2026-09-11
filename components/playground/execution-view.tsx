"use client";
import {useEffect,useState,useRef} from 'react';
import {Activity,Check,GitCompareArrows,LoaderCircle,BrainCircuit,AlertCircle,Pause} from 'lucide-react';
import type {ExecutionView as Execution,ComparisonView,RunStage} from '@/lib/playground/execution';
import {MessageContent} from './message-content';
export function ProviderExplanation({text,running=false}:{text?:string;running?:boolean}){const [open,setOpen]=useState(false);const scroll=useRef<HTMLDivElement|null>(null);const follow=useRef(true);useEffect(()=>{if(open&&follow.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[text,open]);if(!text)return null;return <details className="provider-explanation" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><BrainCircuit size={15}/>{running?'Model is working':'Model explanation'}{running&&<LoaderCircle size={13} className="spin"/>}</summary>{open&&<div className="explanation-scroll" ref={scroll} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<60;}}><MessageContent text={text}/></div>}<small>Readable explanation supplied by the provider.</small></details>;}
function Metrics({stage}:{stage:RunStage}){return <div className="stage-metrics"><span>{stage.status}</span>{stage.elapsedMs!==undefined&&<span>{(stage.elapsedMs/1000).toFixed(1)}s</span>}{stage.usage?.total_tokens!==undefined&&<span>{stage.usage.total_tokens.toLocaleString()} tokens</span>}{stage.usage?.cost!==undefined&&<span>${stage.usage.cost.toFixed(4)}</span>}</div>;}
export function ExecutionProgress({value}:{value?:Execution}) {
 const [expanded,setExpanded]=useState(false);
 if(!value?.stages.length)return null;
 const current=value.stages.findLast(s=>s.status==='running');
 const failed=value.stages.some(s=>s.status==='error');
 return <details className="execution-progress execution-details" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
  <summary><Activity size={15}/>{current?current.name:failed?'Activity · some checks unavailable':'Activity & model explanation'}<span>{value.stages.length} request{value.stages.length>1?'s':''}</span>{current&&<LoaderCircle size={14} className="spin"/>}</summary>
  {expanded&&<><p className="execution-provider">{value.provider}</p>
  {value.contextSummary&&<details className="context-receipt"><summary>Context model contribution</summary><p className="whitespace-pre-wrap">{value.contextSummary}</p><small>Experimental context analysis; the original conversation is preserved.</small></details>}
  {value.contribution?.context==='unavailable'&&<p className="small-note">Context analysis was unavailable. The original conversation was used.</p>}
  {value.stages.map(stage=><section key={stage.id} className={'execution-stage '+stage.status}>
   <header>{stage.status==='running'?<LoaderCircle size={15} className="spin"/>:stage.status==='error'?<AlertCircle size={15}/>:stage.status==='stopped'?<Pause size={15}/>:<Check size={15}/>}<strong>{stage.name}</strong><span>{stage.model??stage.requestedModel}</span></header>
   <Metrics stage={stage}/><ProviderExplanation text={stage.explanation} running={stage.status==='running'}/>
   {!stage.explanation&&stage.status!=='running'&&<small>No readable model explanation was returned.</small>}
   {stage.text&&stage.status!=='running'&&<details className="stage-output"><summary>{stage.name==='Repair'?'Revision':'Review result'}</summary><MessageContent text={stage.text}/></details>}
  </section>)}</>}
 </details>;
}
export function DirectComparison({value}:{value:ComparisonView}){return <section className="direct-comparison"><header><GitCompareArrows size={18}/><div><strong>B · Direct answer</strong><p>{value.model||value.requestedModel||'Waiting for model'}</p></div><span className={'lane-status '+value.status}>{value.status==='running'?<LoaderCircle size={14} className="spin"/>:null}{value.status??'complete'}</span></header>{value.text&&(value.status??'complete')==='complete'?<MessageContent text={value.text}/>:<p className="comparison-wait">{value.status==='running'?'Waiting for the answer…':'No completed answer is available.'}</p>}{value.error&&<p role="alert" className="kernel-alert">{value.error}</p>}<details className="direct-metrics"><summary>Request details & model explanation</summary><ProviderExplanation text={value.explanation} running={value.status==='running'}/><p className="comparison-method">{value.provider} · one generation · saved knowledge included · no tools or review</p><Metrics stage={{id:'baseline',name:'Direct answer',requestedModel:value.requestedModel??value.model,model:value.model,status:value.status??'complete',usage:value.usage??(value.tokens!==undefined?{total_tokens:value.tokens}:undefined),elapsedMs:value.latencyMs,firstTextMs:value.firstTextMs}}/></details></section>;}

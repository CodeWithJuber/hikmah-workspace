import {randomId} from '../id.ts';
import {z} from 'zod';
import {train,compareCandidates,evaluate,validateRows,type TrainingRow,type Row,type CandidateReceipt} from '../engines/meaning-engine';
import {baseRows,dataset} from '../playground/session';
export type Strategy='direct'|'verify';
export type Family='conversation'|'coding'|'research'|'analysis';
export type KernelRun={id:string;model:string;family:Family;strategy:Strategy;status:'complete'|'error'|'stopped'|'paused';tokens:number;latencyMs:number;tools:number;at:string;rating?:'up'|'down';evaluation:boolean;};
export type Version={id:string;parent:string|null;at:string;rows:TrainingRow[];hash:string;lexicon:number;rules:number;reason:string};
export type LearningEvent={id:string;at:string;kind:string;detail:string};
export type KernelState={version:1;activeId:string;examples:TrainingRow[];development:Row[];versions:Version[];events:LearningEvent[];runs:KernelRun[];trainingAttempts:number;feedbackRevision:number;config:{enabled:boolean;autoTrain:boolean;strategy:'adaptive'|Strategy;collectFeedback:boolean};lastGate:CandidateReceipt|null;};
export const configSchema=z.object({enabled:z.boolean(),autoTrain:z.boolean(),strategy:z.enum(['adaptive','direct','verify']),collectFeedback:z.boolean()}).strict();
const runSchema=z.object({id:z.string().uuid(),model:z.string().max(200),family:z.enum(['conversation','coding','research','analysis']),strategy:z.enum(['direct','verify']),status:z.enum(['complete','error','stopped','paused']),tokens:z.number().int().min(0).max(100000000),latencyMs:z.number().min(0).max(86400000),tools:z.number().int().min(0).max(1000000),evaluation:z.boolean()}).strict();
export const actionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('configure'),config:configSchema}).strict(),
 z.object({type:z.literal('teach'),rows:z.array(z.unknown()).min(1).max(200),development:z.array(z.unknown()).max(150).optional()}).strict(),
 z.object({type:z.literal('train')}).strict(),
 z.object({type:z.literal('rollback'),versionId:z.string().max(100)}).strict(),
 z.object({type:z.literal('run'),run:runSchema}).strict(),
 z.object({type:z.literal('feedback'),runId:z.string().uuid(),rating:z.enum(['up','down']).nullable()}).strict()
]);
export type KernelAction=z.infer<typeof actionSchema>;
export function activeVersion(s:KernelState){const v=s.versions.find(v=>v.id===s.activeId);if(!v)throw Error('Active checkpoint is unavailable.');return v;}
export function activeModel(s:KernelState){return train([...baseRows,...activeVersion(s).rows]);}
function event(s:KernelState,kind:string,detail:string,now:string){s.events=[{id:randomId(),at:now,kind,detail},...s.events].slice(0,100);}
export function initialKernel():KernelState{const m=train(baseRows);return {version:1,activeId:'seed-v1',examples:[],development:[],versions:[{id:'seed-v1',parent:null,at:'2026-09-10T00:00:00Z',rows:[],hash:m.training_hash,lexicon:m.lexicon.length,rules:m.rules.length,reason:'Bundled supervised seed, not an online training event'}],events:[],runs:[],trainingAttempts:0,feedbackRevision:0,config:{enabled:true,autoTrain:true,strategy:'adaptive',collectFeedback:true},lastGate:null};}
function fitCandidate(s:KernelState,now:string){const current=activeModel(s);const candidate=train([...baseRows,...s.examples],{parentModelId:current.model_id});const result=compareCandidates(current,candidate,[...dataset.development as Row[],...s.development]);s.trainingAttempts++;s.lastGate=result.receipt;
 if(result.receipt.approved){const id=randomId();s.versions=[{id,parent:s.activeId,at:now,rows:structuredClone(s.examples),hash:candidate.training_hash,lexicon:candidate.lexicon.length,rules:candidate.rules.length,reason:`${result.receipt.new_correct_frames} new correct development frames; no observed regression`},...s.versions.filter(v=>v.id!=='seed-v1').slice(0,10),s.versions.find(v=>v.id==='seed-v1')!];s.activeId=id;event(s,'promoted',`${candidate.lexicon.length} learned mappings · ${candidate.rules.length} rules · ${result.receipt.new_correct_frames} new correct frames`,now);}
 else event(s,'candidate held',result.receipt.reason.replaceAll('_',' ')+`; ${result.receipt.regressions.length} regressions; ${result.receipt.wrong_emitted_frames.length} wrong emissions. Active model preserved.`,now);
}
export function reduceKernel(previous:KernelState,input:unknown,now=new Date().toISOString()):KernelState{const a=actionSchema.parse(input);const s=structuredClone(previous);
 if(a.type==='configure'){s.config=a.config;event(s,'configuration','Owner updated kernel and learning controls.',now);}
 if(a.type==='teach'){
 const rows=validateRows(a.rows,'train') as TrainingRow[];const baseIds=new Set(baseRows.map(r=>r.id));if(rows.some(r=>baseIds.has(r.id)))throw Error('Seed examples cannot be overwritten.');
 const merged=new Map(s.examples.map(r=>[r.id,r]));rows.forEach(r=>merged.set(r.id,r));s.examples=[...merged.values()];if(s.examples.length>200)throw Error('This checkpoint supports 200 additional labels. Export and curate the dataset before extending it.');
 if(a.development?.length){const extra=validateRows(a.development,'development');const dev=new Map(s.development.map(r=>[r.id,r]));extra.forEach(r=>dev.set(r.id,r));s.development=[...dev.values()];if(s.development.length>150)throw Error('Development set supports 150 additional examples.');}
 // Validate leakage even when automatic fitting is disabled.
 compareCandidates(activeModel(s),train([...baseRows,...s.examples]),[...dataset.development as Row[],...s.development]);
 event(s,'labels accepted',`${rows.length} owner-reviewed labels accepted. Corrections replace matching IDs; fitting replays the full dataset.`,now);if(s.config.autoTrain)fitCandidate(s,now);
 }
 if(a.type==='train')fitCandidate(s,now);
 if(a.type==='rollback'){const target=s.versions.find(v=>v.id===a.versionId);if(!target)throw Error('Checkpoint not found.');s.activeId=target.id;s.examples=structuredClone(target.rows);s.lastGate=null;event(s,'rollback',`Restored checkpoint ${target.id}. Training history remains available.`,now);}
 if(a.type==='run'){const old=s.runs.find(r=>r.id===a.run.id);if(old?.status==='complete')return previous;s.runs=[{...a.run,at:now},...s.runs.filter(r=>r.id!==a.run.id)].slice(0,500);}
 if(a.type==='feedback'){if(!s.config.collectFeedback)throw Error('Learning from feedback is paused.');const run=s.runs.find(r=>r.id===a.runId);if(!run)throw Error('Run is not saved yet. Retry after cloud sync.');if(run.evaluation)throw Error('Comparison runs are excluded from policy training.');if(run.status!=='complete')throw Error('Only completed runs are eligible for quality feedback.');const next=a.rating??undefined;if(run.rating===next)return previous;run.rating=next;s.feedbackRevision++;event(s,'policy learned',`Replayed current feedback after ${a.rating??'removed'} rating. This updates workflow preference, not factual truth.`,now);}
 return s;
}
export function policy(s:KernelState,family:Family){return (['direct','verify'] as Strategy[]).map(strategy=>{const rs=s.runs.filter(r=>r.family===family&&r.strategy===strategy&&r.status==='complete'&&!r.evaluation&&r.rating);const positive=rs.filter(r=>r.rating==='up').length;return {strategy,examples:rs.length,alpha:1+positive,beta:1+rs.length-positive,mean:(1+positive)/(2+rs.length)};});}
export function classify(prompt:string,mode:string):Family{return mode==='coding'||/\b(code|function|html|typescript|python|build.*app)\b/i.test(prompt)?'coding':/\b(research|sources|evidence|study)\b/i.test(prompt)?'research':/\b(calculate|compare|analyse|analyze|math|plan)\b/i.test(prompt)?'analysis':'conversation';}
export function chooseStrategy(s:KernelState,family:Family):{strategy:Strategy;reason:string}{if(!s.config.enabled)return {strategy:'direct',reason:'Kernel enhancement is paused.'};if(s.config.strategy!=='adaptive')return {strategy:s.config.strategy,reason:'Owner selected this workflow.'};const p=policy(s,family);if(p.every(v=>v.examples>=3)){const best=p[0].mean>=p[1].mean?p[0]:p[1];return {strategy:best.strategy,reason:`Learned from ${p.reduce((n,v)=>n+v.examples,0)} explicit ratings in ${family}; preference estimate, not correctness.`};}return {strategy:family==='conversation'?'direct':'verify',reason:'Bootstrap rule; insufficient feedback for both workflows.'};}
export function developmentMetrics(s:KernelState){return evaluate(activeModel(s),[...dataset.development as Row[],...s.development]);}

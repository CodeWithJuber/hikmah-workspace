import {CASEFOLD} from '../engines/casefold';
import {validateField,type FieldModel} from './field-model';
import {compileContext,detectLanguage,documentSentences} from './discourse';
const cache=new Map<string,Promise<FieldModel>>();
const overrides=new Map<string,FieldModel>();
export function setLocalField(model:FieldModel){overrides.set(model.language,validateField(model));}
export function clearLocalField(language:string){overrides.delete(language);}
export async function loadReleasedField(language:string):Promise<FieldModel>{if(!['en','ar','hi','es','tr'].includes(language))throw Error('No trained syntax checkpoint for '+language);const r=await fetch('/research/v6/models/'+language+'.model.json');if(!r.ok)throw Error('Context checkpoint could not load.');return validateField(await r.json());}
export function invalidateField(language:string){cache.delete(language);overrides.delete(language);}
export async function loadField(language:string):Promise<FieldModel>{if(overrides.has(language))return overrides.get(language)!;if(!cache.has(language))cache.set(language,(async()=>{const r=await fetch('/api/context-model?language='+encodeURIComponent(language),{cache:'no-store'});if(!r.ok)throw Error('Active context checkpoint could not be checked.');const data=await r.json() as {model?:unknown};return data.model?validateField(data.model):loadReleasedField(language);})().catch(e=>{cache.delete(language);throw e;}));return cache.get(language)!;}
export async function analyzeContext(text:string,language='auto'){
 const languages=language==='auto'?[...new Set(documentSentences(text).slice(-24).map(detectLanguage))]:[language];const loaded:Record<string,FieldModel>={};
 await Promise.all(languages.filter(l=>['en','ar','hi','es','tr'].includes(l)).map(async l=>{loaded[l]=await loadField(l);}));return compileContext(text,loaded,language);
}
type Association={token:string;probability:number;top3Share:number;support:number};
type Lexical={models:Record<string,{enToTarget:Record<string,{candidates:Association[]}>;targetToEn:Record<string,{candidates:Association[]}>}>};
let lexical:Promise<Lexical>|undefined;
export async function arabicCandidates(language:string,word:string){lexical??=fetch('/research/v6/lexical-associations.json').then(r=>{if(!r.ok)throw Error('Lexical checkpoint could not load.');return r.json() as Promise<Lexical>;}).catch(e=>{lexical=undefined;throw e;});const data=await lexical!,key=Array.from(word.normalize('NFKC')).map(c=>CASEFOLD.get(c)??c).join('');if(language==='ar')return [{arabic:word,via:'surface Arabic',score:1,support:0}];const english=language==='en'?[{token:key,probability:1,support:0}]:Object.hasOwn(data.models[language]?.targetToEn??{},key)?data.models[language].targetToEn[key].candidates:[];
 const candidates=english.flatMap(e=>(Object.hasOwn(data.models.ar.enToTarget,e.token)?data.models.ar.enToTarget[e.token].candidates:[]).map(a=>({arabic:a.token,via:e.token,score:e.probability*a.probability,support:language==='en'?a.support:Math.min(e.support,a.support)})));return candidates.sort((a,b)=>b.score-a.score).slice(0,6);
}

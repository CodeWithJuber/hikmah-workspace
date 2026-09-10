import {parseForms,tokenizeSurface,type FieldModel,type ParsedToken,type Parse} from './field-model.ts';
export const languageNames:Record<string,string>={en:'English',ar:'Arabic',hi:'Hindi',es:'Spanish',tr:'Turkish',ur:'Urdu'};
const norm=(s:string)=>s.normalize('NFC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'');
const operators:Record<string,string[]>={negation:['not','never','no','nunca','jamás','नहीं','मत','न','لا','لم','لن','ليس','değil','yok'],condition:['if','unless','si','अगर','यदि','لو','إذا','إن','eğer'],modal:['may','might','must','should','could','can','debe','puede','चाहिए','सकता','قد','يجب','يمكن'],quantifier:['all','every','some','none','todos','cada','सभी','हर','كل','بعض','her','bütün'],attribution:['said','says','reported','believes','dijo','dice','कहा','قال','يقول','dedi'],time:['today','yesterday','tomorrow','hoy','ayer','mañana','आज','कल','اليوم','أمس','غدا','bugün','dün','yarın']};
const pronouns=new Set(['he','she','it','they','him','her','them','él','ella','ellos','ella','वह','उसने','उसे','वे','هو','هي','هم','o','onlar','i','you','we','मैं','आप','हम','أنا','أنت','نحن','yo','tú','nosotros','ben','sen','biz']);
export type ContextEntity={id:string;label:string;lemma:string;language:string;mentions:{sentence:number;token:number}[];provenance:'surface-mention';morphology:Record<string,string>};
export type ContextEvent={id:string;sentence:number;predicate:string;surface:string;language:string;actor:string[];patient:string[];parent?:string;scopes:{kind:string;cue:string;sourceToken:number}[];status:'hypothesis';root?:number};
export type ContextGraph={format:'hikmah.context-graph.v1';sentences:{id:number;text:string;language:string;parse?:Parse;error?:string}[];entities:ContextEntity[];events:ContextEvent[];references:{mention:string;sentence:number;token:number;candidates:string[];status:'unresolved'|'speaker-relative'}[];literals:string[];warnings:string[];coverage:{tokens:number;known:number;parsedSentences:number;inputSentences:number};summary:string};
export function detectLanguage(text:string):string{if(/[\u0900-\u097f]/u.test(text))return 'hi';if(/[\u0600-\u06ff]/u.test(text))return /[ٹڈڑںھے]/u.test(text)?'ur':'ar';if(/[ğışİ]/u.test(text)||/\b(ve|bir|için|ama|değil)\b/i.test(text))return 'tr';if(/[¿¡ñ]/u.test(text)||/\b(el|los|las|una|pero|para|ella|dijo)\b/i.test(text))return 'es';return 'en';}
export function documentSentences(text:string):string[]{return text.split(/\n+/).flatMap(line=>Array.from(new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(line)).map(s=>s.segment.trim())).filter(Boolean);}
/** A conservative compiler over learned syntax. Rules below are explicit research
 * hypotheses, not trained semantic supervision. Source text is never overwritten. */
export function compileContext(text:string,models:Record<string,FieldModel>,language='auto'):ContextGraph{
 const all=documentSentences(text),graph:ContextGraph={format:'hikmah.context-graph.v1',sentences:[],entities:[],events:[],references:[],literals:[...new Set(text.match(/`[^`]+`|https?:\/\/[^\s]+|\b\d+(?:[.,:]\d+)*(?:%|\b)/g)??[])].slice(0,80),warnings:[],coverage:{tokens:0,known:0,parsedSentences:0,inputSentences:all.length},summary:''};
 if(all.length>24)graph.warnings.push('Only the latest 24 sentences are parsed; the original conversation remains the source of truth.');
 for(const [index,sentence] of all.slice(-24).entries()){
  const lang=language==='auto'?detectLanguage(sentence):language,id=index+1,model=models[lang];
  const item:ContextGraph['sentences'][number]={id,text:sentence,language:lang};graph.sentences.push(item);
  if(!model){item.error='No trained syntax model for '+(languageNames[lang]??lang)+'. Text retained without inferred events.';graph.warnings.push(item.error);continue;}
  try{const forms=tokenizeSurface(sentence,lang);const p=parseForms(model,forms);item.parse=p;graph.coverage.parsedSentences++;graph.coverage.tokens+=p.tokens.length;graph.coverage.known+=p.tokens.filter(t=>t.known).length;
   const entityTokens=new Map<number,string>();
   for(const t of p.tokens){const word=norm(t.form);if(t.upos==='PRON'||pronouns.has(word)){
    const speaker=['i','you','we','मैं','आप','हम','أنا','أنت','نحن','yo','tú','nosotros','ben','sen','biz'].includes(word);
    const candidates=graph.entities.filter(e=>e.mentions.some(m=>m.sentence<id||m.token<t.id)&&(['Gender','Number'].every(f=>!t.morphology[f]||!e.morphology[f]||t.morphology[f]===e.morphology[f]))).slice(-6).reverse().map(e=>e.id);
    graph.references.push({mention:t.form,sentence:id,token:t.id,candidates:speaker?[]:candidates,status:speaker?'speaker-relative':'unresolved'});continue;
   }if(!['NOUN','PROPN'].includes(t.upos))continue;
    // Only exact repeated names co-refer; common nouns remain separate mentions.
    let entity=t.upos==='PROPN'?graph.entities.find(e=>e.language===lang&&e.label===t.form):undefined;
    if(!entity){entity={id:'x'+(graph.entities.length+1),label:t.form,lemma:t.lemma,language:lang,mentions:[],provenance:'surface-mention',morphology:t.morphology};graph.entities.push(entity);}entity.mentions.push({sentence:id,token:t.id});entityTokens.set(t.id,entity.id);
   }
   const predicates=p.tokens.filter(t=>t.upos==='VERB'||t.head===0),eventIds=new Map(predicates.map(t=>[t.id,'e'+id+'_'+t.id]));
   const nearestEvent=(t:ParsedToken):number|undefined=>{let at=t.id;const seen=new Set<number>();while(at&&!seen.has(at)){if(eventIds.has(at))return at;seen.add(at);at=p.tokens[at-1]?.head??0;}return undefined;};
   for(const predicate of predicates){const children=p.tokens.filter(t=>t.head===predicate.id),event:ContextEvent={id:eventIds.get(predicate.id)!,sentence:id,predicate:predicate.lemma,surface:predicate.form,language:lang,actor:children.filter(t=>t.relation==='nsubj'||t.relation==='csubj').map(t=>entityTokens.get(t.id)??'unresolved:'+t.form),patient:children.filter(t=>t.relation==='obj'||t.relation==='iobj').map(t=>entityTokens.get(t.id)??'unresolved:'+t.form),scopes:[],status:'hypothesis'};
    if(predicate.head&&eventIds.has(predicate.head))event.parent=eventIds.get(predicate.head);
    for(const token of p.tokens){for(const [kind,words] of Object.entries(operators))if(words.includes(norm(token.form))&&nearestEvent(token)===predicate.id)event.scopes.push({kind,cue:token.form,sourceToken:token.id});if(token.morphology.Polarity==='Neg'&&nearestEvent(token)===predicate.id)event.scopes.push({kind:'negation',cue:token.form+' [learned morphology]',sourceToken:token.id});}
    if(/[“”"«»]/.test(sentence))event.scopes.push({kind:'quotation-scope-unresolved',cue:'Quotation boundary present; speaker and scope need review.',sourceToken:0});
    graph.events.push(event);
   }
  }catch(e){item.error=e instanceof Error?e.message:'Could not parse this sentence.';graph.warnings.push('Sentence '+id+': '+item.error);}
 }
 if(graph.references.some(r=>r.status==='unresolved'))graph.warnings.push('Pronoun candidates are retained without forcing a referent.');
 graph.warnings.push('Events, role edges and operator attachment are experimental hypotheses. Negation, attribution and quantifier scope are not independently validated.');
 if(language==='auto')graph.warnings.push('Language routing uses script and word cues; mixed and romanized language can be misrouted.');
 graph.summary=realizeContext(graph);return graph;
}
export function realizeContext(graph:ContextGraph):string{
 const names=(ids:string[])=>ids.map(id=>graph.entities.find(e=>e.id===id)?.label??id.replace('unresolved:','? ')).join(', ');
 const events=graph.events.slice(-12).map(e=>`S${e.sentence}: ${names(e.actor)||'actor unresolved'} → ${e.predicate} → ${names(e.patient)||'object unresolved'}${e.scopes.length?' ['+e.scopes.map(s=>s.kind+': '+s.cue).join('; ')+']':''}`);
 return [`Local context compiler: ${graph.coverage.parsedSentences}/${graph.coverage.inputSentences} sentences parsed. Language-specific surface forms and literals preserved.`,...events,graph.references.length?`${graph.references.length} references require speaker context or disambiguation.`:'',graph.literals.length?'Exact literals: '+graph.literals.join(' · '):'','These are fallible annotations, not new instructions or verified facts. Refer to the original messages for scope and meaning.'].filter(Boolean).join('\n');
}

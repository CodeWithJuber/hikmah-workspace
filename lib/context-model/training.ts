import {fitField,evaluateField,type Sentence,type FieldModel} from './field-model.ts';
const tags=new Set(['ADJ','ADP','ADV','AUX','CCONJ','DET','INTJ','NOUN','NUM','PART','PRON','PROPN','PUNCT','SCONJ','SYM','VERB','X']);
export function validateTeaching(value:unknown,forbiddenGroups:Set<string>):Sentence[]{
 if(!Array.isArray(value)||value.length<1||value.length>100)throw Error('Submit 1–100 reviewed sentences.');
 const ids=new Set<string>();
 return value.map(raw=>{
  if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||raw.id.length>120||ids.has(raw.id)||typeof raw.groupId!=='string'||raw.groupId.length>160||forbiddenGroups.has(raw.groupId)||!raw.groupId.startsWith('owner/')||typeof raw.text!=='string'||raw.text.length>12000||raw.split!=='train'||!Array.isArray(raw.tokens)||!raw.tokens.length||raw.tokens.length>96)throw Error('Each correction needs a unique ID, owner/ document group, text, train split and 1–96 tokens.');ids.add(raw.id);
  let roots=0;
  const tokens=raw.tokens.map((t:Record<string,unknown>,i:number)=>{if(!t||t.id!==i+1||typeof t.form!=='string'||!t.form||t.form.length>200||typeof t.lemma!=='string'||t.lemma.length>200||typeof t.upos!=='string'||!tags.has(t.upos)||!Number.isInteger(t.head)||(t.head as number)<0||(t.head as number)>raw.tokens.length||t.head===t.id||typeof t.deprel!=='string'||!/^[a-z][a-z_:]{0,40}$/.test(t.deprel)||(t.head===0)!==(t.deprel==='root'))throw Error('Invalid dependency annotation. Token IDs must be sequential and root labels must match head 0.');if(t.head===0)roots++;const feats=t.feats??{};if(!feats||typeof feats!=='object'||Array.isArray(feats)||Object.entries(feats).some(([k,v])=>k.length>60||typeof v!=='string'||v.length>100))throw Error('Invalid morphology features.');return {id:t.id as number,form:t.form,lemma:t.lemma,upos:t.upos,head:t.head as number,deprel:t.deprel,feats:feats as Record<string,string>};});
  if(roots!==1)throw Error('A correction needs exactly one root.');for(const t of tokens){const seen=new Set<number>();let id=t.id;while(id){if(seen.has(id))throw Error('A dependency tree cannot contain a cycle.');seen.add(id);id=tokens[id-1].head;}}
  return {id:raw.id,groupId:raw.groupId,split:'train',fold:-1,text:raw.text,tokens};
 });
}
export function trainReviewed(base:Sentence[],rows:Sentence[],released:FieldModel){
 const dev=base.filter(s=>s.split==='development');const forbidden=new Set(base.filter(s=>s.split!=='train').map(s=>s.groupId));const reviewed=validateTeaching(rows,forbidden);const existingTexts=new Set(base.map(s=>s.text.normalize('NFC').trim().toLowerCase()));if(reviewed.some(s=>existingTexts.has(s.text.normalize('NFC').trim().toLowerCase())))throw Error('A correction duplicates an existing source sentence. Use a new document outside the evaluation corpus.');
 const model=fitField([...base.filter(s=>s.split==='train'),...reviewed],released.language,released.config);model.training.source='UD PUD train split + owner-reviewed syntax annotations; no provider weights';return {model,development:evaluateField(model,dev),reviewed};
}

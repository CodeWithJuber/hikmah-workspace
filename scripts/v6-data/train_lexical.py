"""Transparent sparse IBM Model 1 baseline. Fits train only, no embeddings/transformer/LLM.
Copyright (c) 2026 Hikmah contributors. Implementation license: MIT.
Data notices are separate and retained in each generated model card.
"""
from pathlib import Path
import json,unicodedata,collections,hashlib,math,time
ROOT=Path(__file__).parent;OUT=ROOT/'learned';OUT.mkdir(exist_ok=True);NULL='<NULL>'
LANGS=['ar','hi','ur','es','tr'];MIN_DF=3;MIN_JOINT=3;EPOCHS=5

def sha(b):return hashlib.sha256(b).hexdigest()
def tokens(text,lang):
 text=unicodedata.normalize('NFKC',text).casefold();out=[];cur=[]
 for c in text:
  cp=ord(c)
  if lang=='ar' and (0x064b<=cp<=0x065f or cp==0x0670 or 0x06d6<=cp<=0x06ed):continue
  kind=unicodedata.category(c)[0]
  if kind in 'LMN' or (c in "'’" and cur):cur.append(c)
  elif cur:out.append(''.join(cur).strip("'’"));cur=[]
 if cur:out.append(''.join(cur).strip("'’"))
 return [t for t in out if t]

def train(pairs,src_lang,tgt_lang):
 examples=[];src_groups=collections.defaultdict(set);tgt_groups=collections.defaultdict(set)
 for r in pairs:
  sx=tokens(r['en'] if src_lang=='en' else r['text'],src_lang);ty=tokens(r['en'] if tgt_lang=='en' else r['text'],tgt_lang)
  if not sx or not ty or len(sx)>64 or len(ty)>64:continue
  examples.append((r['groupId'],sx,ty))
  for w in set(sx):src_groups[w].add(r['groupId'])
  for w in set(ty):tgt_groups[w].add(r['groupId'])
 sv={w for w,g in src_groups.items() if len(g)>=MIN_DF};tv={w for w,g in tgt_groups.items() if len(g)>=MIN_DF}
 prepared=[];joint=collections.defaultdict(set)
 for group,sx,ty in examples:
  x=[w for w in sx if w in sv];y=[w for w in ty if w in tv]
  if not x or not y:continue
  prepared.append(([NULL]+x,y))
  for a in set([NULL]+x):
   for b in set(y):joint[a,b].add(group)
 table=collections.defaultdict(dict)
 for (a,b),g in joint.items():table[a][b]=1.0
 for d in table.values():
  n=len(d)
  for b in d:d[b]=1/n
 likelihood=[]
 for epoch in range(EPOCHS):
  counts={a:dict.fromkeys(d,0.) for a,d in table.items()};total=collections.Counter();ll=0;nt=0
  for x,y in prepared:
   for b in y:
    denom=sum(table[a].get(b,0.) for a in x)
    if not denom:continue
    ll+=math.log(denom/len(x));nt+=1
    for a in x:
     mass=table[a].get(b,0.)/denom
     if mass:counts[a][b]+=mass;total[a]+=mass
  for a,d in counts.items():
   for b,v in d.items():table[a][b]=v/total[a]
  likelihood.append(round(ll/max(nt,1),8))
 exported={}
 for a in sorted(sv):
  ranked=sorted([(b,p) for b,p in table.get(a,{}).items() if len(joint[a,b])>=MIN_JOINT],key=lambda z:(-z[1],z[0]))[:3]
  if ranked:
   mass=sum(p for b,p in ranked)
   exported[a]={'df':len(src_groups[a]),'retainedMass':round(mass,7),'candidates':[{'token':b,'probability':round(p,7),'top3Share':round(p/mass,7),'support':len(joint[a,b]),'targetDf':len(tgt_groups[b])} for b,p in ranked]}
 meta={'sourceLanguage':src_lang,'targetLanguage':tgt_lang,'trainingPairsSupplied':len(pairs),'trainingPairsUsable':len(prepared),'sourceVocabulary':len(sv),'targetVocabulary':len(tv),'sparseParameters':sum(len(d) for d in table.values()),'exportedSourceTokens':len(exported),'exportedAssociations':sum(len(d['candidates']) for d in exported.values()),'meanTrainingLogLikelihoodByIteration':likelihood,'fullDistributionNormalized':all(abs(sum(d.values())-1)<1e-8 for d in table.values()),'probabilityMeaning':'p(target token | source token), normalized over full learned target vocabulary; retainedMass shows top3 fraction; top3Share renormalizes displayed candidates only'}
 return dict(table),exported,meta

def score(table,x,y):
 if not x or not y:return None
 sx=[NULL]+x
 return sum(math.log(max(sum(table.get(a,{}).get(b,0.) for a in sx)/len(sx),1e-12)) for b in y)/len(y)
def evaluate(table,rows,src_lang,tgt_lang):
 items=[];covered_src=covered_tgt=total_src=total_tgt=0;target_vocab={b for d in table.values() for b in d}
 for r in sorted(rows,key=lambda r:r['id']):
  x=tokens(r['en'] if src_lang=='en' else r['text'],src_lang);y=tokens(r['en'] if tgt_lang=='en' else r['text'],tgt_lang)
  total_src+=len(x);total_tgt+=len(y);covered_src+=sum(a in table for a in x);covered_tgt+=sum(b in target_vocab for b in y)
  if x and y:items.append((r['groupId'],x,y))
 wins=ties=n=0
 for i,(g,x,y) in enumerate(items):
  j=(i+max(1,len(items)//2))%len(items);attempts=0
  while attempts<len(items) and (items[j][0]==g or items[j][2]==y):j=(j+1)%len(items);attempts+=1
  if attempts==len(items):continue
  good=score(table,x,y);wrong=score(table,x,items[j][2]);n+=1
  if abs(good-wrong)<1e-9:ties+=1
  elif good>wrong:wins+=1
 return {'pairs':n,'truePairHigherThanDeterministicShuffledTarget':wins,'ties':ties,'pairDiscriminationRate':round((wins+ties*.5)/n,5) if n else None,'sourceTokenCoverage':round(covered_src/max(total_src,1),5),'targetTokenCoverage':round(covered_tgt/max(total_tgt,1),5),'interpretation':'aligned-vs-shuffled sentence compatibility sanity check; NOT word alignment accuracy, translation quality, or semantic truth'}

if __name__=='__main__':
 start=time.time();sets={s:json.loads((ROOT/'processed'/f'tatoeba-{s}.json').read_text())['pairs'] for s in ['train','development','test']};metrics={};models={};total=0
 for lang in LANGS:
  pairs=[r for r in sets['train'] if r['language']==lang];models[lang]={};metrics[lang]={}
  for src,tgt,direction in [('en',lang,'enToTarget'),(lang,'en','targetToEn')]:
   table,export,meta=train(pairs,src,tgt);models[lang][direction]=export
   served={a:{c['token']:c['probability'] for c in row['candidates']} for a,row in export.items()}
   metrics[lang][direction]={'training':meta,'evaluationArtifact':'exported top3/pruned parameters; no NULL distribution exported','development':evaluate(served,[r for r in sets['development'] if r['language']==lang],src,tgt),'test':evaluate(served,[r for r in sets['test'] if r['language']==lang],src,tgt),'fullModelDiagnostic':{'development':evaluate(table,[r for r in sets['development'] if r['language']==lang],src,tgt),'test':evaluate(table,[r for r in sets['test'] if r['language']==lang],src,tgt)}}
   print(lang,direction,'exported',meta['exportedAssociations'],flush=True)
 parameters={'schema':'hikmah.lexical-association.ibm1.v1','algorithm':'IBM Model 1, independent bidirectional sparse EM','languages':['en']+LANGS,'iterations':EPOCHS,'minDocumentGroupFrequency':MIN_DF,'minPairGroupSupport':MIN_JOINT,'maxCandidatesPerToken':3,'normalization':'Unicode NFKC + casefold; words comprise letters/marks/numbers; Arabic diacritics removed; no stemming, transliteration or learned tokenization','sourceSplit':'train only','notices':'Derived from OPUS Tatoeba v2026-07-08, Tatoeba contributors / OPUS Jörg Tiedemann, CC-BY-2.0-FR. Aggregate token associations; not semantic truth, Quranic roots, or endorsement. See accompanying attribution and source manifests.','bridgeUse':'targetToEn(language token), then enToTarget(ar); multiply conditional probabilities and retain ambiguity; this is an Arabic surface-word candidate path, NOT a Quranic-root or etymology claim.','models':models}
 b=json.dumps(parameters,ensure_ascii=False,separators=(',',':')).encode();assert len(b)<5_000_000;(OUT/'lexical-associations.json').write_bytes(b)
 report={'schema':'hikmah.lexical-association.report.v1','modelSha256':sha(b),'modelBytes':len(b),'trainingFileSha256':sha((ROOT/'processed/tatoeba-train.json').read_bytes()),'trainingIdsSha256':sha('\n'.join(sorted(r['id'] for r in sets['train'])).encode()),'algorithm':parameters['algorithm'],'hyperparameters':{k:parameters[k] for k in ['iterations','minDocumentGroupFrequency','minPairGroupSupport','maxCandidatesPerToken']},'fitData':'train only; development/test read for post-fit reporting only; no selection against these metrics','metrics':metrics,'elapsedSeconds':round(time.time()-start,3),'limitations':['IBM Model 1 is established prior art, not a novel architecture','Independent token alignment cannot establish contextual word senses, discourse, or historical ancestry','No gold word-alignment references; held-out metric is only a shuffled-pair compatibility control','No word reordering model and no sentence generation','Rare words with fewer than three source groups excluded; Urdu coverage limited','A probability is a learned conditional association, not factual confidence']}
 (OUT/'lexical-association-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print('model_bytes',len(b),'seconds',report['elapsedSeconds'],flush=True)

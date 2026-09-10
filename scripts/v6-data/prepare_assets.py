"""Deterministic local preparation. No network; no synthesized semantic labels."""
import pathlib, json, hashlib, unicodedata, re, zipfile, itertools, collections
ROOT=pathlib.Path(__file__).parent
OUT=ROOT/'processed';OUT.mkdir(exist_ok=True)
LANGS=['en','ar','hi','es','tr']
def digest(s):return hashlib.sha256(s.encode('utf-8')).hexdigest()
def norm(s):return ' '.join(unicodedata.normalize('NFKC',s).casefold().split())
def dump(path,obj):
 b=json.dumps(obj,ensure_ascii=False,separators=(',',':')).encode();path.write_bytes(b)
 return {'file':str(path.relative_to(ROOT)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def ud():
 stats={};outputs=[];allrows={};blocked=set()
 for lang in LANGS:
  p=ROOT/'raw'/'ud-pud'/lang;provenance=json.loads((p/'provenance.json').read_text());text=(p/f'{lang}_pud-ud-test.conllu').read_text(); rows=[];doc=None
  for block in text.strip().split('\n\n'):
   meta={};tokens=[];mwt=[];empty=[]
   for line in block.splitlines():
    if line.startswith('# ') and ' = ' in line: k,v=line[2:].split(' = ',1);meta[k]=v
    elif not line.startswith('#'):
     c=line.split('\t')
     if len(c)!=10:raise ValueError('not CoNLL-U')
     if '-' in c[0]:mwt.append({'id':c[0],'form':c[1],'misc':c[9]});continue
     if '.' in c[0]:empty.append({'id':c[0],'form':c[1],'deps':c[8]});continue
     tokens.append({'id':int(c[0]),'form':c[1],'lemma':c[2],'upos':c[3],'head':int(c[6]),'deprel':c[7],'feats':{} if c[5]=='_' else dict(x.split('=',1) for x in c[5].split('|'))})
   doc=meta.get('newdoc id',doc)
   if not doc:raise ValueError('missing source document')
   sent=meta['sent_id'];group='pud/'+doc;fold=int(digest('hikmah-pud-v6|'+group)[:8],16)%10
   if [t['id'] for t in tokens]!=list(range(1,len(tokens)+1)):raise ValueError('nonsequential token IDs')
   if any(t['head']<0 or t['head']>len(tokens) for t in tokens):raise ValueError('invalid head')
   row={'id':sent,'parallelId':meta.get('parallel_id','pud/'+sent),'groupId':group,'fold':fold,'split':'test' if fold==0 else 'development' if fold==1 else 'train','text':meta['text'],'tokens':tokens,'hasMultiwordTokens':bool(mwt),'multiwordTokens':mwt,'hasEmptyNodes':bool(empty),'emptyNodes':empty}
   rows.append(row);blocked.add(norm(meta['text']))
   if 'text_en' in meta:blocked.add(norm(meta['text_en']))
  allrows[lang]=rows
  stats[lang]={'sentences':len(rows),'tokens':sum(len(r['tokens']) for r in rows),'splits':dict(collections.Counter(r['split'] for r in rows)),'folds':dict(sorted(collections.Counter(r['fold'] for r in rows).items())),'multiword_sentences':sum(r['hasMultiwordTokens'] for r in rows),'empty_node_sentences':sum(r['hasEmptyNodes'] for r in rows)}
  outputs.append(dump(OUT/f'ud-pud-{lang}.json',{'schema':'hikmah.ud-pud.research.v1','language':lang,'license':'CC-BY-SA-3.0','provenance':provenance,'annotationTarget':'UD basic syntax and morphology, not verified semantic meaning','evaluationInput':'gold token boundaries; do not report as raw-text end-to-end parsing','splitProtocol':'internal document-grouped split; 0=test, 1=development, 2..9=train; not completed ten-fold cross-validation','sentences':rows}))
 base={r['parallelId']:(r['groupId'],r['fold']) for r in allrows['en']}
 for lang,rows in allrows.items():assert {r['parallelId']:(r['groupId'],r['fold']) for r in rows}==base,lang
 dump(OUT/'ud-pud-exclusion-hashes.json',sorted(digest(s) for s in blocked))
 return stats,outputs,blocked

def tatoeba(blocked):
 # Bounded 5k/pair before downstream training. Per-language record hashes avoid archive-order bias.
 selected=[];stats={};outputs=[]
 for lang in ['ar','hi','ur','es','tr']:
  p=ROOT/'raw'/'tatoeba'/lang;z=zipfile.ZipFile(p/'source.zip');prov=json.loads((p/'provenance.json').read_text());enname=next(n for n in z.namelist() if n.endswith('.en'));other=next(n for n in z.namelist() if n.endswith('.'+lang));candidates={};exclusions=0;raw=0
  with z.open(enname) as a,z.open(other) as b:
   for i,pair in enumerate(itertools.zip_longest(a,b),1):
    if None in pair:raise ValueError('unaligned row count')
    en,tx=[s.decode('utf-8').rstrip('\r\n') for s in pair];raw+=1;ne,nt=norm(en),norm(tx)
    if not ne or not nt or len(en)>512 or len(tx)>768 or ne in blocked or nt in blocked:exclusions+=1;continue
    key=digest(lang+'\0'+ne+'\0'+nt)
    if key not in candidates:candidates[key]={'id':'tatoeba-'+lang+'-'+key[:20],'language':lang,'en':en,'text':tx,'sourceLine':i,'sourceArchive':prov['url'],'sourceArchiveSha256':prov['sha256'],'originalSentenceIds':None,'authors':None,'license':'CC-BY-2.0-FR','annotationStatus':'community aligned text; not gold semantic labels'}
  chosen=[candidates[k] for k in sorted(candidates)[:5000]];selected.extend(chosen)
  for n in ['README','LICENSE']:(p/n).write_bytes(z.read(n))
  stats[lang]={'downloaded_pairs':raw,'eligible_unique_pairs':len(candidates),'selected_pairs':len(chosen),'excluded_empty_long_or_pud':exclusions}
 # Connected components of normalized text: prevents identical English OR target strings leaking.
 parent={}
 def find(a):
  parent.setdefault(a,a)
  if parent[a]!=a:parent[a]=find(parent[a])
  return parent[a]
 def union(a,b):
  a,b=find(a),find(b)
  if a!=b:parent[max(a,b)]=min(a,b)
 for r in selected:union('en:'+norm(r['en']),r['language']+':'+norm(r['text']))
 buckets=collections.defaultdict(list)
 for r in selected:
  component=find('en:'+norm(r['en']));group='tatoeba/'+digest(component);fold=int(digest('hikmah-tatoeba-v6|'+component)[:8],16)%10
  r.update({'groupId':group,'fold':fold,'split':'test' if fold==0 else 'development' if fold==1 else 'train'})
  buckets[r['split']].append(r)
 for split,rows in buckets.items():outputs.append(dump(OUT/f'tatoeba-{split}.json',{'schema':'hikmah.parallel-pairs.research.v1','license':'CC-BY-2.0-FR','attribution':'Tatoeba contributors; OPUS release v2026-07-08 by Jörg Tiedemann. Keep upstream LICENSE and README. Moses export does not provide original sentence IDs or authors. Exact archive URL, SHA256 and row retained.','redistributionStatus':'sentence-author metadata unavailable in upstream Moses export; retain upstream notices, resolve individual attribution before publishing text excerpts in production','splitProtocol':'selected-pair connected components of normalized English/target text; source sentence translations remain together','pairs':sorted(rows,key=lambda r:r['id'])}))
 for lang in stats:stats[lang]['splits']=dict(collections.Counter(r['split'] for r in selected if r['language']==lang))
 # Exact overlap assertions across all splits / languages / source strings.
 seen={}
 for r in selected:
  for key in [('en',norm(r['en'])),(r['language'],norm(r['text']))]:
   assert key not in seen or seen[key]==r['split'];seen[key]=r['split']
 assert all(norm(r['en']) not in blocked and norm(r['text']) not in blocked for r in selected)
 return stats,outputs,{'exact_cross_split_text_overlap':0,'cross_split_translation_component_overlap':0,'pud_text_overlap':0,'flores_exclusion':'FLORES not acquired; no FLORES files ingested. Cannot assert no phrase overlap with a corpus not acquired.','not_guaranteed':['paraphrase or template-family separation','unseen-source document separation because Tatoeba Moses has no document IDs','historical LLM pretraining contamination']}
if __name__=='__main__':
 us,uo,blocked=ud();ts,to,audit=tatoeba(blocked)
 manifest={'version':'hikmah-multilingual-data.v6.1','retrieved_at':'2026-09-10','baseline':{'train_rows':144,'status':'AI-authored controlled synthetic single-event frames'},'ud_pud':us,'tatoeba':ts,'audit':audit,'outputs':uo+to,'downloaded_source_bytes':sum(sum(x['bytes'] for x in json.loads(f.read_text())['sources']) for f in (ROOT/'raw'/'ud-pud').glob('*/provenance.json'))+sum(json.loads(f.read_text())['bytes'] for f in (ROOT/'raw'/'tatoeba').glob('*/provenance.json')),'raw_directory_bytes':sum(p.stat().st_size for p in (ROOT/'raw').rglob('*') if p.is_file()),'limitations':['No new semantic gold labels created','PUD syntax/morphology annotations include automatically assigned fields; see per-language README','Tatoeba sentences are community translations and may have errors or offensive content','No proof that every language descends from Quranic Arabic','Downloaded data does not by itself improve the existing six-field engine; a compatible trained parser/alignment model and held-out evaluation are required']}
 (ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2));print(json.dumps(manifest,ensure_ascii=False,indent=2))

"""Inspect official PMB sample; preserve annotation quality and per-subcorpus licenses."""
from pathlib import Path
import json,zipfile,re,shlex,hashlib,collections
ROOT=Path(__file__).parent;P=ROOT/'raw'/'pmb';OUT=ROOT/'processed';z=zipfile.ZipFile(P/'source.zip');names=set(z.namelist());records=[]
def parse_meta(s):return dict(line.split(':',1)[0:1]+[line.split(':',1)[1].strip()] for line in s.splitlines() if ':' in line)
def parse_clf(s):
 clauses=[]
 for i,line in enumerate(s.splitlines(),1):
  if not line.strip() or line.lstrip().startswith('%'):continue
  lex=shlex.shlex(line,posix=False);lex.whitespace_split=True;lex.commenters='%';atoms=list(lex)
  if len(atoms)<3:raise ValueError('invalid clause')
  spans=[{'start':int(a),'end':int(b)} for a,b in re.findall(r'\[(\d+)\.\.\.(\d+)\]',line)]
  clauses.append({'box':atoms[0],'predicate':atoms[1],'args':atoms[2:],'alignmentSpans':spans,'sourceLine':i})
 return clauses
for n in sorted(names):
 if not n.endswith('.met'):continue
 parts=n.split('/');lang,quality=parts[2:4];doc=parts[4][1:]+'/'+parts[5][1:];stem=n[:-4];meta=parse_meta(z.read(n).decode());status=dict(x.split() for x in z.read(stem+'.status').decode().splitlines() if x.strip());raw=z.read(stem+'.raw').decode();clf=z.read(stem+'.drs.clf').decode();clauses=parse_clf(clf)
 sub=meta.get('subcorpus');textlicense='unresolved'
 if sub=='SICK':textlicense='CC-BY-NC-SA-3.0'
 if sub=='Tatoeba':textlicense='CC-BY-2.0-FR; individual-author attribution not checked'
 if sub=='RTE' and lang in ('it','de'):textlicense='CC-BY-3.0'
 if sub=='RTE' and lang=='nl':textlicense='CC-BY-4.0'
 known=quality=='gold' and sub=='RTE' and lang in ('de','it','nl')
 records.append({'id':'pmb-4.0/'+lang+'/'+doc,'documentId':doc,'groupId':'pmb/'+doc,'language':lang,'split':'inspection_only','annotationQuality':quality,'layerStatus':status,'metadata':meta,'text':raw,'sourceArchivePath':stem,'textLicense':textlicense,'annotationLicense':'ODC-BY-1.0','publicationEligibleForThisPack':known,'graph':{'representation':'PMB DRS clause format','clauses':clauses,'boxes':sorted({c['box'] for c in clauses}), 'variables':sorted({a for c in clauses for a in c['args'] if re.fullmatch('[xestp][0-9]+',a)})},'sbn':z.read(stem+'.drs.sbn').decode() if stem+'.drs.sbn' in names else None})
allobj={'schema':'hikmah.pmb-sample.inspection.v1','provenance':json.loads((P/'provenance.json').read_text()),'records':records}
(OUT/'pmb-sample-research.json').write_text(json.dumps(allobj,ensure_ascii=False,separators=(',',':')))
public=[r for r in records if r['publicationEligibleForThisPack']]
pub={'schema':'hikmah.pmb-graph-fixtures.v1','purpose':'schema/graph rendering fixtures, not a held-out accuracy benchmark; already inspected during development','annotationLicense':'ODC-BY-1.0','textLicenses':['CC-BY-3.0','CC-BY-4.0'],'attribution':{'PMB':'Lasha Abzianidze, Johannes Bjerva, Kilian Evang, Hessel Haagsma, Rik van Noord, Pierre Ludmann, Duc-Duy Nguyen, Johan Bos (2017), The Parallel Meaning Bank: Towards a Multilingual Corpus of Translations Annotated with Compositional Meaning Representations. EACL 2017. https://aclanthology.org/E17-2039/','RTE3-DE':'German Research Center for Artificial Intelligence (DFKI GmbH), Günter Neumann, 2013. Upstream RTE3-DE-README.txt preserved.','RTE3-ITA':'Fondazione Bruno Kessler (FBK), Luisa Bentivogli and Bernardo Magnini, 2012. Upstream RTE3-ITA-README.txt preserved.','RTE3-NL':'Center for Language and Cognition, University of Groningen, Johan Bos, 2017. Upstream RTE3-NL-README.txt preserved.'},'provenance':allobj['provenance'],'records':public}
(OUT/'pmb-shareable-graph-fixtures.json').write_text(json.dumps(pub,ensure_ascii=False,separators=(',',':')))
summary={'source':allobj['provenance'],'totalDocuments':len(records),'qualityCounts':dict(collections.Counter(r['annotationQuality'] for r in records)),'languageQualityCounts':{l:dict(collections.Counter(r['annotationQuality'] for r in records if r['language']==l)) for l in ['en','de','it','nl']},'shareableFixtureCount':len(public),'shareableFixtureLanguageCounts':dict(collections.Counter(r['language'] for r in public)),'clausesTotal':sum(len(r['graph']['clauses']) for r in records),'clausesGold':sum(len(r['graph']['clauses']) for r in records if r['annotationQuality']=='gold'),'scopePredicates':dict(collections.Counter(c['predicate'] for r in records for c in r['graph']['clauses'] if c['predicate'] in ['NEGATION','IMPLICATION','DISJUNCTION','PRESUPPOSITION','NECESSITY','POSSIBILITY'])),'limitations':['Sample selected by annotation quality, not representative random language data','Gold tagging layers checked by humans; DRS compiled by symbolic Boxer pipeline; errors remain possible','Do not train and evaluate on these same inspected fixtures','ODC-BY covers annotations; raw texts retain distinct subcorpus licenses','SICK raw text noncommercial; excluded from publication fixtures','Original English RTE license unspecified in provided metadata; excluded from publication fixtures','Tatoeba individual-author attribution not checked; excluded from publication fixtures']}
(P/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
manifest=json.loads((ROOT/'manifest.json').read_text());manifest['pmb']=summary
for f in [OUT/'pmb-sample-research.json',OUT/'pmb-shareable-graph-fixtures.json']:
 manifest['outputs']=[x for x in manifest['outputs'] if x['file']!=str(f.relative_to(ROOT))]
 manifest['outputs'].append({'file':str(f.relative_to(ROOT)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
manifest['downloaded_source_bytes']=sum(sum(x['bytes'] for x in json.loads(f.read_text())['sources']) for f in (ROOT/'raw'/'ud-pud').glob('*/provenance.json'))+sum(json.loads(f.read_text())['bytes'] for f in (ROOT/'raw'/'tatoeba').glob('*/provenance.json'))+summary['source']['bytes']
manifest['version']='hikmah-multilingual-data.v6.2'
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))

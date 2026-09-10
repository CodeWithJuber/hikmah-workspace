import urllib.request, pathlib, json, hashlib, concurrent.futures, datetime
ROOT=pathlib.Path(__file__).parent
DATA=[('en','English'),('ar','Arabic'),('hi','Hindi'),('es','Spanish'),('tr','Turkish')]
CAP=100_000_000

def fetch(url,max_bytes=5_000_000):
 req=urllib.request.Request(url,headers={'User-Agent':'Hikmah-research-data/0.1'})
 with urllib.request.urlopen(req,timeout=45) as r:
  b=r.read(max_bytes+1)
  if len(b)>max_bytes: raise ValueError('bounded download exceeded')
  return b

def acquire(item):
 lang,name=item; repo=f'UniversalDependencies/UD_{name}-PUD'; p=ROOT/'raw'/'ud-pud'/lang; p.mkdir(parents=True,exist_ok=True)
 sha=json.loads(fetch(f'https://api.github.com/repos/{repo}/commits/master'))['sha']
 sources=[]
 for file in ['README.md','LICENSE.txt',f'{lang}_pud-ud-test.conllu']:
  url=f'https://raw.githubusercontent.com/{repo}/{sha}/{file}'
  b=fetch(url,5_000_000 if file.endswith('.conllu') else 100_000); (p/file).write_bytes(b); sources.append({'file':str((p/file).relative_to(ROOT)),'url':url,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
 meta={'dataset':f'UD_{name}-PUD','language':lang,'revision':sha,'source_url':f'https://github.com/{repo}/tree/{sha}','license':'CC-BY-SA-3.0','license_url':'https://creativecommons.org/licenses/by-sa/3.0/','sources':sources}
 (p/'provenance.json').write_text(json.dumps(meta,indent=2));return meta
if __name__=='__main__':
 with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
  for result in pool.map(acquire,DATA): print(json.dumps(result),flush=True)

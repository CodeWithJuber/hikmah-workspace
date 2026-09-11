#!/usr/bin/env python3
"""Hikmah's small, stateless HTTP MCP adapter. Run on a dedicated Docker host.
Only Docker executes supplied source. SSH exposes owner-defined command aliases.
This adapter supports initialize, tools/list and tools/call, not the full MCP spec.
"""
import hmac, json, os, re, selectors, shutil, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

IMAGES = {'python': 'python:3.13-alpine', 'node': 'node:22-alpine'}
SLOTS = threading.BoundedSemaphore(2)

def docker_args(language, name, environment=None):
    if language not in IMAGES:
        raise ValueError('Choose python or node.')
    command = ['python', '-I', '-'] if language == 'python' else ['node', '--input-type=module', '-']
    return ['docker','run','--rm','-i','--name',name,'--pull=never','--network=none',
            '--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--cap-drop=ALL',
            '--security-opt=no-new-privileges','--user=65534:65534','--pids-limit=64',
            '--memory=256m','--memory-swap=256m','--cpus=0.5',
            *[item for key in (environment or {}) for item in ('-e', key)],IMAGES[language],*command]

def capture(argv, source=b'', seconds=15, environment=None):
    """No shell, bounded input/output and a deadline while reading the child."""
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    selector = selectors.DefaultSelector()
    for pipe in (proc.stdin,proc.stdout,proc.stderr): os.set_blocking(pipe.fileno(),False)
    selector.register(proc.stdin,selectors.EVENT_WRITE,'input')
    selector.register(proc.stdout,selectors.EVENT_READ,'stdout')
    selector.register(proc.stderr,selectors.EVENT_READ,'stderr')
    output={'stdout':bytearray(),'stderr':bytearray()};offset=0;deadline=time.monotonic()+seconds
    try:
        while selector.get_map():
            if time.monotonic()>deadline: raise TimeoutError('Runtime stopped at its execution deadline.')
            for key,_ in selector.select(.1):
                if key.data=='input':
                    if offset<len(source):
                        try: offset+=os.write(key.fd,source[offset:offset+4096])
                        except BrokenPipeError: offset=len(source)
                    if offset>=len(source): selector.unregister(key.fileobj);key.fileobj.close()
                else:
                    part=os.read(key.fd,4096)
                    if not part: selector.unregister(key.fileobj);key.fileobj.close();continue
                    output[key.data].extend(part)
                    if sum(map(len,output.values()))>64000: raise ValueError('Runtime output exceeded 64 KB. Print a smaller result.')
        return {k:v.decode('utf8',errors='replace') for k,v in output.items()}|{'exitCode':proc.wait(timeout=1)}
    finally:
        selector.close()
        if proc.poll() is None: proc.kill()
        proc.wait(timeout=3)
        for pipe in (proc.stdin,proc.stdout,proc.stderr):
            if not pipe.closed: pipe.close()

def run_code(args):
    code=args.get('code');language=args.get('language')
    if not isinstance(code,str) or not code.strip() or len(code.encode())>40000: raise ValueError('Code must be nonempty and under 40 KB.')
    name='hikmah-'+uuid.uuid4().hex
    environment=args.get('_env',{})
    if not isinstance(environment,dict) or len(environment)>100 or len(json.dumps(environment).encode())>32000:
        raise ValueError('Runtime environment exceeds its limit.')
    for key,value in environment.items():
        if not isinstance(key,str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}',key) or not isinstance(value,str) or '\0' in value or len(value.encode())>8192:
            raise ValueError('Invalid runtime environment variable.')
        if re.fullmatch(r'(PATH|HOME|USER|SHELL|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|LD_.*|DYLD_.*|DOCKER_.*)',key):
            raise ValueError('Reserved runtime environment variable.')
    argv=docker_args(language,name,environment)
    if not shutil.which('docker'): raise ValueError('Docker is not installed on the runtime host.')
    try: return capture(argv,code.encode(),environment={**os.environ,**environment})|{'runtime':language,'network':False,'persistent':False}
    finally:
        try: subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=False)
        except (OSError,subprocess.TimeoutExpired): pass

def load_ssh():
    filename=os.environ.get('HIKMAH_SSH_CONFIG','')
    if not filename:return {}
    config=json.loads(Path(filename).read_text())
    if not isinstance(config,dict): raise ValueError('SSH configuration must be an object.')
    for alias,item in config.items():
        if not isinstance(alias,str) or not isinstance(item,dict) or not all(isinstance(item.get(k),str) and item[k] and not item[k].startswith('-') and '\n' not in item[k] for k in ('host','user','identity','command')):
            raise ValueError('SSH aliases require host, user, identity and a fixed command.')
    return config

def ssh_action(args,config):
    alias=args.get('action')
    if alias not in config: raise ValueError('Choose an owner-configured SSH action.')
    item=config[alias]
    argv=['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ClearAllForwardings=yes','-i',item['identity'],item['user']+'@'+item['host'],item['command']]
    return capture(argv)|{'action':alias}

def catalog(config):
    tools=[{'name':'run_code','description':'Execute Python or Node source in a fresh disposable Docker container. No network or host files. 256 MiB, 15 seconds. Source and output are not saved by this adapter.','inputSchema':{'type':'object','properties':{'language':{'type':'string','enum':['python','node']},'code':{'type':'string','maxLength':40000}},'required':['language','code'],'additionalProperties':False}}]
    if config:tools.append({'name':'ssh_action','description':'Run one fixed SSH action configured by the owner. Review the selected action before allowing it.','inputSchema':{'type':'object','properties':{'action':{'type':'string','enum':list(config)}},'required':['action'],'additionalProperties':False}})
    return tools

def handler(token,origin,ssh):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):pass # No request, code, credential or result logging.
        def reply(self,status,value=None):
            self.send_response(status)
            self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
            self.send_header('Access-Control-Allow-Methods','POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name')
            self.send_header('Cache-Control','no-store')
            self.send_header('Content-Type','application/json')
            self.end_headers()
            if value is not None:self.wfile.write(json.dumps(value).encode())
        def do_OPTIONS(self):
            self.reply(204 if self.headers.get('Origin')==origin else 403)
        def do_POST(self):
            if self.path!='/mcp':return self.reply(404)
            if self.headers.get('Origin')!=origin:return self.reply(403)
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):return self.reply(401)
            length=self.headers.get('Content-Length','')
            if not length.isdigit() or not 0<int(length)<=60000:return self.reply(413)
            self.connection.settimeout(10)
            try:
                data=json.loads(self.rfile.read(int(length)))
                if not isinstance(data,dict) or data.get('jsonrpc')!='2.0':return self.reply(400)
                rpcid=data.get('id');method=data.get('method')
                if method=='notifications/initialized':return self.reply(202)
                if not isinstance(rpcid,(str,int)) or isinstance(rpcid,bool):return self.reply(400)
                if method=='initialize':result={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'hikmah-runtime','version':'1.0.0'}}
                elif method=='tools/list':result={'tools':catalog(ssh)}
                elif method=='tools/call':
                    if not SLOTS.acquire(blocking=False):return self.reply(429,{'error':'Runtime is busy. Try again after a running task completes.'})
                    try:
                        params=data.get('params',{});args=params.get('arguments',{})
                        if not isinstance(args,dict):raise ValueError('Expected tool arguments.')
                        name=params.get('name')
                        if name=='run_code':value=run_code(args)
                        elif name=='ssh_action' and ssh:value=ssh_action(args,ssh)
                        else:raise ValueError('Unknown tool.')
                        result={'content':[{'type':'text','text':json.dumps(value)}],'isError':value.get('exitCode',0)!=0}
                    except (ValueError,TimeoutError,OSError,subprocess.SubprocessError) as e:
                        # Host paths and SSH outputs remain private to the authenticated operator.
                        result={'content':[{'type':'text','text':str(e)[:1000]}],'isError':True}
                    finally:SLOTS.release()
                else:return self.reply(200,{'jsonrpc':'2.0','id':rpcid,'error':{'code':-32601,'message':'Method not supported'}})
                self.reply(200,{'jsonrpc':'2.0','id':rpcid,'result':result})
            except (ValueError,TypeError,AttributeError,TimeoutError):self.reply(400,{'error':'Invalid request.'})
    return Handler

def main():
    token=os.environ.get('HIKMAH_RUNTIME_TOKEN','');origin=os.environ.get('HIKMAH_APP_ORIGIN','')
    u=urlparse(origin)
    if len(token)<32 or '\n' in token:raise SystemExit('Set a runtime token of at least 32 characters.')
    if u.scheme!='https' or not u.netloc or u.path or u.query or u.fragment:raise SystemExit('Set the exact HTTPS app origin, without a trailing slash.')
    ThreadingHTTPServer(('127.0.0.1',8765),handler(token,origin,load_ssh())).serve_forever()
if __name__=='__main__':main()

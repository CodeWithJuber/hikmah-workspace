import http.client,json,threading,unittest
from http.server import ThreadingHTTPServer
import server
class RuntimeTests(unittest.TestCase):
    def test_docker_boundary(self):
        args=server.docker_args('python','test-run')
        for item in ['--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534','--pull=never']:self.assertIn(item,args)
        self.assertNotIn('-v',args)
        with self.assertRaises(ValueError):server.docker_args('sh; rm -rf /','bad')
    def test_real_bounded_process(self):
        r=server.capture(['python3','-I','-'],b'print(21*2)')
        self.assertEqual(r['stdout'].strip(),'42');self.assertEqual(r['exitCode'],0)
        with self.assertRaises(ValueError):server.capture(['python3','-I','-'],b'print("x"*100000)')
        with self.assertRaises(TimeoutError):server.capture(['python3','-I','-'],b'while True: pass',seconds=.2)
    def test_ssh_alias_only(self):
        with self.assertRaises(ValueError):server.ssh_action({'action':'arbitrary'}, {})
    def test_adapter_authentication_and_catalog(self):
        origin='https://app.example';token='test-token-'+'a'*32
        httpd=ThreadingHTTPServer(('127.0.0.1',0),server.handler(token,origin,{}));thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        try:
            def request(headers):
                c=http.client.HTTPConnection('127.0.0.1',httpd.server_port);c.request('POST','/mcp',json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/list'}),headers);r=c.getresponse();status=r.status;body=r.read();c.close();return status,body
            self.assertEqual(request({'Origin':origin})[0],401)
            self.assertEqual(request({'Origin':'https://wrong.example','Authorization':'Bearer '+token})[0],403)
            status,body=request({'Origin':origin,'Authorization':'Bearer '+token});self.assertEqual(status,200);self.assertEqual([t['name'] for t in json.loads(body)['result']['tools']],['run_code'])
        finally:httpd.shutdown();httpd.server_close();thread.join()
if __name__=='__main__':unittest.main()

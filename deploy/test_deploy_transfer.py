"""Rehearse the real deployment transfer from the Actions artifact, without network/Docker."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SHA = 'a' * 40

# Stand in for the remote host, but execute the release's actual checksum gate.
# Any unanticipated remote operation is refused rather than run on the test host.
TRANSPORT = r'''#!/usr/bin/env python3
import json, os, pathlib, shlex, shutil, subprocess, sys
root = pathlib.Path(os.environ['TEST_REMOTE'])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == 'curl':
    assert args[-1] == 'https://fixture.invalid/api/health'
    print(json.dumps({'status': 'ok', 'revision': os.environ['DEPLOY_SHA']}))
elif name == 'scp':
    paths = []
    i = 0
    while i < len(args):
        if args[i] in ('-o', '-P', '-i'):
            i += 2
        else:
            paths.append(args[i]); i += 1
    prefix = 'root@fixture.invalid:/opt/hikmah/'
    assert paths[-1].startswith(prefix)
    target = root / paths[-1][len(prefix):]
    for source in paths[:-1]:
        shutil.copy(source, target)
elif name == 'ssh':
    command = args[-1]
    words = shlex.split(command)
    if words[:4] == ['install', '-d', '-m', '700']:
        for destination in words[4:]:
            assert destination == '/opt/hikmah' or destination.startswith('/opt/hikmah/')
            (root / destination.removeprefix('/opt/hikmah').lstrip('/')).mkdir(parents=True, exist_ok=True)
    elif command == 'bash /opt/hikmah/incoming/bootstrap.sh':
        pass
    else:
        revision = os.environ['DEPLOY_SHA']
        assert command == f'bash /opt/hikmah/incoming/{revision}/release.sh {revision}'
        release = (root / 'incoming' / revision / 'release.sh').read_text()
        gate = '(cd "$package" && sha256sum --check image.sha256)'
        assert gate in release
        prefix = release.split(gate, 1)[0] + gate + '\n'
        assert 'cd /opt/hikmah\n' in prefix
        prefix = prefix.replace('cd /opt/hikmah\n', 'cd "$TEST_REMOTE"\n', 1)
        subprocess.run(['bash', '-s', '--', revision], input=prefix, text=True, check=True)
        (root / 'checksum-gate-passed').touch()
else:
    raise AssertionError(name)
'''


class DeployTransferTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hikmah-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        deploy = self.workspace / 'deploy'
        deploy.mkdir()
        for name in ('from-actions.sh', 'release.sh', 'configure.py'):
            shutil.copy(ROOT / 'deploy' / name, deploy / name)
        for name in ('bootstrap.sh', 'compose.yml', 'Caddyfile'):
            (deploy / name).write_text('test fixture\n')
        # What the build job of ci.yml uploads as the hikmah-images artifact.
        self.artifact = self.workspace / 'artifact'
        self.artifact.mkdir()
        (self.artifact / 'image.tar.gz').write_bytes(b'main image fixture')
        (self.artifact / 'workbench.tar.gz').write_bytes(b'workbench image fixture')
        (self.artifact / 'provenance.json').write_text(json.dumps({
            'sha': SHA, 'run_id': '100', 'repository': 'example/hikmah-workspace',
        }))
        files = ('image.tar.gz', 'workbench.tar.gz', 'provenance.json')
        (self.artifact / 'image.sha256').write_text(''.join(
            hashlib.sha256((self.artifact / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in files))
        tools = self.root / 'bin'
        tools.mkdir()
        for name in ('curl', 'ssh', 'scp'):
            path = tools / name
            path.write_text(TRANSPORT)
            path.chmod(0o700)
        self.env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
            DEPLOY_SHA=SHA, TEST_REMOTE=str(self.root / 'remote'), DEPLOY_HOST='fixture.invalid',
            DEPLOY_USER='root', DEPLOY_KNOWN_HOSTS='fixture.invalid test-fixture',
            DEPLOY_SSH_KEY='test-fixture', HIKMAH_DOMAIN='fixture.invalid',
            HIKMAH_OWNER_EMAIL='owner@fixture.invalid', HIKMAH_SESSION_SECRET='a' * 64,
            HIKMAH_OWNER_PASSWORD='')
        self.env.pop('DEPLOY_SSH_PASSWORD', None)

    def deploy(self, check=True):
        result = subprocess.run(['bash', str(self.workspace / 'deploy' / 'from-actions.sh')],
            cwd=self.workspace, env=self.env, text=True, capture_output=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_verified_artifact_passes_the_server_checksum_gate(self):
        self.deploy()
        remote = self.root / 'remote'
        self.assertTrue((remote / 'checksum-gate-passed').exists())
        self.assertEqual((remote / 'incoming' / SHA / 'provenance.json').read_bytes(),
            (self.artifact / 'provenance.json').read_bytes())

    def test_modified_image_is_rejected_on_the_server(self):
        (self.artifact / 'image.tar.gz').write_bytes(b'changed image')
        result = self.deploy(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('image.tar.gz: FAILED', result.stdout + result.stderr)
        self.assertFalse((self.root / 'remote' / 'checksum-gate-passed').exists())

    def test_password_login_is_not_offered(self):
        del self.env['DEPLOY_SSH_KEY']
        self.env['DEPLOY_SSH_PASSWORD'] = 'not-used'
        result = self.deploy(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing Actions setting: DEPLOY_SSH_KEY', result.stderr)
        self.assertFalse((self.root / 'remote').exists(), 'nothing may reach the server')

    def test_loopback_host_is_refused(self):
        for host in ('localhost', '127.0.0.1', 'app.localhost', '0.0.0.0'):
            with self.subTest(host=host):
                self.env['DEPLOY_HOST'] = host
                result = self.deploy(check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not a loopback address', result.stderr)

    def test_partial_commit_sha_is_refused(self):
        self.env['DEPLOY_SHA'] = SHA[:12]
        result = self.deploy(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('DEPLOY_SHA', result.stderr)


if __name__ == '__main__':
    unittest.main()

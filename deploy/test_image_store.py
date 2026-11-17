"""Rehearse compute storage and the real deployment transfer, without network/Docker."""
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
    if any('/actions/runs/' in arg for arg in args):
        print(os.environ['TEST_JOBS'])
    else:
        assert args[-1] == 'https://fixture.invalid/api/health'
        print(json.dumps({'status': 'ok', 'revision': os.environ['GITHUB_SHA']}))
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
        revision = os.environ['GITHUB_SHA']
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


class ImageStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hikmah-image-test-')
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
        self.artifact = self.workspace / 'artifact'
        self.artifact.mkdir()
        (self.artifact / 'image.tar.gz').write_bytes(b'main image fixture')
        (self.artifact / 'workbench.tar.gz').write_bytes(b'workbench image fixture')
        (self.artifact / 'provenance.json').write_text(json.dumps({
            'sha': SHA, 'run_id': '100', 'repository': 'CodeWithJuber/hikmah-workspace',
        }))
        tools = self.root / 'bin'
        tools.mkdir()
        for name in ('curl', 'ssh', 'scp'):
            path = tools / name
            path.write_text(TRANSPORT)
            path.chmod(0o700)
        self.env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
            GITHUB_WORKSPACE=str(self.workspace), XDG_DATA_HOME=str(self.root / 'data'),
            GITHUB_RUN_ID='100', GITHUB_RUN_ATTEMPT='2', GITHUB_OUTPUT=str(self.root / 'output'),
            GITHUB_SHA=SHA, BUILD_RUN='100', BUILD_ATTEMPT='2', GITHUB_TOKEN='test-fixture',
            GITHUB_API_URL='https://api.invalid', GITHUB_REPOSITORY='CodeWithJuber/hikmah-workspace',
            TEST_REMOTE=str(self.root / 'remote'), DEPLOY_HOST='fixture.invalid', DEPLOY_USER='root',
            DEPLOY_KNOWN_HOSTS='fixture.invalid test-fixture', DEPLOY_SSH_KEY='test-fixture',
            HIKMAH_DOMAIN='fixture.invalid', HIKMAH_OWNER_EMAIL='owner@fixture.invalid',
            HIKMAH_SESSION_SECRET='a' * 64, HIKMAH_OWNER_PASSWORD='')

    def command(self, script, *args, check=True):
        result = subprocess.run(['bash', str(script), *args], cwd=self.workspace,
            env=self.env, text=True, capture_output=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def save(self):
        self.command(ROOT / 'scripts' / 'ci-image-store.sh', 'save')
        digest = (self.root / 'output').read_text().strip().split('=', 1)[1]
        self.env['TEST_JOBS'] = json.dumps({'jobs': [{
            'name': 'Verified image manifest ' + digest, 'conclusion': 'success',
        }]})
        self.artifact.rmdir()
        return self.root / 'data' / 'hikmah-ci' / 'images' / '100-2'

    def test_store_restore_and_actual_deployment_transfer(self):
        self.save()
        self.command(ROOT / 'scripts' / 'ci-image-store.sh', 'restore')
        self.command(self.workspace / 'deploy' / 'from-actions.sh')
        remote = self.root / 'remote'
        self.assertTrue((remote / 'checksum-gate-passed').exists())
        self.assertEqual((remote / 'incoming' / SHA / 'provenance.json').read_bytes(),
            (self.artifact / 'provenance.json').read_bytes())

    def test_modified_image_is_rejected(self):
        saved = self.save()
        (saved / 'image.tar.gz').write_bytes(b'changed image')
        result = self.command(ROOT / 'scripts' / 'ci-image-store.sh', 'restore', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('image.tar.gz: FAILED', result.stdout)

    def test_wrong_or_unsuccessful_github_manifest_is_rejected(self):
        self.save()
        good = json.loads(self.env['TEST_JOBS'])['jobs'][0]
        for jobs in ([{'name': 'Verified image manifest ' + '0' * 64, 'conclusion': 'success'}],
                [dict(good, conclusion='failure')], [good, good]):
            with self.subTest(jobs=jobs):
                self.env['TEST_JOBS'] = json.dumps({'jobs': jobs})
                result = self.command(ROOT / 'scripts' / 'ci-image-store.sh', 'restore', check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('did not record this image manifest', result.stderr)
                shutil.rmtree(self.artifact)

    def test_pre_migration_manifest_still_deploys(self):
        files = ('image.tar.gz', 'workbench.tar.gz')
        (self.artifact / 'image.sha256').write_text(''.join(
            hashlib.sha256((self.artifact / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in files))
        self.command(self.workspace / 'deploy' / 'from-actions.sh')
        self.assertTrue((self.root / 'remote' / 'checksum-gate-passed').exists())


if __name__ == '__main__':
    unittest.main()

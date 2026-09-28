"""Caddy's host ports are operator-configurable, and a release waits for the
ones it is about to bind to come free before recreating it. Behind an outer
proxy those are not 80/443 — the proxy owns 80/443 — so waiting on the wrong
pair fails every release on that host.

Which pair is Compose's call: it resolves `${HIKMAH_HTTP_BIND:-80}` from both
env files by its own dotenv rules. Reading .env by hand agreed with it only for
a bare port number, and fell back to 80/443 for a quoted value, an address
prefix, an inline comment or a trailing space. `published_ports` asks Compose
instead, and these tests hold it to the port the operator configured.

Extracted from release.sh, as the stop and tidy tests do. The resolution tests
run the real `docker compose config` against the real compose.yml and are
skipped where Compose is not installed; the CI runner has it."""

import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

DEPLOY = Path(__file__).parent
RELEASE = DEPLOY / 'release.sh'

# What configure.py and release.sh leave in /opt/hikmah, bindings aside.
ENV = 'HIKMAH_DOMAIN=hikmah.example.com\nHIKMAH_SEARCH_SECRET=search\nHIKMAH_WORKBENCH_TOKEN=token\n'
RELEASE_ENV = 'HIKMAH_IMAGE=hikmah-workspace:test\nHIKMAH_WORKBENCH_IMAGE=hikmah-workbench:test\n'

SS_STUB = """#!/usr/bin/env bash
# Stands in for `ss -H -ltn FILTER`: one listening socket for every busy port
# the filter asks about.
filter=${!#}
for port in $BUSY; do
  if [[ " $filter " == *":$port "* ]]; then echo "LISTEN 0 4096 0.0.0.0:$port 0.0.0.0:*"; fi
done
"""


def extract_function(name):
    source = RELEASE.read_text()
    match = re.search(rf'^{name}\(\) \{{$.*?^\}}$', source, re.MULTILINE | re.DOTALL)
    assert match, f'{name} not found in release.sh'
    return match.group(0)


def compose_installed():
    if shutil.which('docker') is None:
        return False
    return subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode == 0


@unittest.skipUnless(compose_installed(), 'docker compose is not installed')
class PublishedPortsTests(unittest.TestCase):
    def resolve(self, bindings):
        """published_ports in a stub /opt/hikmah whose .env ends with `bindings`."""
        with TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.env').write_text(ENV + bindings)
            (home / 'release.env').write_text(RELEASE_ENV)
            shutil.copy(DEPLOY / 'compose.yml', home / 'compose.yml')
            script = (
                'set -euo pipefail\n'
                'compose=(docker compose --env-file .env --env-file release.env -f compose.yml)\n'
                f'{extract_function("published_ports")}\n'
                'published_ports\n'
            )
            # Compose lets the process environment override the env files, so a
            # binding exported where the tests run must not leak in.
            env = {k: v for k, v in os.environ.items() if not k.startswith('HIKMAH_')}
            result = subprocess.run(['bash', '-c', script], cwd=home, capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return sorted(result.stdout.split(), key=int)

    def test_a_standalone_install_binds_80_and_443(self):
        self.assertEqual(self.resolve(''), ['80', '443'])

    def test_a_bare_port_behind_an_outer_proxy(self):
        # The form compose.yml documents, and the one the production host uses.
        self.assertEqual(self.resolve('HIKMAH_HTTP_BIND=9080\nHIKMAH_HTTPS_BIND=9443\n'), ['9080', '9443'])

    def test_every_form_compose_accepts_resolves_to_the_configured_port(self):
        # Each of these falls back to 80/443 when .env is read by hand: the
        # outer proxy's ports, so the release would wait on them and roll back.
        forms = {
            'double-quoted': 'HIKMAH_HTTP_BIND="9080"\nHIKMAH_HTTPS_BIND="9443"\n',
            'single-quoted': "HIKMAH_HTTP_BIND='9080'\nHIKMAH_HTTPS_BIND='9443'\n",
            'address prefix': 'HIKMAH_HTTP_BIND=127.0.0.1:9080\nHIKMAH_HTTPS_BIND=127.0.0.1:9443\n',
            'inline comment': 'HIKMAH_HTTP_BIND=9080 # behind the portal\nHIKMAH_HTTPS_BIND=9443\n',
            'trailing space': 'HIKMAH_HTTP_BIND=9080 \nHIKMAH_HTTPS_BIND=9443\n',
        }
        for form, bindings in forms.items():
            with self.subTest(form):
                self.assertEqual(self.resolve(bindings), ['9080', '9443'])


class PortsClearTests(unittest.TestCase):
    def clear(self, caddy_ports, busy):
        """Whether ports_clear reports Caddy's ports free while `busy` ports listen."""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / 'ss'
            stub.write_text(SS_STUB)
            stub.chmod(0o755)
            script = (
                'set -euo pipefail\n'
                f'caddy_ports="{caddy_ports}"\n'
                f'{extract_function("ports_clear")}\n'
                'if ports_clear; then echo clear; else echo busy; fi\n'
            )
            result = subprocess.run(
                ['bash', '-c', script],
                capture_output=True,
                text=True,
                env={'PATH': f'{root}:/usr/bin:/bin', 'BUSY': busy},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip() == 'clear'

    def test_the_outer_proxys_ports_never_hold_up_a_release(self):
        # The production host: the portal's Caddy listens on 80/443, ours on
        # 9080/9443. The release must not wait on the portal.
        self.assertTrue(self.clear('9080 9443', busy='80 443'))

    def test_a_port_caddy_binds_that_is_still_held_blocks_it(self):
        self.assertFalse(self.clear('9080 9443', busy='9443'))
        self.assertFalse(self.clear('80 443', busy='80'))

    def test_nothing_listening_is_clear(self):
        self.assertTrue(self.clear('80 443', busy=''))


if __name__ == '__main__':
    unittest.main()

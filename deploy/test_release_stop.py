"""The deploy stops services before taking a snapshot, and the compose file it
consults is still the previous release's. A release that adds a service must not
name it there: `docker compose stop` rejects the whole command with "no such
service" before doing anything, and the first upgrade to such a release fails
before it has begun. That is exactly how the workbench release broke.

`bash -n` cannot catch this, so the function is extracted from release.sh and
exercised against a stub docker."""

import re
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

RELEASE = Path(__file__).with_name('release.sh')

STUB = """#!/usr/bin/env bash
# Stands in for `docker compose`. Reports the services the compose file defines,
# and records the stop it is asked to perform.
for arg in "$@"; do
  if [[ $arg == config ]]; then printf '%s\\n' $SERVICES; exit 0; fi
done
shift_args=()
for arg in "$@"; do
  if [[ $arg == stop ]]; then seen_stop=1; continue; fi
  if [[ -n ${seen_stop:-} ]]; then shift_args+=("$arg"); fi
done
if [[ -n ${seen_stop:-} ]]; then
  # A real `docker compose stop` fails when asked for a service it does not know.
  for name in "${shift_args[@]}"; do
    [[ $name == -t || $name =~ ^[0-9]+$ ]] && continue
    if ! printf '%s\\n' $SERVICES | grep -qx -- "$name"; then
      echo "no such service: $name" >&2
      exit 1
    fi
  done
  printf '%s\\n' "${shift_args[*]}" > "$RECORD"
fi
exit 0
"""


def extract_function(name):
    """Pull one function out of release.sh so it can be run on its own."""
    source = RELEASE.read_text()
    match = re.search(rf'^{name}\(\) \{{$.*?^\}}$', source, re.MULTILINE | re.DOTALL)
    assert match, f'{name} not found in release.sh'
    return match.group(0)


def run_stop(services, wanted=('caddy', 'app', 'workbench')):
    """Run stop_present against a compose file defining `services`.

    Returns (exit code, what stop was asked for)."""
    with TemporaryDirectory() as directory:
        root = Path(directory)
        stub = root / 'fake-docker'
        stub.write_text(STUB)
        stub.chmod(0o755)
        record = root / 'record'

        script = root / 'run.sh'
        script.write_text(
            'set -euo pipefail\n'
            f'compose=({stub})\n'
            f'{extract_function("stop_present")}\n'
            f'stop_present 30 {" ".join(wanted)}\n'
        )
        result = subprocess.run(
            ['bash', str(script)],
            capture_output=True,
            text=True,
            env={'PATH': '/usr/bin:/bin', 'SERVICES': ' '.join(services), 'RECORD': str(record)},
        )
        stopped = record.read_text().split() if record.exists() else []
        return result.returncode, stopped, result.stderr


class StopPresentTests(unittest.TestCase):
    def test_upgrade_that_adds_a_service_does_not_name_it(self):
        # The regression. The server still has the pre-workbench compose file,
        # so naming workbench aborts the release before it starts.
        code, stopped, stderr = run_stop(['app', 'search', 'caddy'])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stopped, ['-t', '30', 'caddy', 'app'])
        self.assertNotIn('workbench', stopped)

    def test_once_the_service_exists_it_is_stopped(self):
        code, stopped, stderr = run_stop(['app', 'search', 'caddy', 'workbench'])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stopped, ['-t', '30', 'caddy', 'app', 'workbench'])

    def test_a_service_never_stops_something_it_was_not_asked_for(self):
        # search is running and defined, but is not in the wanted list: stopping
        # it would take the search backend down for the length of a release.
        _, stopped, _ = run_stop(['app', 'search', 'caddy', 'workbench'])
        self.assertNotIn('search', stopped)

    def test_a_first_deployment_stops_nothing_rather_than_everything(self):
        # No compose file yet, so `config --services` reports nothing. Falling
        # through to a bare `stop` would stop the whole project.
        code, stopped, stderr = run_stop([])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stopped, [])


if __name__ == '__main__':
    unittest.main()

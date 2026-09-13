"""Every deploy loaded two images and left a snapshot, and a failed one left its
package and a copy of the data directory; nothing removed any of it. A host that
runs out of disk stops the app at boot with the same symptom as a broken
release, and the rollback then fails the same way. `tidy` keeps what a rollback
needs and removes the rest. Extracted from release.sh and run against a stub
docker, as the stop test does."""

import os
import re
import subprocess
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

RELEASE = Path(__file__).with_name('release.sh')

STUB = """#!/usr/bin/env bash
# Stands in for `docker`: lists the Hikmah images the host holds, and records
# every image it is asked to remove.
if [[ $1 == image && $2 == ls ]]; then printf '%s\\n' $IMAGES; exit 0; fi
if [[ $1 == image && $2 == rm ]]; then printf '%s\\n' "$3" >> "$RECORD"; exit 0; fi
echo "unexpected docker call: $*" >&2
exit 1
"""

NEW = 'b' * 40
RUNNING = 'a' * 40
OLDER = '9' * 40
OLDEST = '8' * 40


def extract_function(name):
    source = RELEASE.read_text()
    match = re.search(rf'^{name}\(\) \{{$.*?^\}}$', source, re.MULTILINE | re.DOTALL)
    assert match, f'{name} not found in release.sh'
    return match.group(0)


def aged(path, minutes):
    """Give a file or directory a modification time `minutes` in the past."""
    stamp = time.time() - minutes * 60
    os.utime(path, (stamp, stamp))


class TidyTests(unittest.TestCase):
    def run_tidy(self, images, deployed=RUNNING, running=RUNNING):
        """Run tidy in the stub /opt/hikmah with the given DEPLOYED_REVISION and
        the given release named in release.env; None leaves the file out."""
        root = Path(self.directory.name)
        stub = root / 'docker'
        stub.write_text(STUB)
        stub.chmod(0o755)
        record = root / 'record'
        home = self.home
        if deployed:
            (home / 'DEPLOYED_REVISION').write_text(deployed + '\n')
        if running:
            (home / 'release.env').write_text(
                f'HIKMAH_IMAGE=hikmah-workspace:{running}\nHIKMAH_WORKBENCH_IMAGE=hikmah-workbench:{running}\n'
            )
        script = root / 'run.sh'
        script.write_text(
            'set -euo pipefail\n'
            f'cd {home}\n'
            f'revision={NEW}\n'
            f'{extract_function("tidy")}\n'
            'tidy\n'
        )
        result = subprocess.run(
            ['bash', str(script)],
            capture_output=True,
            text=True,
            env={'PATH': f'{root}:/usr/bin:/bin', 'IMAGES': ' '.join(images), 'RECORD': str(record)},
        )
        removed = record.read_text().split() if record.exists() else []
        return result.returncode, removed, result.stderr

    def setUp(self):
        self.directory = TemporaryDirectory()
        self.home = Path(self.directory.name) / 'hikmah'
        self.home.mkdir()

    def tearDown(self):
        self.directory.cleanup()

    def test_keeps_the_running_and_the_new_release_and_removes_the_rest(self):
        images = [
            f'hikmah-workspace:{tag}' for tag in (OLDEST, OLDER, RUNNING, NEW)
        ] + [f'hikmah-workbench:{tag}' for tag in (OLDEST, OLDER, RUNNING)]
        code, removed, stderr = self.run_tidy(images)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(
            sorted(removed),
            sorted(
                [
                    f'hikmah-workspace:{OLDEST}',
                    f'hikmah-workspace:{OLDER}',
                    f'hikmah-workbench:{OLDEST}',
                    f'hikmah-workbench:{OLDER}',
                ]
            ),
        )

    def test_a_first_deployment_removes_nothing_it_cannot_account_for(self):
        # No DEPLOYED_REVISION and no release.env: only the new tag is known,
        # and the images present are the ones being loaded.
        code, removed, stderr = self.run_tidy([f'hikmah-workspace:{NEW}'], deployed=None, running=None)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(removed, [])

    def test_release_env_counts_even_when_deployed_revision_disagrees(self):
        # release.env names the image a rollback will start; that image must
        # survive whatever DEPLOYED_REVISION says, and so must the one it names.
        home_images = [f'hikmah-workspace:{RUNNING}', f'hikmah-workspace:{OLDER}', f'hikmah-workspace:{OLDEST}']
        code, removed, stderr = self.run_tidy(home_images, deployed=OLDER, running=RUNNING)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(removed, [f'hikmah-workspace:{OLDEST}'])

    def test_old_packages_snapshots_and_failed_copies_are_bounded(self):
        home = self.home
        incoming = home / 'incoming'
        incoming.mkdir()
        for name in (NEW, RUNNING, OLDER):
            (incoming / name).mkdir()
            (incoming / name / 'image.tar.gz').write_bytes(b'x')
        (incoming / 'bootstrap.sh').write_text('#!/bin/bash\n')
        backups = home / 'backups'
        backups.mkdir()
        for index in range(7):
            path = backups / f'pre-2026090{index}T000000Z.tar.gz'
            path.write_bytes(b'x')
            aged(path, minutes=(7 - index) * 10)
        for index in range(5):
            for prefix in ('data-failed-', 'workbench-data-failed-'):
                path = home / f'{prefix}2026090{index}T000000Z'
                path.mkdir()
                (path / 'chat.sqlite').write_bytes(b'x')
                aged(path, minutes=(5 - index) * 10)
        (home / 'data').mkdir()
        (home / 'data' / 'chat.sqlite').write_bytes(b'live')
        code, _, stderr = self.run_tidy([])
        self.assertEqual(code, 0, stderr)
        self.assertEqual(sorted(p.name for p in incoming.iterdir()), sorted([NEW, 'bootstrap.sh']))
        self.assertEqual(
            sorted(p.name for p in backups.iterdir()),
            [f'pre-2026090{index}T000000Z.tar.gz' for index in range(2, 7)],
        )
        for prefix in ('data-failed-', 'workbench-data-failed-'):
            kept = sorted(p.name for p in home.glob(f'{prefix}*'))
            self.assertEqual(kept, [f'{prefix}2026090{index}T000000Z' for index in range(2, 5)])
        self.assertEqual((home / 'data' / 'chat.sqlite').read_bytes(), b'live')


if __name__ == '__main__':
    unittest.main()

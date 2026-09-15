"""What the compose file must keep true for per-user isolation to mean anything.

The workbench supervisor runs as root so it can drop to a slot uid before exec
— `setuid(2)` needs `CAP_SETUID`, which cannot coexist with `cap_drop: [ALL]`
alone. That is a deliberate and narrow grant, and the narrowness is the whole
argument: three capabilities, and notably NOT `DAC_OVERRIDE`, so the supervisor
cannot read a slot user's files either.

Every one of these is a property someone could remove while making an unrelated
change, and none of them fails visibly when removed: the service still starts,
the shell still works, and the isolation is simply gone.
"""

import re
import unittest
from pathlib import Path

COMPOSE = Path(__file__).with_name('compose.yml')


def block(text, service):
    """The YAML block for one service, by indentation."""
    start = text.index(f'\n  {service}:')
    rest = text[start + 1 :]
    following = re.search(r'\n(?=[a-z])|\n  [a-z_-]+:\n?(?=    )', rest[1:])
    nxt = re.search(r'\n  [a-z][a-z_-]*:\n', rest[1:])
    end = (nxt.start() + 1) if nxt else len(rest)
    return rest[:end]


class ComposeIsolationTests(unittest.TestCase):
    def setUp(self):
        # Directives only. That file's comments name the capabilities it
        # deliberately does NOT grant, so a substring search over the raw text
        # would read the reasoning as configuration.
        self.text = '\n'.join(
            line for line in COMPOSE.read_text().splitlines() if not line.lstrip().startswith('#')
        )
        self.workbench = block(self.text, 'workbench')

    def test_the_supervisor_can_drop_privilege_and_no_more(self):
        # Exactly these three. SETUID and SETGID to become a slot user, CHOWN to
        # create that user's directory and to migrate a pre-slots volume.
        self.assertIn("user: '0:0'", self.workbench)
        self.assertIn('cap_drop: [ALL]', self.workbench)
        self.assertIn('cap_add: [SETUID, SETGID, CHOWN]', self.workbench)

    def test_the_supervisor_cannot_read_a_slot_users_files(self):
        # DAC_OVERRIDE is what makes root root as far as the filesystem is
        # concerned. Without it, uid 0 obeys the 0700 on a slot directory.
        for forbidden in ('DAC_OVERRIDE', 'DAC_READ_SEARCH', 'SYS_ADMIN', 'SYS_PTRACE', 'FOWNER'):
            self.assertNotIn(forbidden, self.workbench, f'{forbidden} would undo the slot boundary')

    def test_a_dropped_child_cannot_climb_back(self):
        self.assertIn('no-new-privileges:true', self.workbench)

    def test_the_workbench_still_holds_no_secrets(self):
        # It hands people a shell; .env holds the vault key and session secret.
        self.assertNotIn('env_file', self.workbench)

    def test_every_service_has_a_cpu_share(self):
        # There were none, which is why one granted busy loop could take the
        # site down on a two-core box. The per-slot `ulimit -t` bounds one
        # command; this bounds the service.
        for service in ('app', 'search', 'workbench', 'caddy'):
            with self.subTest(service=service):
                self.assertRegex(
                    block(self.text, service),
                    r'\n    cpus: [0-9.]+',
                    f'{service} can take the whole box',
                )

    def test_the_box_is_not_oversubscribed(self):
        # 2 cores and 4GB. Leaving headroom for the host and the docker daemon
        # is the difference between "slow under load" and "the kernel picks
        # something to kill".
        cpus = sum(float(m) for m in re.findall(r'\n    cpus: ([0-9.]+)', self.text))
        memory = sum(int(m) for m in re.findall(r'\n    mem_limit: (\d+)m', self.text))
        self.assertLessEqual(cpus, 2.0, f'{cpus} CPUs allocated on a 2-core box')
        self.assertLessEqual(memory, 3328, f'{memory}MB allocated of 4096MB')

    def test_tmp_is_not_shared_between_accounts(self):
        self.assertRegex(self.workbench, r'/tmp:rw[^\n]*noexec[^\n]*nosuid')

    def test_the_pid_limit_leaves_room_for_the_pool(self):
        # 32 slots at `ulimit -u 96` each; the container limit is what stops the
        # pool as a whole, and it has to exceed one slot's share or a single
        # account hits the container limit first and takes everyone with it.
        limit = int(re.search(r'\n    pids_limit: (\d+)', self.workbench).group(1))
        self.assertGreater(limit, 96, 'one account would exhaust the container')


if __name__ == '__main__':
    unittest.main()

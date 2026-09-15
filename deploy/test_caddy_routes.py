"""What the proxy publishes to the internet.

`handle_path /ws/*` handed the *whole* workbench to the public hostname, not
just its terminal socket. The workbench serves `POST /runs` — the endpoint that
executes the assistant's shell commands — so `POST https://<domain>/ws/runs`
arrived at the workbench as `POST /runs`, and the only thing in front of it was
one shared bearer token. That token was, until the same change set, printed by
`env`, which the app auto-approved as a read-only command.

The browser needs exactly one thing from that service: the terminal WebSocket.
The app reaches `/runs` over the Compose network, which is not published at all.

`bash -n` and `caddy validate` both accept the wide form happily — it is
well-formed, it is just too generous — so the shape is asserted here.
"""

import re
import unittest
from pathlib import Path

CADDYFILE = Path(__file__).with_name('Caddyfile')
COMPOSE = Path(__file__).with_name('compose.yml')


class CaddyRouteTests(unittest.TestCase):
    def setUp(self):
        # Directives only. The comments in that file discuss the wrong forms by
        # name — deliberately, so the next person does not re-derive them — and a
        # naive substring search over the whole text would read the prose as
        # configuration.
        self.text = '\n'.join(
            line for line in CADDYFILE.read_text().splitlines() if not line.lstrip().startswith('#')
        )
        # Every path matcher the file routes to the workbench.
        self.workbench_routes = [
            matcher
            for matcher, body in re.findall(
                r'handle(?:_path)?\s+(\S+)\s*\{(.*?)\n  \}', self.text, re.S
            )
            if 'workbench' in body
        ]

    def test_the_workbench_is_reachable_only_at_its_terminal(self):
        self.assertTrue(self.workbench_routes, 'no workbench route found at all')
        for matcher in self.workbench_routes:
            with self.subTest(matcher=matcher):
                self.assertTrue(
                    matcher.startswith('/ws/terminal'),
                    f'{matcher} publishes more of the workbench than the terminal socket',
                )

    def test_the_command_api_is_not_published(self):
        # The concrete request this is about. A matcher only reaches /runs if a
        # URL beginning /ws/runs matches it.
        for matcher in self.workbench_routes:
            prefix = matcher.rstrip('*')
            self.assertFalse(
                '/ws/runs'.startswith(prefix),
                f'POST https://<domain>/ws/runs still reaches the workbench through {matcher}',
            )

    def test_the_terminal_itself_still_works(self):
        # The fix must not cost the feature. The app builds this exact URL in
        # lib/workbench/ticket.ts, and the workbench accepts both spellings.
        self.assertTrue(
            any('/ws/terminal'.startswith(m.rstrip('*')) for m in self.workbench_routes),
            'the terminal socket is no longer routed anywhere',
        )

    def test_the_terminal_route_does_not_strip_its_own_path_away(self):
        # The trap this route has fallen into twice. `handle_path` strips the
        # MATCHED prefix, so narrowing it to /ws/terminal* also starts stripping
        # /ws/terminal — and the workbench is handed "/", which it rejects.
        # Measured against caddy 2.8.4:
        #
        #   handle_path /ws/*          /ws/terminal -> /terminal      /ws/runs -> /runs
        #   handle_path /ws/terminal*  /ws/terminal -> /              /ws/runs -> the app
        #   handle      /ws/terminal*  /ws/terminal -> /ws/terminal   /ws/runs -> the app
        #
        # Only the third row is both narrow and working, and it works because
        # workbench/src/server.ts accepts /ws/terminal as well as /terminal.
        self.assertNotIn(
            'handle_path /ws/terminal',
            self.text,
            'handle_path would strip /ws/terminal and hand the workbench "/", breaking the terminal',
        )
        self.assertIn('handle /ws/terminal', self.text)

    def test_the_workbench_port_is_not_published_directly(self):
        # Belt and braces: narrowing the proxy is pointless if the container
        # publishes 3001 to the host itself.
        compose = COMPOSE.read_text()
        workbench = compose[compose.index('  workbench:') :]
        workbench = workbench[: workbench.index('\n  caddy:')]
        self.assertNotIn('ports:', workbench, 'the workbench publishes a port of its own')


if __name__ == '__main__':
    unittest.main()

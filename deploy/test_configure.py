import unittest, json, sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import os
from configure import main
from configure import validate

class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.config={'domain':'chat.example.com','owner_email':'owner@example.com','session_secret':'a'*64,'owner_password':'test-only-password'}
    def test_valid(self):
        self.assertEqual(validate(self.config)[0],'chat.example.com')
        self.assertEqual(validate(self.config|{'domain':'Chat.Example.COM'})[0],'chat.example.com')
    def test_no_shell_or_dotenv_injection(self):
        for field,value in [('domain','example.com;reboot'),('domain','https://example.com'),('domain','evil\nOTHER=value'),('owner_email','a@b.com\nADMIN=true'),('session_secret','$(anything)'*8),('owner_password','bad\npassword')]:
            with self.subTest(field=field,value=value):
                with self.assertRaises(ValueError): validate(self.config|{field:value})
    def test_initial_password_must_be_strong_enough(self):
        with self.assertRaises(ValueError):validate(self.config|{'owner_password':'short'})
    def test_password_optional_after_bootstrap(self):
        self.assertEqual(validate(self.config|{'owner_password':''})[3],'')

    def test_releases_preserve_vault_key_when_session_secret_changes(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            # A later release, so this deployment has already created its owner.
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\nBETTER_AUTH_SECRET='+('b'*64)+'\nHIKMAH_RUNTIME_TOKEN=fixture-runtime-token\n')
            for session_secret in ['c'*64,'d'*64]:
                incoming=root/'incoming.json'
                incoming.write_text(json.dumps(self.config|{'owner_password':'','session_secret':session_secret}))
                with patch('configure.Path',side_effect=lambda path: root if path=='/opt/hikmah' else Path(path)), patch.object(sys,'argv',['configure.py',str(incoming)]):main()
                values=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines())
                self.assertEqual(values['HIKMAH_VAULT_KEY'],'b'*64)
                self.assertEqual(values['BETTER_AUTH_SECRET'],session_secret)
                self.assertEqual(values['HIKMAH_RUNTIME_TOKEN'],'fixture-runtime-token')
                self.assertEqual(len(values['HIKMAH_SEARCH_SECRET']),64)
                self.assertEqual(len(values['HIKMAH_WORKBENCH_TOKEN']),64)
                self.assertFalse(incoming.exists())

    def test_workbench_token_survives_releases(self):
        # Rotating it would invalidate every open terminal and every ticket in
        # flight, so a release must carry the existing one forward.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\nBETTER_AUTH_SECRET='+('b'*64)+'\nHIKMAH_WORKBENCH_TOKEN=fixture-workbench-token\n')
            incoming=root/'incoming.json'
            incoming.write_text(json.dumps(self.config|{'owner_password':''}))
            with patch('configure.Path',side_effect=lambda path: root if path=='/opt/hikmah' else Path(path)), patch.object(sys,'argv',['configure.py',str(incoming)]):main()
            values=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines())
            self.assertEqual(values['HIKMAH_WORKBENCH_TOKEN'],'fixture-workbench-token')

    # --- what the release owns, and what belongs to the server ----------------
    #
    # configure.py used to rewrite .env from a four-key base plus an eight-name
    # preserve list, so every variable an operator set by hand was deleted on the
    # next release. That made the whole commerce layer unreachable in production:
    # no STRIPE_*, so the plugin never loads and the Pro plan cannot be bought; no
    # RESEND_API_KEY, so password reset is never registered and a customer who
    # forgets is locked out; no HIKMAH_PROVIDER_KEY, so a managed run is refused;
    # no HIKMAH_PRIVATE, so registration cannot be closed. Nothing caught it
    # because every test named a variable that was already on the list.

    def release(self, root, **overrides):
        """Run one release against a temporary /opt/hikmah.

        os.chown is patched out: on a server this runs as root and the bootstrap
        password must end up owned by the container user, but a CI runner is not
        root and this suite is about what lands in .env, not about file
        ownership. Leaving it unpatched failed only on the runner."""
        incoming = root/'incoming.json'
        incoming.write_text(json.dumps(self.config | {'owner_password': ''} | overrides))
        with patch('configure.Path', side_effect=lambda path: root if path=='/opt/hikmah' else Path(path)), \
             patch.object(os,'chown',lambda *a, **k: None), \
             patch.object(sys,'argv',['configure.py',str(incoming)]): main()
        return (root/'.env').read_text()

    def values(self, root):
        return dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line)

    def test_an_unmanaged_variable_survives_a_release(self):
        # The regression. HIKMAH_INVENTED_LATER is the one that matters: a name
        # nobody has heard of has to survive, or the next variable added is
        # dropped exactly like these four were.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir()
            (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text(
                'HIKMAH_OWNER_EMAIL=owner@example.com\nBETTER_AUTH_SECRET='+('b'*64)+'\n'
                'STRIPE_SECRET_KEY=sk_test_fixture\nSTRIPE_WEBHOOK_SECRET=whsec_fixture\n'
                'RESEND_API_KEY=re_fixture\nHIKMAH_PRIVATE=1\n'
                'HIKMAH_PROVIDER_KEY=sk-or-fixture\nHIKMAH_INVENTED_LATER=42\n')
            self.release(root)
            values=self.values(root)
            for name,expected in [('STRIPE_SECRET_KEY','sk_test_fixture'),
                                  ('STRIPE_WEBHOOK_SECRET','whsec_fixture'),
                                  ('RESEND_API_KEY','re_fixture'),
                                  ('HIKMAH_PRIVATE','1'),
                                  ('HIKMAH_PROVIDER_KEY','sk-or-fixture'),
                                  ('HIKMAH_INVENTED_LATER','42')]:
                self.assertEqual(values.get(name),expected,name)

    def test_an_operator_can_create_env_before_the_first_deploy(self):
        # `current.get('HIKMAH_OWNER_EMAIL') != email` is None != email for a
        # pre-seeded file with no owner line, so this raised "Owner email
        # differs" — and the elif that demands a first-deployment password never
        # ran. There was no way to set a commerce secret before the first deploy
        # either.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir()
            (root/'.env').write_text('STRIPE_SECRET_KEY=sk_test_x\n')
            self.release(root, owner_password='test-only-password')
            values=self.values(root)
            self.assertEqual(values['HIKMAH_OWNER_EMAIL'],'owner@example.com')
            self.assertEqual(values['STRIPE_SECRET_KEY'],'sk_test_x')
            self.assertTrue((root/'data'/'bootstrap-owner-password').exists())

    def test_first_deployment_still_requires_a_password_even_with_a_seeded_env(self):
        # What stops the fix above from weakening the guard: the question is
        # whether this deployment has ever run, which is the auth database, not
        # whether a config file happens to exist.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\n')
            with self.assertRaisesRegex(ValueError,'HIKMAH_OWNER_PASSWORD'):
                self.release(root)

    def test_a_deployment_with_a_different_owner_is_still_refused_and_nothing_is_written(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            before='HIKMAH_OWNER_EMAIL=someone-else@example.com\nSTRIPE_SECRET_KEY=sk_test_x\n'
            (root/'.env').write_text(before)
            with self.assertRaisesRegex(ValueError,'Transfer ownership'):
                self.release(root)
            self.assertEqual((root/'.env').read_text(),before)

    def test_the_release_owns_its_four_keys_and_writes_each_once(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\n'
                                     'HIKMAH_DOMAIN=old.example.com\n'
                                     'BETTER_AUTH_URL=https://old.example.com\n'
                                     'BETTER_AUTH_SECRET='+('z'*64)+'\n')
            text=self.release(root)
            values=self.values(root)
            self.assertEqual(values['HIKMAH_DOMAIN'],'chat.example.com')
            self.assertEqual(values['BETTER_AUTH_URL'],'https://chat.example.com')
            self.assertEqual(values['BETTER_AUTH_SECRET'],'a'*64)
            for key in ('HIKMAH_DOMAIN','BETTER_AUTH_URL','HIKMAH_OWNER_EMAIL','BETTER_AUTH_SECRET'):
                self.assertEqual(len([l for l in text.splitlines() if l.startswith(key+'=')]),1,key)

    def test_a_second_release_writes_the_same_file(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\nZED=1\nALPHA=2\n')
            self.assertEqual(self.release(root),self.release(root))

    def test_lines_that_are_not_key_value_are_dropped_not_carried(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\n'
                                     '# a comment\n\nexport FOO=1\nnot a line at all\n'
                                     ' LEADING=x\n9BAD=x\nBELL=a\x07b\nGOOD=1\n')
            text=self.release(root)
            self.assertEqual(self.values(root).get('GOOD'),'1')
            for bad in ('# a comment','export FOO','not a line at all','9BAD'):
                self.assertNotIn(bad,text)
            # Normalised, not dropped: compose's dotenv parser strips this too.
            self.assertEqual(self.values(root).get('LEADING'),'x')
            # A control character in a value is refused rather than written into
            # a file the next release parses line by line.
            self.assertNotIn('\x07',text)

    def test_a_value_is_carried_verbatim(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\n'
                                     'HIKMAH_MAIL_FROM=Hikmah <hello@x.example>\n'
                                     'STRIPE_WEBHOOK_SECRET=whsec_a=b=c\n'
                                     'X_QUOTED="a b"\nX_DOLLAR=$notinterpolated\n')
            self.release(root)
            values=self.values(root)
            self.assertEqual(values['HIKMAH_MAIL_FROM'],'Hikmah <hello@x.example>')
            self.assertEqual(values['STRIPE_WEBHOOK_SECRET'],'whsec_a=b=c')
            self.assertEqual(values['X_QUOTED'],'"a b"')
            self.assertEqual(values['X_DOLLAR'],'$notinterpolated')

    def test_an_explicit_vault_key_is_never_re_keyed(self):
        # The highest-consequence line in the file. HIKMAH_VAULT_KEY must be
        # decided against the OLD BETTER_AUTH_SECRET, before the new one is
        # merged in: re-keying makes every saved provider key undecryptable, with
        # no error at deploy time.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\n'
                                     'BETTER_AUTH_SECRET='+('b'*64)+'\n'
                                     'HIKMAH_VAULT_KEY='+('v'*64)+'\n')
            for session_secret in ['c'*64,'d'*64]:
                self.release(root, session_secret=session_secret)
                self.assertEqual(self.values(root)['HIKMAH_VAULT_KEY'],'v'*64)

    def test_an_empty_generated_secret_is_replaced(self):
        # Present-but-empty survived setdefault, and compose then refuses the
        # release at ${HIKMAH_SEARCH_SECRET:?...}, which errors on empty too.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\nHIKMAH_SEARCH_SECRET=\n')
            self.release(root)
            self.assertEqual(len(self.values(root)['HIKMAH_SEARCH_SECRET']),64)

    def test_the_env_file_stays_private(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir(); (root/'data'/'auth.sqlite').touch()
            (root/'.env').write_text('HIKMAH_OWNER_EMAIL=owner@example.com\n')
            self.release(root)
            self.assertEqual(oct((root/'.env').stat().st_mode)[-3:],'600')

    def test_a_non_root_release_says_so_instead_of_raising_an_errno(self):
        # Unpatched, this is what the CI runner hit: a bare PermissionError
        # naming a temp path, which tells an operator nothing.
        with TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'data').mkdir()
            incoming=root/'incoming.json'
            incoming.write_text(json.dumps(self.config))
            def refuse(*a, **k): raise PermissionError(1, 'Operation not permitted')
            with patch('configure.Path', side_effect=lambda path: root if path=='/opt/hikmah' else Path(path)), \
                 patch.object(os,'chown',refuse), \
                 patch.object(sys,'argv',['configure.py',str(incoming)]):
                with self.assertRaisesRegex(ValueError,'must run as root'): main()

if __name__=='__main__':unittest.main()
import unittest, json, sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
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
                self.assertFalse(incoming.exists())

if __name__=='__main__':unittest.main()

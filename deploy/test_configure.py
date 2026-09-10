import unittest
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

if __name__=='__main__':unittest.main()

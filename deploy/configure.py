#!/usr/bin/env python3
"""Validate an incoming private config without printing its contents."""
import json, os, re, sys, secrets
from pathlib import Path

def validate(config):
    domain = config.get('domain', '').lower()
    email = config.get('owner_email', '').lower()
    secret = config.get('session_secret', '')
    password = config.get('owner_password', '')
    if not re.fullmatch(r'(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}', domain):
        raise ValueError('Set HIKMAH_DOMAIN to a DNS hostname, without a protocol, port or path.')
    if not re.fullmatch(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,63}', email):
        raise ValueError('Set HIKMAH_OWNER_EMAIL to a valid email address.')
    if not re.fullmatch(r'[a-zA-Z0-9_\-]{43,128}', secret):
        raise ValueError('Set HIKMAH_SESSION_SECRET to at least 43 random hex or base64url characters.')
    if password and (not 12 <= len(password) <= 128 or '\n' in password or '\r' in password):
        raise ValueError('The initial owner password must contain 12–128 characters and no newlines.')
    return domain, email, secret, password

def main():
    os.umask(0o077)
    incoming = Path(sys.argv[1])
    try:
        domain, email, secret, password = validate(json.loads(incoming.read_text()))
        root = Path('/opt/hikmah')
        env = root / '.env'
        current = {}
        if env.exists():
            current = dict(line.split('=',1) for line in env.read_text().splitlines() if '=' in line)
            if current.get('HIKMAH_OWNER_EMAIL') != email:
                raise ValueError('Owner email differs from this deployment. Transfer ownership explicitly before changing it.')
        elif not password:
            raise ValueError('First deployment requires HIKMAH_OWNER_PASSWORD.')
        content = f'HIKMAH_DOMAIN={domain}\nBETTER_AUTH_URL=https://{domain}\nHIKMAH_OWNER_EMAIL={email}\nBETTER_AUTH_SECRET={secret}\n'
        # Runtime credentials stay on the server and survive subsequent releases.
        current.setdefault('HIKMAH_SEARCH_SECRET', secrets.token_hex(32))
        for key in ('HIKMAH_SEARCH_SECRET', 'HIKMAH_SEARCH_IMAGE', 'HIKMAH_SEARCH_URL', 'HIKMAH_RUNTIME_URL', 'HIKMAH_RUNTIME_TOKEN', 'BRAVE_SEARCH_API_KEY'):
            if current.get(key):
                content += f'{key}={current[key]}\n'
        temp = root / '.env.new'
        temp.write_text(content)
        temp.replace(env)
        if password and not (root/'data'/'auth.sqlite').exists():
            path = root/'data'/'bootstrap-owner-password'
            path.write_text(password)
            os.chown(path, 1000, 1000)
    finally:
        incoming.unlink(missing_ok=True)

if __name__ == '__main__':
    try: main()
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)

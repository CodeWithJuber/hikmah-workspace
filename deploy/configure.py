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

# The four the release decides, from config.json. Anything already in .env under
# these names is replaced, never merged: they are the deployment's identity.
MANAGED = ('HIKMAH_DOMAIN', 'BETTER_AUTH_URL', 'HIKMAH_OWNER_EMAIL', 'BETTER_AUTH_SECRET')
# The three the server owns. Generated once and carried forward for ever after.
GENERATED = ('HIKMAH_VAULT_KEY', 'HIKMAH_SEARCH_SECRET', 'HIKMAH_WORKBENCH_TOKEN')
# A POSIX environment name. Also, usefully, what rejects a comment, an `export`
# prefix and a leading digit without needing a rule for each.
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,127}')
CONTROL = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')

def read_env(path):
    """Every KEY=VALUE line in an existing .env, and the numbers of the lines that were not.

    Preserve by default, because the previous version did the opposite: it
    rebuilt the file from a fixed allowlist, so every variable an operator set
    by hand was deleted on the next release. That is why no Stripe, Resend,
    Google or provider key could ever be configured on a deployed server — and
    why the next variable added would have gone the same way. The release owns
    the seven names above; everything else in this file belongs to whoever runs
    the box.
    """
    if not path.exists():
        return {}, []
    values, dropped = {}, []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.lstrip('\ufeff') if number == 1 else line
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        # Verbatim on the right of the first '=': a value may contain '=', and
        # quoting is compose's dotenv parser to interpret, not ours to strip.
        # `not X != Y` parses correctly but reads wrong; spelled out instead.
        # Tab is deliberately allowed, every other C0 control is not.
        if separator and NAME.fullmatch(key.strip()) and CONTROL.sub('', value) == value \
                and len(value) <= 8192:
            # Leading space on the key is normalised rather than dropped, which
            # is what compose's own dotenv parser does with it.
            values[key.strip()] = value
        else:
            dropped.append(number)
    return values, dropped

def main():
    os.umask(0o077)
    incoming = Path(sys.argv[1])
    try:
        domain, email, secret, password = validate(json.loads(incoming.read_text()))
        root = Path('/opt/hikmah')
        env = root / '.env'
        current, dropped = read_env(env)
        recorded = current.get('HIKMAH_OWNER_EMAIL')
        # Only a *different* recorded owner is a transfer. An absent line records
        # no claim, which is what an operator pre-seeding .env before the first
        # deploy leaves behind — and what used to raise this error, because
        # None != email.
        if recorded is not None and recorded != email:
            raise ValueError('Owner email differs from this deployment. Transfer ownership explicitly before changing it.')
        # Whether this deployment has ever run is the auth database, not the
        # presence of a config file: a restore that brought .env back without
        # data/ would otherwise come up with no owner account and no way in.
        if not password and not (root/'data'/'auth.sqlite').exists():
            raise ValueError('First deployment requires HIKMAH_OWNER_PASSWORD.')
        # Both raises are above every write, so a refused release leaves .env
        # exactly as it was.

        # Decided against the OLD BETTER_AUTH_SECRET, before the new one below
        # replaces it. Getting this order wrong re-keys the vault, and every
        # saved provider key becomes undecryptable with no error at deploy time.
        vault = current.get('HIKMAH_VAULT_KEY') or current.get('BETTER_AUTH_SECRET') or secret
        # Truthiness rather than setdefault: a present-but-empty line survived,
        # and compose then refuses the release at ${HIKMAH_SEARCH_SECRET:?...},
        # which errors on empty as well as unset.
        generated = {
            'HIKMAH_VAULT_KEY': vault,
            'HIKMAH_SEARCH_SECRET': current.get('HIKMAH_SEARCH_SECRET') or secrets.token_hex(32),
            # Signs the workbench's single-use terminal tickets and authenticates
            # the app to it. Rotating it on a release would end every open
            # terminal.
            'HIKMAH_WORKBENCH_TOKEN': current.get('HIKMAH_WORKBENCH_TOKEN') or secrets.token_hex(32),
        }
        managed = {
            'HIKMAH_DOMAIN': domain,
            'BETTER_AUTH_URL': f'https://{domain}',
            'HIKMAH_OWNER_EMAIL': email,
            'BETTER_AUTH_SECRET': secret,
        }
        # Three deterministic blocks, so two releases with the same inputs write
        # the same bytes and the head of the file stays where an operator expects.
        rest = {k: v for k, v in current.items() if k not in MANAGED and k not in GENERATED}
        content = ''.join(f'{k}={v}\n' for k, v in managed.items())
        content += ''.join(f'{k}={generated[k]}\n' for k in GENERATED)
        content += ''.join(f'{k}={rest[k]}\n' for k in sorted(rest))

        temp = root / '.env.new'
        temp.write_text(content)
        temp.replace(env)
        # By line number only. The docstring promises not to print the contents,
        # and a stray line is a typo to point at rather than a reason to fail the
        # release.
        if dropped:
            print('Lines %s of %s are not KEY=VALUE and were not carried forward.'
                  % (', '.join(map(str, dropped)), env), file=sys.stderr)
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

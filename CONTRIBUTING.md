# Contributing to Hikmah Workspace

Thank you for helping. This page covers setting up, the checks a change must pass, and the Contributor License Agreement.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach before you write the code.
- Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node 24.15 or newer in the Node 24 line, npm, Python 3 and, for the image and smoke tests, Docker.

```bash
npm ci --ignore-scripts
cp .env.example .env.local
```

Fill in `.env.local` as the [README](README.md#quick-start) describes, then:

```bash
npm run setup
npm run dev
```

The workbench (terminal, SSH and sandboxed commands) is a separate package:

```bash
cd workbench
npm ci --ignore-scripts
```

Never commit `.env.local`, `.data/`, keys, real customer data or real personal details. Tests use synthetic values such as `example.com` hosts and `+971 50 000 0001`.

## Checks

CI runs these on every pull request. Run the ones your change touches before you push:

```bash
npm run format:check   # npm run format fixes it
npm run lint
npm run lint:styles
npm run design:check
npm run lint:reach
npm run typecheck
npm test
python3 -m unittest discover -s public/runtime -p 'test_*.py'
python3 -m unittest discover -s deploy -p 'test_*.py'
(cd workbench && npm run typecheck && npm test)
npm run build && npm run test:production
```

[docs/verification.md](docs/verification.md) explains what each gate checks. A change that alters what the app does needs a test that fails without it.

## Licensing of files

The project is `AGPL-3.0-only`. [REUSE.toml](REUSE.toml) records the licence of every file, and CI runs `reuse lint`.

- New files of your own need nothing: they fall under the project licence.
- If you add third-party code or data, add its licence text under `LICENSES/` (`reuse download <SPDX-ID>`), an entry in `REUSE.toml`, and its attribution in [NOTICE](NOTICE). Only add material whose licence allows commercial use and redistribution; data under a non-commercial or unstated licence must be fetched at build or run time from its original source instead.

## Commits and pull requests

- Keep each pull request to one change, and each commit small, with a short imperative subject ("Fix login redirect loop").
- Fill in the pull request template, including how you tested the change.
- Do not change unrelated code, formatting or dependencies in the same pull request.

## Contributor License Agreement

Before we can merge your first pull request you sign the [Contributor License Agreement](CLA.md) (CLA). You sign it once and it covers all your later contributions.

When you open a pull request, the CLA bot checks whether you have signed. If you have not, it comments with a link to the CLA. Read it, and if you agree, reply on the pull request with exactly:

```text
I have read the CLA Document and I hereby sign the CLA
```

The bot records your GitHub username, the pull request and the time in the `cla-signatures` branch of this repository. To make the bot check again, comment `recheck`.

The CLA lets the maintainer relicense the project, for example to offer it under other terms alongside the AGPL. You keep the copyright in your contribution. If you contribute on behalf of an employer, make sure you are allowed to sign; the CLA explains what you confirm.

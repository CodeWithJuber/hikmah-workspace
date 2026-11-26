# Security policy

## Supported versions

Security fixes go into the `main` branch and the latest release. Older releases do not receive fixes; update to the latest one.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues, discussions or pull requests.

Report them privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (or go straight to [the advisory form](https://github.com/CodeWithJuber/hikmah-workspace/security/advisories/new)).
3. Describe the problem, the affected version or commit, the steps to reproduce it, and the impact you expect.

Only the maintainer can see the report. GitHub's documentation explains [how private vulnerability reporting works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

## What happens next

The maintainer aims to acknowledge a report within 7 days and to keep you updated while a fix is prepared. Once a fix is released, the advisory is published with credit to you, unless you ask not to be named. Please keep the details private until then.

## Scope

In scope: the code in this repository, including the web app, the workbench service, the deployment scripts and the GitHub Actions workflows.

Out of scope: vulnerabilities in third-party dependencies that are already public (report those upstream; Dependabot tracks them here), issues in a deployment you do not run, and findings that need a compromised server or administrator account to begin with.

When testing, use your own installation. Do not access other people's data, degrade a service others rely on, or run automated scanners against servers you do not own.

# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- The project is open source under the GNU Affero General Public License v3 (`AGPL-3.0-only`), with `REUSE.toml` and `LICENSES/` recording the licence of every file and `NOTICE` listing third-party attributions.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, an individual Contributor License Agreement (`CLA.md`) and a CLA check on pull requests.
- Issue and pull request templates, `CODEOWNERS` and Dependabot updates for npm and GitHub Actions.
- CI checks for dependency review, secret scanning with gitleaks, `reuse lint` and the OpenSSF Scorecard.

### Changed

- CI and deployment run on GitHub-hosted runners. The deploy workflow uses an SSH key only; password login is no longer supported.
- `npm run dev` builds the browser sandbox worker first.

### Removed

- Build output and internal notes that do not belong in a public repository.
- The script that installed a self-hosted Actions runner on the production server.

## 9.1.0 - 2026-09-10

Self-hosted v9.1 release candidate, ported from the v9 app to Node.js. Changes before this changelog are in the git history. No release tag exists for it yet.

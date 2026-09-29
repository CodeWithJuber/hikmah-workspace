#!/usr/bin/env node
// CI isolation gate for the GitHub Actions workflows.
//
// Trust model:
//   - .github/workflows/ci.yml runs PR-supplied code (pull_request trigger) and
//     must never see production credentials.
//   - .github/workflows/deploy.yml is always read from the default branch
//     (workflow_run trigger), so PR edits to workflow files can never touch
//     it. It is the only workflow allowed near production secrets, behind the
//     protected `production` environment, and it deploys the exact SHA that
//     ci.yml verified (provenance record + pinned checkout ref).
//
// Usage: node scripts/check-workflow-isolation.mjs [--dir .github/workflows]
// Exits 0 when every assertion holds, 1 with the violations printed otherwise.
//
// NOTE on js-yaml: it is a transitive dependency (@eslint/eslintrc) pinned in
// package-lock.json, so `npm ci` always installs it. Requiring it directly
// keeps this script dependency-free without touching package.json (which would
// desync the lockfile).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(HERE, '..', '.github', 'workflows');

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
// GITHUB_TOKEN is minted per run and is not a production credential.
const SECRET_RE = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g;
const PINNED_ACTION_RE = /^[^\s@]+@[0-9a-f]{40}$/;

// js-yaml parses the bare key `on` as boolean true (YAML 1.1).
const triggersOf = (doc) => doc['on'] ?? doc[true];

const eventNames = (on) => {
  if (!on) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
};

const collectUses = (node, out) => {
  if (Array.isArray(node)) {
    for (const v of node) collectUses(v, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'uses' && typeof v === 'string') out.push(v);
      else collectUses(v, out);
    }
  }
  return out;
};

const productionSecretsOf = (job) => {
  const names = new Set();
  for (const m of JSON.stringify(job).matchAll(SECRET_RE)) {
    if (m[1] !== 'GITHUB_TOKEN') names.add(m[1]);
  }
  return [...names];
};

const checkoutSteps = (job) => {
  const steps = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.uses === 'string' && node.uses.startsWith('actions/checkout@'))
        steps.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(job.steps ?? []);
  return steps;
};

/**
 * Parse every workflow file in dir and assert the CI/deploy trust boundary.
 * Returns an array of violation messages (empty = all green).
 */
export function checkWorkflows(dir = DEFAULT_DIR) {
  const failures = [];
  const fail = (file, msg) => failures.push(`${file}: ${msg}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (files.length === 0) failures.push(`${dir}: no workflow files found`);

  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    let doc;
    try {
      doc = yaml.load(text);
    } catch (err) {
      fail(file, `invalid YAML: ${err.message}`);
      continue;
    }
    if (!doc || typeof doc !== 'object') {
      fail(file, 'empty workflow document');
      continue;
    }
    const on = triggersOf(doc);
    if (!on) {
      fail(file, 'missing `on:` trigger block');
      continue;
    }
    const events = eventNames(on);
    const jobs = doc.jobs ?? {};

    // Every third-party action must be SHA-pinned (repo convention: a tag can
    // be moved; a SHA cannot).
    for (const uses of collectUses(doc, [])) {
      if (!PINNED_ACTION_RE.test(uses) && !uses.startsWith('./') && !uses.startsWith('docker://')) {
        fail(file, `unpinned action reference: ${uses}`);
      }
    }

    let hasSecretJob = false;
    for (const [jobId, job] of Object.entries(jobs)) {
      const secrets = productionSecretsOf(job);
      if (secrets.length === 0) continue;
      hasSecretJob = true;
      const label = `job '${jobId}' uses production secrets (${secrets.join(', ')})`;
      if (events.some((e) => PR_EVENTS.has(e))) {
        fail(file, `${label} but the workflow triggers on pull_request — PR code could read them`);
      }
      if (!job.environment) {
        fail(file, `${label} without a protected 'environment:'`);
      }
    }

    if (hasSecretJob) {
      // ---- deploy workflow: the trusted side ----
      if (!events.includes('workflow_run')) {
        fail(
          file,
          'deploy workflow is not triggered by workflow_run (its definition must come from the default branch, never from PR code)',
        );
      }
      const runCfg = on?.workflow_run;
      const branches = runCfg?.branches ?? [];
      if (!branches.includes('main')) {
        fail(file, 'deploy workflow_run trigger is not restricted to branches: [main]');
      }
      if (!doc.concurrency) {
        fail(
          file,
          'deploy workflow has no top-level concurrency group — overlapping deploys could race',
        );
      }
      if (!text.includes('workflow_run.head_sha')) {
        fail(
          file,
          'deploy workflow never references workflow_run.head_sha — the deployed SHA is not pinned to the verified commit',
        );
      }
      if (!/provenance/i.test(text)) {
        fail(
          file,
          'deploy workflow has no provenance check — nothing confirms the artifact is the verified SHA at deploy time',
        );
      }
      for (const [jobId, job] of Object.entries(jobs)) {
        for (const step of checkoutSteps(job)) {
          if (!step.with?.ref) {
            fail(
              file,
              `job '${jobId}' checks out without a pinned ref — a re-checkout could differ from the verified SHA`,
            );
          }
        }
      }
    } else {
      // ---- CI workflow: the untrusted side ----
      const stray = new Set();
      for (const m of text.matchAll(SECRET_RE)) {
        if (m[1] !== 'GITHUB_TOKEN') stray.add(m[1]);
      }
      if (stray.size > 0) {
        fail(
          file,
          `production secrets referenced in the untrusted CI workflow: ${[...stray].join(', ')}`,
        );
      }
      if (!text.includes('provenance.json')) {
        fail(
          file,
          'CI workflow does not record artifact provenance (provenance.json) for the deploy step to confirm',
        );
      }
    }
  }
  return failures;
}

const main = () => {
  const dirIdx = process.argv.indexOf('--dir');
  const dir = dirIdx === -1 ? DEFAULT_DIR : resolve(process.argv[dirIdx + 1]);
  const failures = checkWorkflows(dir);
  if (failures.length > 0) {
    console.error(
      `CI isolation check FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log('CI isolation check passed.');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

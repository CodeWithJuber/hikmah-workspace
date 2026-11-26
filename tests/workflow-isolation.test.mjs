import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflows } from '../scripts/check-workflow-isolation.mjs';

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

test('CI isolation: the deploy trust boundary holds in every workflow file', () => {
  // PR-05: ci.yml runs PR-supplied code and must never see production
  // credentials; deploy.yml (workflow_run, default branch only) is the only
  // workflow that may touch them, behind the protected production environment,
  // deploying the exact SHA ci.yml verified.
  const failures = checkWorkflows(workflowsDir);
  assert.deepEqual(
    failures,
    [],
    `workflow isolation violations:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
  );
});

// Public-repository rules, checked against throwaway workflow files.
const workflowsWith = (yaml) => {
  const dir = mkdtempSync(join(tmpdir(), 'hikmah-workflows-'));
  writeFileSync(join(dir, 'check.yml'), yaml);
  return dir;
};

const job = (runsOn, steps = '      - run: echo ok\n') =>
  `on: pull_request\njobs:\n  check:\n    runs-on: ${runsOn}\n    steps:\n${steps}`;

test('public repo: standard GitHub-hosted runners pass', (t) => {
  const dir = workflowsWith(job('ubuntu-24.04'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(checkWorkflows(dir), []);
});

test('public repo: self-hosted, larger and grouped runners fail', (t) => {
  for (const runsOn of [
    '[self-hosted, linux, x64]',
    'self-hosted',
    'ubuntu-24.04-16core',
    '{ group: big-runners }',
    '${{ matrix.os }}',
  ]) {
    const dir = workflowsWith(job(runsOn));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const failures = checkWorkflows(dir);
    assert.equal(failures.length, 1, `${runsOn}: ${failures.join('; ')}`);
    assert.match(failures[0], /not a standard GitHub-hosted runner/);
  }
});

test('public repo: pull_request_target may not check out or fetch PR code', (t) => {
  const checkout =
    '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n' +
    '        with: { ref: "${{ github.event.pull_request.head.sha }}" }\n';
  const fetch = '      - run: git fetch origin "refs/pull/1/head"\n';
  for (const steps of [checkout, fetch]) {
    const dir = workflowsWith(
      job('ubuntu-24.04', steps).replace('on: pull_request', 'on: pull_request_target'),
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const failures = checkWorkflows(dir);
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /pull request code in a pull_request_target workflow/);
  }
  const safe = workflowsWith(
    job('ubuntu-24.04').replace('on: pull_request', 'on: pull_request_target'),
  );
  t.after(() => rmSync(safe, { recursive: true, force: true }));
  assert.deepEqual(checkWorkflows(safe), []);
});

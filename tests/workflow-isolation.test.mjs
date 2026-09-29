import test from 'node:test';
import assert from 'node:assert/strict';
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

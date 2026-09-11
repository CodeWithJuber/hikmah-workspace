// Whether ssh_exec is offered at all depends on whether this deployment has a
// workbench. Getting that wrong means a tool that fails on every call, which
// reads to the model as a transient error worth retrying.
// Run: node --test tests/ssh-run-context.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchConfig, WorkbenchUnavailable } from '../lib/ssh/client.ts';

test('a deployment without a workbench has no SSH configuration to build on', () => {
  // sshRunContext keys off exactly this, so it is what the test pins down;
  // importing the context module itself would open the workspace database.
  assert.throws(() => workbenchConfig({}), WorkbenchUnavailable);
  assert.throws(
    () => workbenchConfig({ HIKMAH_WORKBENCH_URL: 'http://workbench:3001' }),
    WorkbenchUnavailable,
    'a URL without a token is not a working workbench',
  );
  assert.throws(
    () => workbenchConfig({ HIKMAH_WORKBENCH_TOKEN: 'w'.repeat(48) }),
    WorkbenchUnavailable,
    'a token without a URL is not one either',
  );
});

test('a configured deployment resolves both halves', () => {
  const resolved = workbenchConfig({
    HIKMAH_WORKBENCH_URL: 'http://workbench:3001',
    HIKMAH_WORKBENCH_TOKEN: 'w'.repeat(48),
  });
  assert.deepEqual(resolved, { url: 'http://workbench:3001', token: 'w'.repeat(48) });
});

/** Explicit fixture master for tests that persist provider-backed runs. */
import { before, after } from 'node:test';
const previous = process.env.HIKMAH_VAULT_KEY;
before(() => { process.env.HIKMAH_VAULT_KEY = 'test-only-run-vault-master-'.padEnd(64, 'x'); });
after(() => {
  if (previous === undefined) delete process.env.HIKMAH_VAULT_KEY;
  else process.env.HIKMAH_VAULT_KEY = previous;
});

#!/usr/bin/env node
/**
 * Tests for scripts/smart-test-select.mjs.
 *
 * Run: node --test tests/smart-test-select.test.mjs
 *
 * These test the deterministic core (no LLM/JEV/forge needed). The AI layers
 * are optional enhancements — they degrade gracefully to null, and the tier
 * decision never depends on them for the clear cases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/smart-test-select.mjs');

function select(...files) {
  const out = execSync(`node ${script} ${files.map((f) => JSON.stringify(f)).join(' ')}`, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, SMART_TEST_SELECT_NO_OPTIONAL: '1' },
  });
  return JSON.parse(out);
}

describe('smart-test-select', () => {
  it('docs-only changes -> cosmetic tier', () => {
    const r = select('README.md', 'docs/guide.md');
    assert.equal(r.tier, 'cosmetic');
    assert.deepEqual(r.tests, []);
  });

  it('package.json -> high tier (full-suite trigger)', () => {
    const r = select('package.json');
    assert.equal(r.tier, 'high');
  });

  it('.github/ changes -> high tier', () => {
    const r = select('.github/workflows/release.yml');
    assert.equal(r.tier, 'high');
  });

  it('test-only changes -> low tier with those tests', () => {
    const r = select('tests/style-discipline.test.mjs');
    assert.equal(r.tier, 'low');
    assert.ok(r.tests.includes('tests/style-discipline.test.mjs'));
  });

  it('source change -> medium tier with impacted tests', () => {
    const r = select('components/chat/chat-view.tsx');
    assert.equal(r.tier, 'medium');
    assert.ok(Array.isArray(r.tests));
    // style-discipline scans components/ for icon sizes
    assert.ok(r.tests.includes('tests/style-discipline.test.mjs'));
  });

  it('no changed files -> high tier (fail-safe)', () => {
    const r = select();
    assert.equal(r.tier, 'high');
    assert.equal(r.reason, 'no changed files');
  });

  it('output has required fields', () => {
    const r = select('README.md');
    assert.ok(['cosmetic', 'low', 'medium', 'high'].includes(r.tier));
    assert.ok(Array.isArray(r.tests));
    assert.equal(typeof r.reason, 'string');
    assert.equal(typeof r.signals, 'object');
  });

  it('never outputs an empty test list for source changes without escalating', () => {
    // If tests is empty for a source change, tier must be high (fail-safe).
    const r = select('lib/nonexistent-fake-file.ts');
    if (r.tests.length === 0) {
      assert.equal(r.tier, 'high');
    }
  });
});
